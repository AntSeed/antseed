import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  Provider,
  ProviderStreamCallbacks,
  SerializedHttpRequest,
  SerializedHttpResponse,
} from '@antseed/node';
import { ANTSEED_STREAMING_RESPONSE_HEADER } from '@antseed/node';
import {
  AgentProvider,
  MiddlewareProvider,
  SkillRegistry,
  type ProviderMiddleware,
} from '@antseed/provider-core';
import { setupShutdownHandler } from '../shutdown.js';
import { buildPluginConfig, loadProviderPlugin } from '../../plugins/loader.js';
import { loadMiddlewareDirectory, loadMiddlewareFiles } from '../provider-files.js';
import type { MiddlewarePosition, SellerMiddlewareConfig } from '../../config/types.js';

const DEFAULT_PORT = 4020;
const DEFAULT_HOST = '127.0.0.1';

const DEBUG = () =>
  ['1', 'true', 'yes', 'on'].includes((process.env['ANTSEED_DEBUG'] ?? '').trim().toLowerCase());

function log(...args: unknown[]): void {
  if (DEBUG()) console.log('[serve-agent]', ...args);
}

function collectList(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

function isValidMiddlewarePosition(value: string): value is MiddlewarePosition {
  return value === 'system-prepend' || value === 'system-append' || value === 'prepend' || value === 'append';
}

function parseJsonObject(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function serializeRequest(req: IncomingMessage, body: Uint8Array): SerializedHttpRequest {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers[key] = value;
    } else if (Array.isArray(value)) {
      headers[key] = value.join(', ');
    }
  }
  delete headers.host;
  headers['content-length'] = String(body.length);

  return {
    requestId: randomUUID(),
    method: req.method ?? 'POST',
    path: req.url ?? '/',
    headers,
    body,
  };
}

function isStreamRequested(request: SerializedHttpRequest): boolean {
  const accept = request.headers.accept?.toLowerCase() ?? '';
  if (accept.includes('text/event-stream')) {
    return true;
  }
  return parseJsonObject(request.body)?.stream === true;
}

function toNodeHeaders(headers: Record<string, string>, bodyLength?: number): Record<string, string> {
  const next = { ...headers };
  delete next[ANTSEED_STREAMING_RESPONSE_HEADER];
  if (bodyLength === undefined) {
    delete next['content-length'];
  } else {
    next['content-length'] = String(bodyLength);
  }
  return next;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function writeBufferedResponse(res: ServerResponse, response: SerializedHttpResponse): void {
  res.writeHead(response.statusCode, toNodeHeaders(response.headers, response.body.length));
  res.end(Buffer.from(response.body));
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown): void {
  const body = encodeJson(value);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(body.length),
  });
  res.end(Buffer.from(body));
}

function buildOpenAIModelsResponse(provider: Provider): Uint8Array {
  return encodeJson({
    object: 'list',
    data: provider.services.map((service) => ({
      id: service,
      object: 'model',
      created: 0,
      owned_by: provider.name,
    })),
  });
}

async function readIncomingBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function buildProviderStack(options: {
  providerName: string;
  skillsDir?: string;
  middlewareFiles: string[];
  middlewareDirs: string[];
  middlewarePosition: MiddlewarePosition;
  middlewareRole?: string;
  middlewareServices: string[];
  middlewareConfidentialityPrompt?: string;
}): Promise<Provider> {
  const plugin = await loadProviderPlugin(options.providerName);
  const providerConfig = buildPluginConfig(plugin.configSchema ?? plugin.configKeys ?? [], {});
  let provider = await plugin.createProvider(providerConfig);
  if (provider.init) {
    await provider.init();
  }

  const middlewareServices = options.middlewareServices.length > 0 ? options.middlewareServices : undefined;
  const middlewareConfigs: SellerMiddlewareConfig[] = options.middlewareFiles.map((file) => ({
    file,
    position: options.middlewarePosition,
    ...(options.middlewareRole !== undefined ? { role: options.middlewareRole } : {}),
    ...(middlewareServices !== undefined ? { services: middlewareServices } : {}),
  }));
  const middlewareEntries: ProviderMiddleware[] = [];
  if (middlewareConfigs.length > 0) {
    middlewareEntries.push(...await loadMiddlewareFiles(middlewareConfigs, process.cwd()));
  }
  for (const directory of options.middlewareDirs) {
    middlewareEntries.push(...await loadMiddlewareDirectory(directory, {
      position: options.middlewarePosition,
      ...(options.middlewareRole !== undefined ? { role: options.middlewareRole } : {}),
      ...(middlewareServices !== undefined ? { services: middlewareServices } : {}),
    }));
  }

  if (middlewareEntries.length > 0) {
    provider = new MiddlewareProvider(provider, middlewareEntries, options.middlewareConfidentialityPrompt);
  }

  if (options.skillsDir) {
    const registry = new SkillRegistry();
    await registry.loadDirectory(options.skillsDir);
    provider = new AgentProvider(provider, registry);
  }

  return provider;
}

export function registerServeAgentCommand(program: Command): void {
  program
    .command('serve-agent')
    .description('Run a local standalone agent service backed by a provider plugin')
    .option('-p, --port <number>', 'local listen port', (value) => parseInt(value, 10), DEFAULT_PORT)
    .option('--host <host>', 'local listen host', DEFAULT_HOST)
    .option('--provider <name>', 'provider plugin name', 'openai')
    .option('--skills-dir <path>', 'directory of skill subdirectories containing SKILL.md')
    .option('--middleware-file <path>', 'middleware markdown file (repeatable)', collectList, [])
    .option('--middleware-dir <path>', 'directory of middleware markdown files (repeatable)', collectList, [])
    .option('--middleware-position <position>', 'middleware insertion position', 'system-prepend')
    .option('--middleware-role <role>', 'role for prepend/append middleware')
    .option('--middleware-service <service>', 'restrict middleware to service IDs (repeatable)', collectList, [])
    .option('--middleware-confidentiality-prompt <text>', 'override the middleware confidentiality prompt')
    .action(async (options) => {
      if (!isValidMiddlewarePosition(options.middlewarePosition as string)) {
        console.error(chalk.red(`Invalid --middleware-position "${String(options.middlewarePosition)}"`));
        process.exit(1);
      }

      const spinner = ora(`Loading provider stack "${String(options.provider)}"...`).start();
      let provider: Provider;
      try {
        provider = await buildProviderStack({
          providerName: options.provider as string,
          skillsDir: options.skillsDir ? resolve(options.skillsDir as string) : undefined,
          middlewareFiles: (options.middlewareFile as string[]).map((value) => resolve(value)),
          middlewareDirs: (options.middlewareDir as string[]).map((value) => resolve(value)),
          middlewarePosition: options.middlewarePosition as MiddlewarePosition,
          middlewareRole: options.middlewareRole as string | undefined,
          middlewareServices: (options.middlewareService as string[]).map((value) => value.trim()).filter((value) => value.length > 0),
          middlewareConfidentialityPrompt: options.middlewareConfidentialityPrompt as string | undefined,
        });
      } catch (error) {
        spinner.fail(chalk.red(`Failed to load provider stack: ${(error as Error).message}`));
        process.exit(1);
      }

      spinner.succeed(chalk.green(`Provider "${provider.name}" ready`));

      const server = createServer(async (req, res) => {
        try {
          const method = req.method ?? 'GET';
          const path = req.url ?? '/';

          if (method === 'GET' && path === '/health') {
            writeJson(res, 200, { ok: true });
            return;
          }

          if (method === 'GET' && path === '/v1/models') {
            const body = buildOpenAIModelsResponse(provider);
            res.writeHead(200, {
              'content-type': 'application/json',
              'content-length': String(body.length),
            });
            res.end(Buffer.from(body));
            return;
          }

          if (method !== 'POST') {
            writeJson(res, 400, { error: { message: 'Only POST is supported for this endpoint', type: 'invalid_request_error' } });
            return;
          }

          const body = await readIncomingBody(req);
          const serializedReq = serializeRequest(req, body);
          const streamRequested = isStreamRequested(serializedReq);

          if (!serializedReq.path.startsWith('/v1/')) {
            writeJson(res, 400, { error: { message: `Unsupported path "${serializedReq.path}"`, type: 'invalid_request_error' } });
            return;
          }

          log(`${serializedReq.method} ${serializedReq.path} stream=${streamRequested}`);

          if (streamRequested && provider.handleRequestStream) {
            let started = false;
            const callbacks: ProviderStreamCallbacks = {
              onResponseStart: (response) => {
                res.writeHead(response.statusCode, toNodeHeaders(response.headers));
                started = true;
              },
              onResponseChunk: (chunk) => {
                if (chunk.data.length > 0) {
                  res.write(Buffer.from(chunk.data));
                }
                if (chunk.done && !res.writableEnded) {
                  res.end();
                }
              },
            };

            const response = await provider.handleRequestStream(serializedReq, callbacks);
            if (!started) {
              writeBufferedResponse(res, response);
            }
            return;
          }

          const response = await provider.handleRequest(serializedReq);
          writeBufferedResponse(res, response);
        } catch (error) {
          writeJson(res, 500, { error: { message: (error as Error).message, type: 'server_error' } });
        }
      });

      server.listen(options.port as number, options.host as string, () => {
        console.log(chalk.green(`Local agent service listening on http://${String(options.host)}:${String(options.port)}`));
        console.log(chalk.dim('Native provider endpoints are forwarded unchanged, plus /v1/models and /health.'));
      });

      setupShutdownHandler(async () => {
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => {
            if (error) {
              rejectClose(error);
              return;
            }
            resolveClose();
          });
        });
      });
    });
}

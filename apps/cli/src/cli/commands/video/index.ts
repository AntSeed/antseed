import type { Command } from 'commander';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import chalk from 'chalk';
import type { VideoArtifactManifest, VideoGenerationResource } from '@antseed/node';
import { loadConfig } from '../../../config/loader.js';
import { getGlobalOptions } from '../types.js';

export interface VideoCommandContext {
  baseUrl: string;
  json: boolean;
}

interface VideoCreateOptions {
  model: string;
  prompt: string;
  image?: string;
  duration: string;
  aspectRatio?: string;
  resolution?: string;
  audio?: boolean;
  seed?: string;
  metadataJson?: string;
  runwayJson?: string;
  veoJson?: string;
  outputFormat: string;
  provider?: string;
  wait?: boolean;
  download?: string;
  json?: boolean;
  maxTotalUsdc?: string;
  maxUpfrontPercent?: string;
  timeout?: string;
}

export function registerVideoCommands(program: Command): void {
  const video = program.command('video').description('Create and manage durable video generations');

  video.command('create')
    .requiredOption('--model <model>', 'Runway or Veo model ID')
    .requiredOption('--prompt <prompt>', 'video prompt')
    .option('--image <path>', 'first-frame image')
    .option('--duration <seconds>', 'requested duration', '8')
    .option('--aspect-ratio <ratio>', 'aspect ratio, such as 16:9')
    .option('--resolution <resolution>', 'output resolution, such as 1080p')
    .option('--audio', 'generate audio when supported')
    .option('--no-audio', 'disable generated audio when supported')
    .option('--seed <integer>', 'provider seed when supported')
    .option('--metadata-json <json>', 'metadata object as JSON')
    .option('--runway-json <json>', 'Runway extension object as JSON')
    .option('--veo-json <json>', 'Veo extension object as JSON')
    .option('--output-format <format>', 'output format', 'mp4')
    .option('--provider <provider>', 'restrict routing to runway or veo')
    .option('--wait', 'wait for a terminal state')
    .option('--download <path>', 'wait and download the primary artifact')
    .option('--json', 'emit machine-readable JSON')
    .option('--max-total-usdc <base-units>', 'maximum total price in USDC base units')
    .option('--max-upfront-percent <percent>', 'maximum upfront percentage')
    .option('--timeout <seconds>', 'maximum wait time', '1800')
    .action(async (options: VideoCreateOptions) => {
      const context = await commandContext(video, options.json === true);
      const duration = Number(options.duration);
      if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('--duration must be a positive integer');
      if (options.provider && options.provider !== 'runway' && options.provider !== 'veo') throw new Error('--provider must be runway or veo');
      const seed = options.seed === undefined ? undefined : Number(options.seed);
      if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0)) throw new Error('--seed must be a non-negative integer');
      const metadata = parseJsonObjectOption(options.metadataJson, '--metadata-json', true);
      const runwayExtension = parseJsonObjectOption(options.runwayJson, '--runway-json');
      const veoExtension = parseJsonObjectOption(options.veoJson, '--veo-json');
      const waitTimeoutMs = parseTimeoutMs(options.timeout);
      const headers = videoHeaders(options);
      let inputAssets: Array<{ type: 'image'; role: 'first_frame'; asset_id: string }> | undefined;
      if (options.image) {
        const imagePath = resolve(options.image);
        const imageBytes = await import('node:fs/promises').then(({ readFile }) => readFile(imagePath));
        const mimeType = imageMimeType(imagePath);
        const asset = await requestJson<{ id: string }>(context.baseUrl, '/v1/video/assets', {
          method: 'POST', headers: { ...headers, 'content-type': mimeType, 'x-antseed-model': options.model }, body: imageBytes,
        });
        inputAssets = [{ type: 'image', role: 'first_frame', asset_id: asset.id }];
      }
      const body = {
        model: options.model,
        prompt: options.prompt,
        ...(inputAssets ? { input_assets: inputAssets } : {}),
        duration_seconds: duration,
        ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
        ...(options.resolution ? { resolution: options.resolution } : {}),
        ...(options.audio === undefined ? {} : { generate_audio: options.audio }),
        output_format: options.outputFormat,
        ...(seed === undefined ? {} : { seed }),
        ...(metadata ? { metadata } : {}),
        ...(runwayExtension || veoExtension ? {
          extensions: {
            ...(runwayExtension ? { runway: runwayExtension } : {}),
            ...(veoExtension ? { veo: veoExtension } : {}),
          },
        } : {}),
      };
      const response = await requestJson<VideoGenerationResource>(context.baseUrl, '/v1/video/generations', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify(body),
      });
      let generation = response;
      if (options.wait || options.download) generation = await waitForGeneration(context, generation.id, waitTimeoutMs);
      if (options.download) {
        if (generation.status !== 'succeeded' || !generation.artifacts[0]) throw new Error(`Generation ended with status ${generation.status}`);
        await downloadArtifact(context, generation, generation.artifacts[0], resolve(options.download));
      }
      print(context, generation);
    });

  video.command('status')
    .argument('<generation-id>')
    .option('--json', 'emit machine-readable JSON')
    .action(async (generationId: string, options: { json?: boolean }) => {
      const context = await commandContext(video, options.json === true);
      print(context, await getGeneration(context.baseUrl, generationId));
    });

  video.command('list')
    .option('--json', 'emit machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const global = getGlobalOptions(video);
      const context = await commandContext(video, options.json === true);
      const ids = await localGenerationIds(global.dataDir);
      const data = (await Promise.all(ids.map((id) => getGeneration(context.baseUrl, id).catch(() => null))))
        .filter((value): value is VideoGenerationResource => value !== null)
        .sort((left, right) => right.created_at - left.created_at);
      print(context, { object: 'list', data });
    });

  video.command('cancel')
    .argument('<generation-id>')
    .option('--json', 'emit machine-readable JSON')
    .action(async (generationId: string, options: { json?: boolean }) => {
      const context = await commandContext(video, options.json === true);
      print(context, await requestJson(context.baseUrl, `/v1/video/generations/${encodeURIComponent(generationId)}/cancel`, { method: 'POST' }));
    });

  video.command('download')
    .argument('<generation-id>')
    .argument('<path>')
    .option('--artifact <artifact-id>', 'specific artifact ID')
    .option('--json', 'emit machine-readable JSON')
    .option('--timeout <seconds>', 'maximum wait time', '1800')
    .action(async (generationId: string, outputPath: string, options: { artifact?: string; json?: boolean; timeout?: string }) => {
      const context = await commandContext(video, options.json === true);
      const generation = await waitForGeneration(context, generationId, parseTimeoutMs(options.timeout));
      const artifact = options.artifact
        ? generation.artifacts.find((candidate) => candidate.id === options.artifact)
        : generation.artifacts[0];
      if (!artifact) throw new Error('Generation has no matching artifact');
      await downloadArtifact(context, generation, artifact, resolve(outputPath));
      print(context, { generation_id: generation.id, artifact_id: artifact.id, path: resolve(outputPath), sha256: artifact.sha256, bytes: artifact.bytes });
    });
}

async function commandContext(command: Command, json: boolean): Promise<VideoCommandContext> {
  const global = getGlobalOptions(command);
  const config = await loadConfig(global.config);
  const port = config.buyer.proxyPort;
  return { baseUrl: `http://127.0.0.1:${port}`, json };
}

function videoHeaders(options: VideoCreateOptions): Record<string, string> {
  const headers: Record<string, string> = { 'x-antseed-model': options.model };
  if (options.provider) headers['x-antseed-provider'] = options.provider;
  if (options.maxTotalUsdc) {
    if (!/^(0|[1-9]\d*)$/.test(options.maxTotalUsdc)) throw new Error('--max-total-usdc must be USDC base units');
    headers['x-antseed-video-max-total-usdc'] = options.maxTotalUsdc;
  }
  if (options.maxUpfrontPercent) {
    const percent = Number(options.maxUpfrontPercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('--max-upfront-percent must be from 0 through 100');
    headers['x-antseed-video-max-upfront-bps'] = String(Math.round(percent * 100));
  }
  return headers;
}

async function waitForGeneration(
  context: VideoCommandContext,
  generationId: string,
  timeoutMs: number,
): Promise<VideoGenerationResource> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  for (;;) {
    const generation = await getGeneration(context.baseUrl, generationId);
    if (!context.json && generation.status !== lastStatus) {
      console.error(chalk.dim(`Video ${generation.id}: ${generation.status}${generation.progress === null ? '' : ` (${generation.progress}%)`}`));
      lastStatus = generation.status;
    }
    if (['succeeded', 'failed', 'canceled', 'expired'].includes(generation.status)) return generation;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for video generation ${generationId}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
  }
}

function getGeneration(baseUrl: string, generationId: string): Promise<VideoGenerationResource> {
  return requestJson(baseUrl, `/v1/video/generations/${encodeURIComponent(generationId)}`);
}

export async function downloadArtifact(
  context: VideoCommandContext,
  generation: VideoGenerationResource,
  artifact: VideoArtifactManifest,
  outputPath: string,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const partialPath = `${outputPath}.part`;
  const completed = await stat(outputPath).catch(() => null);
  if (completed?.isFile()) {
    if (completed.size !== artifact.bytes || await hashFile(outputPath) !== artifact.sha256) {
      throw new Error(`Output already exists and does not match the artifact: ${outputPath}`);
    }
    await submitReceipt(context, generation, artifact, artifact.sha256, artifact.bytes);
    return;
  }
  const head = await fetch(new URL(artifact.links.content, context.baseUrl), { method: 'HEAD' });
  if (!head.ok) throw await httpError(head);
  const headBytes = Number(head.headers.get('content-length'));
  const headSha256 = head.headers.get('x-antseed-artifact-sha256');
  if (headBytes !== artifact.bytes) throw new Error(`Artifact HEAD size mismatch: expected ${artifact.bytes}, received ${headBytes}`);
  if (headSha256 && headSha256 !== artifact.sha256) throw new Error('Artifact HEAD SHA-256 does not match the generation manifest');
  if (head.headers.get('accept-ranges')?.toLowerCase() !== 'bytes') throw new Error('Artifact server does not advertise byte-range support');
  const partial = await stat(partialPath).catch(() => null);
  let offset = partial?.isFile() ? partial.size : 0;
  if (offset > artifact.bytes) {
    await unlink(partialPath);
    offset = 0;
  }
  let response: Response | null = null;
  if (offset < artifact.bytes) {
    response = await fetch(new URL(artifact.links.content, context.baseUrl), {
      headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
    });
    if (response.status !== 200 && response.status !== 206) throw await httpError(response);
    if (offset > 0 && response.status === 200) offset = 0;
    if (offset > 0) {
      const contentRange = response.headers.get('content-range');
      if (!contentRange?.startsWith(`bytes ${offset}-`)) throw new Error(`Artifact server returned an invalid Content-Range for offset ${offset}`);
    }
    if (!response.body) throw new Error('Artifact response has no body');
  }
  if (response?.body) {
    const output = createWriteStream(partialPath, { flags: offset > 0 ? 'a' : 'w' });
    await pipeline(Readable.fromWeb(response.body), output);
  }
  const file = await stat(partialPath);
  if (file.size !== artifact.bytes) throw new Error(`Artifact size mismatch: expected ${artifact.bytes}, received ${file.size}`);
  const sha256 = await hashFile(partialPath);
  if (sha256 !== artifact.sha256) throw new Error(`Artifact SHA-256 mismatch: expected ${artifact.sha256}, received ${sha256}`);
  await rename(partialPath, outputPath);
  await submitReceipt(context, generation, artifact, sha256, file.size);
}

async function submitReceipt(
  context: VideoCommandContext,
  generation: VideoGenerationResource,
  artifact: VideoArtifactManifest,
  sha256: string,
  bytes: number,
): Promise<void> {
  await requestJson(context.baseUrl, `/v1/video/generations/${encodeURIComponent(generation.id)}/artifacts/${encodeURIComponent(artifact.id)}/receipt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      generation_id: generation.id,
      artifact_id: artifact.id,
      sha256,
      bytes,
      received_at: Math.floor(Date.now() / 1000),
    }),
  });
}

function parseTimeoutMs(value: string | undefined): number {
  const seconds = Number(value ?? '1800');
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) throw new Error('--timeout must be between 1 and 86400 seconds');
  return Math.round(seconds * 1_000);
}

function parseJsonObjectOption(
  value: string | undefined,
  option: string,
  stringValuesOnly = false,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${option} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${option} must be a JSON object`);
  if (stringValuesOnly && Object.values(parsed as Record<string, unknown>).some((child) => typeof child !== 'string')) {
    throw new Error(`${option} values must be strings`);
  }
  return parsed as Record<string, unknown>;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function localGenerationIds(dataDir: string): Promise<string[]> {
  try {
    const file = await open(resolve(dataDir, 'buyer.state.json'), 'r');
    try {
      const parsed = JSON.parse(await file.readFile('utf8')) as { videoAffinities?: Record<string, unknown> };
      return Object.keys(parsed.videoAffinities ?? {}).filter((id) => id.startsWith('vg_'));
    } finally {
      await file.close();
    }
  } catch {
    return [];
  }
}

async function requestJson<T = unknown>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, baseUrl), { ...init, signal: AbortSignal.timeout(10 * 60_000) });
  } catch (error) {
    throw new Error(`Buyer proxy is unavailable at ${baseUrl}: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) throw await httpError(response);
  return await response.json() as T;
}

async function httpError(response: Response): Promise<Error> {
  const text = await response.text();
  let message = text || `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; video_quote?: unknown };
    const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    message = detail ?? message;
    if (parsed.video_quote) message += `\nQuote: ${JSON.stringify(parsed.video_quote, null, 2)}`;
  } catch {}
  return new Error(message);
}

function imageMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  throw new Error('--image must be PNG, WebP, or JPEG');
}

function print(context: VideoCommandContext, value: unknown): void {
  if (context.json) console.log(JSON.stringify(value));
  else console.log(chalk.green(JSON.stringify(value, null, 2)));
}

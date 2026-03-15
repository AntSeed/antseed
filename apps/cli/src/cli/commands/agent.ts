import type { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'node:readline';
import { resolve, isAbsolute } from 'node:path';
import { loadAntAgent, AntAgentProvider } from '@antseed/ant-agent';
import { BaseProvider, StaticTokenProvider } from '@antseed/provider-core';
import type { SerializedHttpRequest } from '@antseed/node';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface LLMConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  authHeader: string;
}

function resolveLLMConfig(options: Record<string, unknown>): LLMConfig {
  const endpoint = (options['endpoint'] as string | undefined)
    ?? process.env['OPENAI_BASE_URL']
    ?? process.env['ANTHROPIC_BASE_URL']
    ?? 'https://api.anthropic.com';

  const apiKey = (options['apiKey'] as string | undefined)
    ?? process.env['ANTHROPIC_API_KEY']
    ?? process.env['OPENAI_API_KEY']
    ?? '';

  const model = (options['model'] as string | undefined)
    ?? process.env['ANTSEED_MODEL']
    ?? 'claude-sonnet-4-5-20250929';

  if (!apiKey) {
    console.error(chalk.red('No API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or pass --api-key'));
    process.exit(1);
  }

  // Detect auth header from endpoint — use lowercase to match relay convention
  const isAnthropic = endpoint.includes('anthropic.com');
  const authHeader = isAnthropic ? 'x-api-key' : 'authorization';

  return { endpoint, apiKey, model, authHeader };
}

function createProvider(config: LLMConfig) {
  return new BaseProvider({
    name: 'agent-dev',
    services: [config.model],
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    relay: {
      baseUrl: config.endpoint,
      authHeaderName: config.authHeader,
      authHeaderValue: '',
      tokenProvider: new StaticTokenProvider(config.apiKey),
      maxConcurrency: 1,
      allowedServices: [config.model],
    },
  });
}

export function registerAgentCommand(program: Command): void {
  const agentCmd = program
    .command('agent')
    .description('Ant agent development tools');

  agentCmd
    .command('dev <agentDir>')
    .description('Test an ant agent locally with an interactive chat')
    .option('--endpoint <url>', 'LLM API endpoint (or set OPENAI_BASE_URL / ANTHROPIC_BASE_URL)')
    .option('--api-key <key>', 'API key (or set ANTHROPIC_API_KEY / OPENAI_API_KEY)')
    .option('--model <model>', 'model to use (default: claude-sonnet-4-5-20250929)')
    .action(async (agentDir: string, options: Record<string, unknown>) => {
      const agentPath = isAbsolute(agentDir) ? agentDir : resolve(process.cwd(), agentDir);

      // Load agent
      let agentDef;
      try {
        agentDef = await loadAntAgent(agentPath);
      } catch (err) {
        console.error(chalk.red(`Failed to load agent from ${agentDir}: ${(err as Error).message}`));
        process.exit(1);
      }

      const knowledgeCount = agentDef.knowledge.length;
      const toolCount = agentDef.tools?.length ?? 0;
      console.log(chalk.green(`Loaded agent "${agentDef.name}"`));
      console.log(chalk.dim(`  knowledge: ${knowledgeCount} module${knowledgeCount !== 1 ? 's' : ''}`));
      console.log(chalk.dim(`  tools: ${toolCount} custom tool${toolCount !== 1 ? 's' : ''}`));
      if (agentDef.persona) console.log(chalk.dim(`  persona: ${agentDef.persona.slice(0, 80)}...`));
      console.log();

      // Setup LLM
      const llmConfig = resolveLLMConfig(options);
      console.log(chalk.dim(`  endpoint: ${llmConfig.endpoint}`));
      console.log(chalk.dim(`  model: ${llmConfig.model}`));
      console.log();

      const innerProvider = createProvider(llmConfig);
      const provider = new AntAgentProvider(innerProvider, agentDef);

      // Detect API format from endpoint
      const isOpenAI = !llmConfig.endpoint.includes('anthropic.com');
      const apiPath = isOpenAI ? '/v1/chat/completions' : '/v1/messages';

      const messages: { role: string; content: string }[] = [];

      console.log(chalk.cyan('Chat with your ant agent. Type "exit" to quit, "clear" to reset.'));
      console.log();

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const prompt = () => {
        rl.question(chalk.bold('You: '), (input) => {
          const trimmed = input.trim();
          if (!trimmed) { prompt(); return; }
          if (trimmed === 'exit' || trimmed === 'quit') { rl.close(); return; }
          if (trimmed === 'clear') {
            messages.length = 0;
            console.log(chalk.dim('Conversation cleared.\n'));
            prompt();
            return;
          }

          messages.push({ role: 'user', content: trimmed });

          void (async () => {
          // Build request
          let body: Record<string, unknown>;
          if (isOpenAI) {
            body = {
              model: llmConfig.model,
              messages: [...messages],
              stream: false,
            };
          } else {
            body = {
              model: llmConfig.model,
              messages: [...messages],
              max_tokens: 4096,
              stream: false,
            };
          }

          const req: SerializedHttpRequest = {
            requestId: crypto.randomUUID(),
            method: 'POST',
            path: apiPath,
            headers: { 'content-type': 'application/json' },
            body: encoder.encode(JSON.stringify(body)),
          };

          try {
            const res = await provider.handleRequest(req);
            const resBody = JSON.parse(decoder.decode(res.body)) as Record<string, unknown>;

            let text: string;
            if (isOpenAI) {
              const choices = resBody.choices as { message: { content: string } }[];
              text = choices?.[0]?.message?.content ?? '(no response)';
            } else {
              const content = resBody.content as { type: string; text?: string }[];
              text = content?.find(b => b.type === 'text')?.text ?? '(no response)';
            }

            messages.push({ role: 'assistant', content: text });
            console.log(chalk.green('\nAssistant: ') + text + '\n');
          } catch (err) {
            console.error(chalk.red(`\nError: ${(err as Error).message}\n`));
          }

          prompt();
          })().catch((err) => {
            console.error(chalk.red(`\nError: ${(err as Error).message}\n`));
            prompt();
          });
        });
      };

      prompt();

      rl.on('close', () => {
        console.log(chalk.dim('\nGoodbye!'));
        process.exit(0);
      });
    });
}

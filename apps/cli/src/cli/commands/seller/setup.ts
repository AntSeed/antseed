import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'node:readline/promises';
import { loadOrCreateIdentity } from '@antseed/node';
import { checkSellerReadiness } from '@antseed/node/payments';
import { getGlobalOptions } from '../types.js';
import { loadConfig, saveConfig } from '../../../config/loader.js';
import { ensureDerivedIdentityDisplayName } from '../../../config/identity-display-name.js';
import { assertValidConfig } from '../../../config/validation.js';
import { TRUSTED_PLUGINS } from '../../../plugins/registry.js';
import { installPlugin } from '../../../plugins/manager.js';
import type { AntseedConfig, SellerProviderConfig, SellerServiceConfig } from '../../../config/types.js';
import type { ServiceCapabilities, UnitBillingModelV1 } from '@antseed/node';
import { isImageModelId } from '@antseed/provider-core';
import { parseServiceUnitBillingModelsInput } from '../../../config/service-metadata.js';
import { promptServiceCapabilities } from './capability-prompts.js';
import { createIdentityClient, createStakingClient, normalizeHttpRpcUrl } from '../../payment-utils.js';

export function buildSellerSetupProviderEntry(input: {
  plugin: string;
  baseUrl?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  apiKeyEnv?: string;
  videoPayment?: { upfrontBps: number };
  services?: Record<string, SellerServiceConfig>;
}): SellerProviderConfig {
  const hasDefaults = input.inputUsdPerMillion !== undefined || input.outputUsdPerMillion !== undefined;
  return {
    plugin: input.plugin,
    services: input.services ?? {},
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
    ...(input.videoPayment ? { videoPayment: input.videoPayment } : {}),
    ...(hasDefaults
      ? {
          defaults: {
            inputUsdPerMillion: input.inputUsdPerMillion ?? 0,
            outputUsdPerMillion: input.outputUsdPerMillion ?? 0,
          },
        }
      : {}),
  };
}

export function applySellerSetupRpcUrl(config: AntseedConfig, input: string): void {
  const value = input.trim();
  if (!value) return;

  config.payments.crypto = config.payments.crypto ?? { chainId: 'base-mainnet' };
  if (value === '-') {
    delete config.payments.crypto.rpcUrl;
    return;
  }

  config.payments.crypto.rpcUrl = normalizeHttpRpcUrl(value, 'Base RPC URL');
}

async function printReadinessCheck(dataDir: string, configPath: string): Promise<void> {
  console.log(chalk.bold('Readiness check:\n'));
  try {
    const config = await loadConfig(configPath);
    const identity = await loadOrCreateIdentity(dataDir);
    const identityClient = createIdentityClient(config);
    const stakingClient = createStakingClient(config);
    const sellerContract = config.payments.sellerContract?.address;
    const checks = await checkSellerReadiness(identity, identityClient, stakingClient, sellerContract);

    for (const check of checks) {
      const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
      console.log(`  ${icon} ${chalk.bold(check.name)}: ${check.message}`);
      if (!check.passed && check.command) {
        console.log(chalk.dim(`    → ${check.command}`));
      }
    }
  } catch (err) {
    console.log(`  ${chalk.red('✗')} ${chalk.bold('Readiness check unavailable')}: ${(err as Error).message}`);
  }
  console.log('');
}

export function getSellerSetupCredentialHint(pluginName: string): string {
  switch (pluginName) {
    case 'anthropic':
      return 'export ANTHROPIC_API_KEY=<key>';
    case 'openai':
    case 'openai-responses':
      return 'export OPENAI_API_KEY=<key>';
    case 'claude-oauth':
      return 'configure Claude OAuth credentials for the selected plugin';
    case 'claude-code':
      return 'sign in to Claude Code on this machine';
    case 'local-llm':
      return 'start your local LLM runtime (no API key required)';
    case 'runway':
      return 'export RUNWAY_API_KEY=<key>';
    case 'veo':
      return 'export GEMINI_API_KEY=<key>';
    default:
      return `set the credentials required by ${pluginName}`;
  }
}

export function registerSellerSetupCommand(sellerCmd: Command): void {
  sellerCmd
    .command('setup')
    .description('Interactive seller setup — configure a provider and add services')
    .action(async () => {
      const globalOpts = getGlobalOptions(sellerCmd);
      const config = await loadConfig(globalOpts.config);
      await ensureDerivedIdentityDisplayName({
        config,
        configPath: globalOpts.config,
        dataDir: globalOpts.dataDir,
      });
      const rl = createInterface({ input: process.stdin, output: process.stdout });

      try {
        console.log(chalk.bold('\nAntSeed Seller Setup\n'));

        const currentRpcUrl = config.payments.crypto?.rpcUrl;
        const rpcPrompt = currentRpcUrl
          ? `Custom Base network RPC URL [${currentRpcUrl}] (blank to keep, "-" to clear): `
          : 'Custom Base network RPC URL (optional, leave empty for default): ';
        const rpcUrlInput = await rl.question(rpcPrompt);
        try {
          applySellerSetupRpcUrl(config, rpcUrlInput);
        } catch (err) {
          console.error(chalk.red(`\nError: ${(err as Error).message}`));
          return;
        }
        console.log('');

        const providers = TRUSTED_PLUGINS.filter((plugin) => plugin.type === 'provider');
        console.log(chalk.bold('Available provider plugins:\n'));
        providers.forEach((plugin, index) => {
          console.log(`  ${chalk.cyan(String(index + 1))}. ${plugin.name.padEnd(16)} ${chalk.dim(plugin.description)}`);
        });
        console.log(`  ${chalk.cyan(String(providers.length + 1))}. ${chalk.dim('Custom npm package')}`);
        console.log('');

        const choice = await rl.question('Choose a plugin (number): ');
        const choiceNum = parseInt(choice.trim(), 10);

        let pluginName: string;
        let packageName: string;
        if (choiceNum > 0 && choiceNum <= providers.length) {
          const selected = providers[choiceNum - 1]!;
          pluginName = selected.name;
          packageName = selected.package;
        } else {
          const customPackage = await rl.question('npm package name: ');
          packageName = customPackage.trim();
          pluginName = packageName;
        }

        const defaultName = pluginName.replace(/^@antseed\/provider-/, '');
        const nameInput = await rl.question(`Provider name [${defaultName}]: `);
        const providerName = nameInput.trim() || defaultName;
        if (config.seller.providers[providerName]) {
          console.log(chalk.yellow(`\nProvider "${providerName}" already exists. Updating it.`));
        }

        const baseUrlInput = await rl.question('Base URL (leave empty for default): ');
        const baseUrl = baseUrlInput.trim() || undefined;

        const videoPlugin = pluginName === 'runway' || pluginName === 'veo';
        const defaultApiKeyEnv = pluginName === 'runway' ? 'RUNWAY_API_KEY' : pluginName === 'veo' ? 'GEMINI_API_KEY' : '';
        const apiKeyEnvInput = videoPlugin
          ? await rl.question(`API-key environment variable [${defaultApiKeyEnv}]: `)
          : '';
        const apiKeyEnv = videoPlugin ? apiKeyEnvInput.trim() || defaultApiKeyEnv : undefined;
        const upfrontPercentInput = videoPlugin
          ? await rl.question('Upfront payment percentage [50]: ')
          : '';
        const upfrontPercent = upfrontPercentInput.trim() ? Number(upfrontPercentInput) : 50;
        if (videoPlugin && (!Number.isFinite(upfrontPercent) || upfrontPercent < 0 || upfrontPercent > 100)) {
          console.error(chalk.red('\nError: upfront payment percentage must be from 0 through 100'));
          return;
        }

        const inputStr = videoPlugin ? '' : await rl.question('Default input price (USD per 1M tokens): ');
        const outputStr = videoPlugin ? '' : await rl.question('Default output price (USD per 1M tokens): ');
        const inputUsd = inputStr.trim() ? parseFloat(inputStr.trim()) : undefined;
        const outputUsd = outputStr.trim() ? parseFloat(outputStr.trim()) : undefined;

        const spinner = ora(`Installing ${packageName}...`).start();
        try {
          await installPlugin(packageName);
          spinner.succeed(chalk.green(`Installed ${packageName}`));
        } catch (err) {
          spinner.fail(chalk.red(`Failed: ${(err as Error).message}`));
          return;
        }

        console.log(chalk.bold('\nAdd your first service:\n'));
        if (videoPlugin) {
          console.log(chalk.dim(`Tested presets: ${Object.keys(VIDEO_PRESETS[pluginName] ?? {}).join(', ')}`));
        }
        const services: Record<string, SellerServiceConfig> = {};
        let addMore = true;
        while (addMore) {
          const serviceIdInput = await rl.question('Service ID (e.g., claude-sonnet-4-6, gpt-4o): ');
          const serviceId = serviceIdInput.trim();
          if (!serviceId) break;

          const preset = videoPlugin ? VIDEO_PRESETS[pluginName]?.[serviceId] : undefined;
          if (videoPlugin && !preset) {
            console.error(chalk.red(`  ${serviceId} is not a tested ${pluginName} preset`));
            continue;
          }
          const upstreamInput = videoPlugin ? serviceId : await rl.question(`Upstream model [${serviceId}]: `);
          const svcInputStr = videoPlugin ? '' : await rl.question('Input price (USD/1M, or enter for provider default): ');
          const svcOutputStr = videoPlugin ? '' : await rl.question('Output price (USD/1M, or enter for provider default): ');
          const categoriesStr = videoPlugin ? 'video' : await rl.question('Categories (comma-separated, e.g., chat,coding): ');
          const serviceKind = isImageModelId(upstreamInput.trim() || serviceId) ? 'image' : 'text';
          const capabilities = preset?.capabilities ?? await promptServiceCapabilities(rl, serviceKind);
          let unitBillingModels: SellerServiceConfig['unitBillingModels'];
          if (videoPlugin) {
            const perVideoInput = await rl.question('Fixed price per output video in USD [0]: ');
            const perSecondInput = await rl.question('Price per output video second in USD: ');
            unitBillingModels = {
              'antseed-video-jobs-v1': videoBillingModel(perVideoInput, perSecondInput),
            };
          } else {
            const unitBillingModelsStr = await rl.question('Unit billing models JSON by protocol (optional): ');
            if (unitBillingModelsStr.trim()) unitBillingModels = parseServiceUnitBillingModelsInput(unitBillingModelsStr.trim());
          }

          const service: SellerServiceConfig = {};
          const upstreamModel = upstreamInput.trim();
          if (upstreamModel && upstreamModel !== serviceId) {
            service.upstreamModel = upstreamModel;
          }

          const svcInput = svcInputStr.trim() ? parseFloat(svcInputStr.trim()) : undefined;
          const svcOutput = svcOutputStr.trim() ? parseFloat(svcOutputStr.trim()) : undefined;
          if (svcInput !== undefined || svcOutput !== undefined) {
            service.pricing = {
              inputUsdPerMillion: svcInput ?? 0,
              outputUsdPerMillion: svcOutput ?? 0,
            };
          }

          if (categoriesStr.trim()) {
            service.categories = categoriesStr.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
          }
          if (capabilities) {
            service.capabilities = capabilities;
          }
          if (unitBillingModels) service.unitBillingModels = unitBillingModels;

          services[serviceId] = service;
          console.log(chalk.green(`  Added: ${serviceId}`));

          const moreInput = await rl.question('\nAdd another service? (y/N): ');
          addMore = moreInput.trim().toLowerCase() === 'y';
        }

        const providerEntry = buildSellerSetupProviderEntry({
          plugin: pluginName,
          baseUrl,
          apiKeyEnv,
          ...(videoPlugin ? { videoPayment: { upfrontBps: Math.round(upfrontPercent * 100) } } : {}),
          inputUsdPerMillion: inputUsd,
          outputUsdPerMillion: outputUsd,
          services,
        });

        config.seller.providers[providerName] = providerEntry;

        // Optional verifier SDK — advertised in metadata so buyers can attest this node.
        const verifiers = TRUSTED_PLUGINS.filter((plugin) => plugin.type === 'verifier');
        if (verifiers.length > 0) {
          console.log(chalk.bold('\nVerifier SDK (optional — lets buyers cryptographically attest your node):\n'));
          verifiers.forEach((plugin, index) => {
            console.log(`  ${chalk.cyan(String(index + 1))}. ${plugin.name.padEnd(28)} ${chalk.dim(plugin.description)}`);
          });
          console.log(`  ${chalk.cyan('0')}. ${chalk.dim('None')}`);
          console.log('');
          const verifierChoice = await rl.question('Choose a verifier SDK (number, blank for none): ');
          const verifierNum = parseInt(verifierChoice.trim(), 10);
          if (verifierNum > 0 && verifierNum <= verifiers.length) {
            const selectedVerifier = verifiers[verifierNum - 1]!;
            const verifierSpinner = ora(`Installing ${selectedVerifier.package}...`).start();
            try {
              await installPlugin(selectedVerifier.package);
              verifierSpinner.succeed(chalk.green(`Installed ${selectedVerifier.package}`));
              config.seller.verifiers = [selectedVerifier.name];
            } catch (err) {
              verifierSpinner.fail(chalk.red(`Failed: ${(err as Error).message} — add it later with 'antseed seller start --verifiers ${selectedVerifier.name}'`));
            }
          }
        }

        assertValidConfig(config);
        await saveConfig(globalOpts.config, config);
        console.log(chalk.green(`\nProvider "${providerName}" saved to config.`));

        console.log(chalk.bold('\nNext steps:\n'));
        console.log(`  ${chalk.cyan('1.')} Set credentials: ${chalk.dim(getSellerSetupCredentialHint(pluginName))}`);
        console.log(`  ${chalk.cyan('2.')} Register on-chain: ${chalk.dim('antseed seller register')}`);
        console.log(`  ${chalk.cyan('3.')} Stake USDC: ${chalk.dim('antseed seller stake 10')}`);
        console.log(`  ${chalk.cyan('4.')} Start selling: ${chalk.dim('antseed seller start')}`);
        console.log('');

        await printReadinessCheck(globalOpts.dataDir, globalOpts.config);
      } finally {
        rl.close();
      }
    });
}

const VIDEO_PRESETS: Record<string, Record<string, { capabilities: ServiceCapabilities }>> = {
  runway: {
    'gen4.5': { capabilities: videoCapabilities(['text_to_video', 'image_to_video'], 2, 10, ['720p'], ['16:9', '9:16'], false, 3_900_000) },
    gen4_turbo: { capabilities: videoCapabilities(['image_to_video'], 2, 10, ['720p'], ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], false, 3_900_000) },
  },
  veo: {
    'veo-3.1-generate-preview': { capabilities: videoCapabilities(['text_to_video', 'image_to_video'], 4, 8, ['720p', '1080p'], ['16:9', '9:16'], true, 20 * 1024 * 1024, [4, 6, 8]) },
    'veo-3.1-fast-generate-preview': { capabilities: videoCapabilities(['text_to_video', 'image_to_video'], 4, 8, ['720p', '1080p'], ['16:9', '9:16'], true, 20 * 1024 * 1024, [4, 6, 8]) },
  },
};

function videoCapabilities(
  generationModes: Array<'text_to_video' | 'image_to_video'>,
  minDurationSeconds: number,
  maxDurationSeconds: number,
  resolutions: string[],
  aspectRatios: string[],
  generateAudio: boolean,
  maxFirstFrameBytes: number,
  allowedDurationsSeconds?: number[],
): ServiceCapabilities {
  return {
    inputs: generationModes.includes('image_to_video') ? ['text', 'image'] : ['text'],
    outputs: ['video'],
    supportedParameters: ['duration_seconds', 'aspect_ratio', 'resolution', 'generate_audio', 'output_format'],
    video: {
      generationModes, minDurationSeconds, maxDurationSeconds, resolutions, aspectRatios,
      generateAudio, outputFormats: ['mp4'], maxFirstFrameBytes,
      ...(allowedDurationsSeconds ? { allowedDurationsSeconds } : {}),
    },
  };
}

function videoBillingModel(perVideoInput: string, perSecondInput: string): UnitBillingModelV1 {
  const perVideo = perVideoInput.trim() ? Number(perVideoInput) : 0;
  const perSecond = Number(perSecondInput);
  if (!Number.isFinite(perVideo) || perVideo < 0) throw new Error('Fixed video price must be a non-negative number');
  if (!Number.isFinite(perSecond) || perSecond < 0) throw new Error('Per-second video price must be a non-negative number');
  if (perVideo === 0 && perSecond === 0) throw new Error('At least one video price must be greater than zero');
  return {
    version: 1,
    components: [
      ...(perVideo > 0 ? [{ unit: 'output_videos' as const, priceUsd: perVideo }] : []),
      ...(perSecond > 0 ? [{ unit: 'output_video_seconds' as const, priceUsd: perSecond }] : []),
    ],
  };
}

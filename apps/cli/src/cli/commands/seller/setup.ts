import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'node:readline/promises';
import { loadOrCreateIdentity } from '@antseed/node';
import { checkSellerReadiness } from '@antseed/node/payments';
import { getGlobalOptions } from '../types.js';
import { loadConfig, saveConfig } from '../../../config/loader.js';
import { assertValidConfig } from '../../../config/validation.js';
import { TRUSTED_PLUGINS } from '../../../plugins/registry.js';
import { installPlugin } from '../../../plugins/manager.js';
import type { SellerProviderConfig, SellerServiceConfig } from '../../../config/types.js';
import { createIdentityClient, createStakingClient } from '../../payment-utils.js';

export function buildSellerSetupProviderEntry(input: {
  plugin: string;
  baseUrl?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  services?: Record<string, SellerServiceConfig>;
}): SellerProviderConfig {
  const hasDefaults = input.inputUsdPerMillion !== undefined || input.outputUsdPerMillion !== undefined;
  return {
    plugin: input.plugin,
    services: input.services ?? {},
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
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
      const rl = createInterface({ input: process.stdin, output: process.stdout });

      try {
        console.log(chalk.bold('\nAntSeed Seller Setup\n'));

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

        const inputStr = await rl.question('Default input price (USD per 1M tokens): ');
        const outputStr = await rl.question('Default output price (USD per 1M tokens): ');
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
        const services: Record<string, SellerServiceConfig> = {};
        let addMore = true;
        while (addMore) {
          const serviceIdInput = await rl.question('Service ID (e.g., claude-sonnet-4-6, gpt-4o): ');
          const serviceId = serviceIdInput.trim();
          if (!serviceId) break;

          const upstreamInput = await rl.question(`Upstream model [${serviceId}]: `);
          const svcInputStr = await rl.question('Input price (USD/1M, or enter for provider default): ');
          const svcOutputStr = await rl.question('Output price (USD/1M, or enter for provider default): ');
          const categoriesStr = await rl.question('Categories (comma-separated, e.g., chat,coding): ');

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

          services[serviceId] = service;
          console.log(chalk.green(`  Added: ${serviceId}`));

          const moreInput = await rl.question('\nAdd another service? (y/N): ');
          addMore = moreInput.trim().toLowerCase() === 'y';
        }

        const providerEntry = buildSellerSetupProviderEntry({
          plugin: pluginName,
          baseUrl,
          inputUsdPerMillion: inputUsd,
          outputUsdPerMillion: outputUsd,
          services,
        });

        config.seller.providers[providerName] = providerEntry;
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

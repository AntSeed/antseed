import type { Command } from 'commander';
import chalk from 'chalk';
import { getGlobalOptions } from './types.js';
import { loadConfig, saveConfig } from '../../config/loader.js';
import type { AntseedConfig, ProviderConfig, ProviderType } from '../../config/types.js';
import { assertValidConfig } from '../../config/validation.js';

/**
 * Register the `antseed config` command and its subcommands.
 */
export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Manage Antseed configuration');

  // antseed config show
  configCmd
    .command('show')
    .description('Display current configuration (credentials redacted)')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);
      const redacted = redactConfig(config);
      console.log(JSON.stringify(redacted, null, 2));
    });

  // antseed config set <key> <value>
  configCmd
    .command('set <key> <value>')
    .description('Set a configuration value (e.g., seller.reserveFloor 20)')
    .action(async (key: string, value: string) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const config = await loadConfig(globalOpts.config);
        const validKeys = getValidConfigKeys(config);
        if (!validKeys.includes(key)) {
          console.error(chalk.red(`Invalid config key: ${key}`));
          console.error(chalk.dim(`Available keys: ${validKeys.join(', ')}`));
          process.exitCode = 1;
          return;
        }
        setConfigValue(config as unknown as Record<string, unknown>, key, value);
        assertValidConfig(config);
        await saveConfig(globalOpts.config, config);
        console.log(chalk.green(`Set ${key} = ${value}`));
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  const sellerCmd = configCmd
    .command('seller')
    .description('Role-scoped seller configuration commands');

  sellerCmd
    .command('show')
    .description('Display seller configuration')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);
      console.log(JSON.stringify(config.seller, null, 2));
    });

  sellerCmd
    .command('set <key> <value>')
    .description('Set seller configuration value (e.g., pricing.defaults.inputUsdPerMillion 12)')
    .action(async (key: string, value: string) => {
      await setRoleScopedValue(program, 'seller', key, value);
    });

  const buyerCmd = configCmd
    .command('buyer')
    .description('Role-scoped buyer configuration commands');

  buyerCmd
    .command('show')
    .description('Display buyer configuration')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);
      console.log(JSON.stringify(config.buyer, null, 2));
    });

  buyerCmd
    .command('set <key> <value>')
    .description('Set buyer configuration value (e.g., maxPricing.defaults.inputUsdPerMillion 25)')
    .action(async (key: string, value: string) => {
      await setRoleScopedValue(program, 'buyer', key, value);
    });

  // antseed config add-provider
  configCmd
    .command('add-provider')
    .description('Add a new provider credential')
    .requiredOption('-t, --type <type>', 'provider type (anthropic, openai, google, moonshot)')
    .requiredOption('-k, --key <key>', 'API key or auth token')
    .option('-e, --endpoint <url>', 'custom API endpoint URL')
    .action(async (options) => {
      const knownTypes = ['anthropic', 'openai', 'google', 'moonshot'];
      if (!knownTypes.includes(options.type as string)) {
        console.error(chalk.red(`Unknown provider type: ${options.type as string}`));
        console.error(chalk.dim(`Known types: ${knownTypes.join(', ')}`));
        process.exitCode = 1;
        return;
      }
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);
      const provider = buildProviderConfig(
        options.type as ProviderType,
        options.key as string,
        options.endpoint as string | undefined
      );
      config.providers.push(provider);
      await saveConfig(globalOpts.config, config);
      console.log(chalk.green(`Added ${options.type as string} provider`));
    });

  // antseed config remove-provider <type>
  configCmd
    .command('remove-provider <type>')
    .description('Remove a provider credential by type')
    .action(async (type: string) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);
      const before = config.providers.length;
      config.providers = config.providers.filter((p) => p.type !== type);
      const removed = before - config.providers.length;
      await saveConfig(globalOpts.config, config);
      if (removed > 0) {
        console.log(chalk.green(`Removed ${removed} ${type} provider(s)`));
      } else {
        console.log(chalk.yellow(`No ${type} provider found`));
      }
    });

  // antseed config init
  configCmd
    .command('init')
    .description('Initialize a new config file with defaults')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const { createDefaultConfig } = await import('../../config/defaults.js');
      const config = createDefaultConfig();
      await saveConfig(globalOpts.config, config);
      console.log(chalk.green(`Config initialized at ${globalOpts.config}`));
    });
}

/**
 * Redact sensitive fields (auth values) from config for display.
 */
export function redactConfig(config: AntseedConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const providers = clone['providers'] as Array<Record<string, unknown>> | undefined;
  for (const provider of providers ?? []) {
    if (provider['authValue']) {
      const val = provider['authValue'] as string;
      provider['authValue'] = val.slice(0, 8) + '...' + val.slice(-4);
    }
  }

  return clone;
}

/**
 * Set a nested config value by dot-separated key path.
 * @example setConfigValue(config, 'seller.reserveFloor', '20')
 */
export function setConfigValue(config: Record<string, unknown>, key: string, value: string): void {
  const parts = key.split('.');
  let current: Record<string, unknown> = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== 'object' || current[part] === null) {
      throw new Error(`Invalid config key: ${key}`);
    }
    current = current[part] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1]!;
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      current[lastKey] = JSON.parse(trimmed) as unknown;
      return;
    } catch {
      throw new Error(`Invalid JSON value for ${key}`);
    }
  }

  // Auto-parse numeric scalars
  const numVal = Number(trimmed);
  current[lastKey] = Number.isNaN(numVal) ? value : numVal;
}

function getValidConfigKeys(config: AntseedConfig, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(config)) {
    if (k === 'providers' || k === 'plugins') continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...getValidConfigKeys(v as unknown as AntseedConfig, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

async function setRoleScopedValue(
  program: Command,
  role: 'seller' | 'buyer',
  key: string,
  value: string,
): Promise<void> {
  try {
    const globalOpts = getGlobalOptions(program);
    const config = await loadConfig(globalOpts.config);
    const fullKey = `${role}.${key}`;
    const validKeys = getValidConfigKeys(config);
    if (!validKeys.includes(fullKey)) {
      console.error(chalk.red(`Invalid ${role} config key: ${key}`));
      const scopedKeys = validKeys
        .filter((path) => path.startsWith(`${role}.`))
        .map((path) => path.slice(role.length + 1));
      console.error(chalk.dim(`Available ${role} keys: ${scopedKeys.join(', ')}`));
      process.exitCode = 1;
      return;
    }
    setConfigValue(config as unknown as Record<string, unknown>, fullKey, value);
    assertValidConfig(config);
    await saveConfig(globalOpts.config, config);
    console.log(chalk.green(`Set ${fullKey} = ${value}`));
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exitCode = 1;
  }
}

/**
 * Build a ProviderConfig with default endpoint and auth header for known providers.
 */
export function buildProviderConfig(
  type: ProviderType,
  authValue: string,
  customEndpoint?: string
): ProviderConfig {
  const defaults: Record<string, { endpoint: string; authHeaderName: string }> = {
    anthropic: { endpoint: 'https://api.anthropic.com', authHeaderName: 'x-api-key' },
    openai: { endpoint: 'https://api.openai.com', authHeaderName: 'Authorization' },
    google: { endpoint: 'https://generativelanguage.googleapis.com', authHeaderName: 'x-goog-api-key' },
    moonshot: { endpoint: 'https://api.moonshot.cn', authHeaderName: 'Authorization' },
  };

  const fallbackDefaults = {
    endpoint: customEndpoint ?? '',
    authHeaderName: 'Authorization',
  };
  const def = defaults[type] ?? fallbackDefaults;

  return {
    type,
    endpoint: customEndpoint ?? def.endpoint,
    authHeaderName: def.authHeaderName,
    authValue,
  };
}

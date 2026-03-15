import type { Command } from 'commander';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** All command registration functions follow this signature */
export type RegisterCommandFn = (program: Command) => void;

/** Global CLI options available to all commands */
export interface GlobalOptions {
  config: string;
  dataDir: string;
  verbose: boolean;
}

const NEW_HOME_DIR = join(homedir(), '.antseed');
const NEW_CONFIG_PATH = join(NEW_HOME_DIR, 'config.json');

function resolvePathWithHome(pathLike: string, fallbackAbsolutePath: string): string {
  const raw = typeof pathLike === 'string' ? pathLike.trim() : '';
  if (raw.length === 0) {
    return fallbackAbsolutePath;
  }
  if (raw === '~') {
    return homedir();
  }
  if (raw.startsWith('~/')) {
    return join(homedir(), raw.slice(2));
  }
  return resolve(raw);
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Extract global options from the Commander program instance.
 */
export function getGlobalOptions(program: Command): GlobalOptions {
  const opts = program.opts();
  const verbose = opts['verbose'] ?? false;
  if (verbose || isTruthyEnv(process.env['ANTSEED_DEBUG'])) {
    process.env['ANTSEED_DEBUG'] = '1';
  }

  const requestedConfig = resolvePathWithHome(
    opts['config'] ?? process.env['ANTSEED_CONFIG'] ?? '~/.antseed/config.json',
    NEW_CONFIG_PATH,
  );
  const requestedDataDir = resolvePathWithHome(
    opts['dataDir'] ?? process.env['ANTSEED_DATA_DIR'] ?? '~/.antseed',
    NEW_HOME_DIR,
  );

  return {
    config: requestedConfig,
    dataDir: requestedDataDir,
    verbose,
  };
}

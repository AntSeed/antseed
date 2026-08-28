import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const migrationsDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationFilePattern = /^m\d{3}\.mjs$/;

export function buildMigrationRegistry(migrations) {
  const registry = new Map();
  for (const migration of migrations) {
    if (!/^M\d{3}$/.test(migration?.id ?? '')) {
      throw new Error(`Invalid deployment migration ID: ${migration?.id ?? '<missing>'}`);
    }
    if (typeof migration.run !== 'function') {
      throw new Error(`${migration.id} must export a run function`);
    }
    if (!Array.isArray(migration.phases) || migration.phases.length === 0) {
      throw new Error(`${migration.id} must declare at least one phase`);
    }
    for (const phase of migration.phases) {
      if (!phase?.id || typeof phase.guard !== 'function' || typeof phase.run !== 'function') {
        throw new Error(`${migration.id} phases require an id, a guard, and a run function`);
      }
    }
    if (!Array.isArray(migration.releases) || migration.releases.length === 0) {
      throw new Error(`${migration.id} must declare the releases it writes`);
    }
    if (registry.has(migration.id)) throw new Error(`Duplicate deployment migration: ${migration.id}`);
    registry.set(migration.id, migration);
  }
  return registry;
}

async function discoverMigrations() {
  const files = (await readdir(migrationsDirectory)).filter((file) => migrationFilePattern.test(file)).sort();
  const modules = await Promise.all(files.map((file) => import(pathToFileURL(path.join(migrationsDirectory, file)))));
  return buildMigrationRegistry(modules.map((module) => module.migration));
}

export const deploymentMigrations = await discoverMigrations();

export function parseDeployArgs(args, registry = deploymentMigrations) {
  const options = { migration: null, network: null, mode: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      continue;
    } else if (!argument.startsWith('--') && options.migration === null) {
      options.migration = argument.toUpperCase();
    } else if (argument === '--network') {
      options.network = args[++index] ?? null;
    } else if (['--dry-run', '--broadcast', '--fork-test'].includes(argument)) {
      if (options.mode !== null) throw new Error('Choose exactly one of --dry-run, --broadcast, or --fork-test');
      options.mode = argument.slice(2);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const migration = registry.get(options.migration);
  if (!migration) {
    const available = [...registry.keys()].join(', ') || 'none';
    throw new Error(`Unknown deployment migration ${options.migration ?? '<missing>'}; available: ${available}`);
  }
  if (!options.network) throw new Error('--network is required');
  if (!options.mode) throw new Error('Choose exactly one of --dry-run, --broadcast, or --fork-test');
  migration.validateOptions?.(options);
  return options;
}

/** Maps every declared release back to the migration that owns it. */
export function buildReleaseOwners(registry = deploymentMigrations) {
  const owners = new Map();
  for (const migration of registry.values()) {
    for (const release of migration.releases) {
      if (owners.has(release)) {
        throw new Error(`Release ${release} is claimed by ${owners.get(release).id} and ${migration.id}`);
      }
      owners.set(release, migration);
    }
  }
  return owners;
}

export function getDeploymentMigration(id, registry = deploymentMigrations) {
  const migration = registry.get(id);
  if (!migration) throw new Error(`Deployment migration ${id} is not registered`);
  return migration;
}

#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..');
const markerPath = path.resolve(desktopDir, '.runtime-native-meta.json');
const runtimeInfo = {
  nodeExec: process.execPath,
  nodeArch: process.arch,
  nodeVersion: process.version,
};

const moduleChecks = [
  {
    label: 'better-sqlite3',
    packageDir: path.resolve(repoRoot, 'node'),
    packageJson: path.resolve(repoRoot, 'node', 'package.json'),
    moduleName: 'better-sqlite3',
  },
  {
    label: 'keytar',
    packageDir: path.resolve(repoRoot, 'provider-anthropic'),
    packageJson: path.resolve(repoRoot, 'provider-anthropic', 'package.json'),
    moduleName: 'keytar',
  },
];

function readMarker() {
  if (!existsSync(markerPath)) return null;
  try {
    const raw = readFileSync(markerPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function markerMatches(marker) {
  return marker?.nodeExec === runtimeInfo.nodeExec
    && marker?.nodeArch === runtimeInfo.nodeArch
    && marker?.nodeVersion === runtimeInfo.nodeVersion;
}

function writeMarker() {
  writeFileSync(
    markerPath,
    JSON.stringify({ ...runtimeInfo, updatedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

function loadModule(check) {
  if (!existsSync(check.packageJson)) {
    return { ok: false, reason: 'package.json missing' };
  }

  try {
    const packageRequire = createRequire(check.packageJson);
    const loaded = packageRequire(check.moduleName);
    if (check.moduleName === 'better-sqlite3') {
      const db = new loaded(':memory:');
      db.close();
    }
    return { ok: true, reason: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message };
  }
}

function resolveNpmCli() {
  const envNpmExecPath = process.env.npm_execpath;
  if (envNpmExecPath && existsSync(envNpmExecPath)) {
    return envNpmExecPath;
  }

  try {
    const resolved = execFileSync(
      process.execPath,
      ['-p', "require.resolve('npm/bin/npm-cli.js')"],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (resolved.length > 0 && existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // fall through
  }

  try {
    const prefix = execFileSync(
      'npm',
      ['config', 'get', 'prefix'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const fromPrefix = path.resolve(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(fromPrefix)) {
      return fromPrefix;
    }
  } catch {
    // fall through
  }

  const commonCandidates = [
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of commonCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return '';
}

function rebuildModule(check) {
  const npmCli = resolveNpmCli();
  if (!existsSync(npmCli)) {
    throw new Error(`Unable to locate npm-cli.js for runtime ${process.execPath}`);
  }

  execFileSync(
    process.execPath,
    [npmCli, 'rebuild', check.moduleName, '--build-from-source'],
    {
      cwd: check.packageDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        npm_config_arch: process.arch,
        npm_config_build_from_source: 'true',
      },
    },
  );
}

const marker = readMarker();
if (markerMatches(marker)) {
  const quickCheck = moduleChecks.every((check) => {
    const loaded = loadModule(check);
    return loaded.ok;
  });
  if (quickCheck) {
    console.log(`[runtime-native] already aligned for ${runtimeInfo.nodeVersion} (${runtimeInfo.nodeArch}).`);
    process.exit(0);
  }
}

for (const check of moduleChecks) {
  const initial = loadModule(check);
  if (initial.ok) {
    continue;
  }

  console.log(`[runtime-native] rebuilding ${check.label} for ${runtimeInfo.nodeVersion} (${runtimeInfo.nodeArch})...`);
  rebuildModule(check);
  const after = loadModule(check);
  if (!after.ok) {
    throw new Error(`[runtime-native] ${check.label} still failed to load after rebuild: ${after.reason}`);
  }
}

writeMarker();
console.log(`[runtime-native] runtime native modules aligned (${runtimeInfo.nodeVersion}, ${runtimeInfo.nodeArch}).`);

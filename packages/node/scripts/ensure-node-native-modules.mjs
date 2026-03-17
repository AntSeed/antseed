#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const nodePackageDir = path.resolve(__dirname, '..');
const packageJsonPath = path.resolve(nodePackageDir, 'package.json');
const markerPath = path.resolve(nodePackageDir, 'node_modules', 'better-sqlite3', '.node-runtime-meta.json');
const runtime = {
  nodeExec: process.execPath,
  nodeArch: process.arch,
  nodeVersion: process.version,
};

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
  return marker?.nodeExec === runtime.nodeExec
    && marker?.nodeArch === runtime.nodeArch
    && marker?.nodeVersion === runtime.nodeVersion;
}

function writeMarker() {
  writeFileSync(
    markerPath,
    JSON.stringify({ ...runtime, updatedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

function loadBetterSqlite3() {
  try {
    const req = createRequire(packageJsonPath);
    const Database = req('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
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
    const prefixCandidates = process.platform === 'win32'
      ? [
          path.resolve(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          path.resolve(prefix, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ]
      : [path.resolve(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
    for (const candidate of prefixCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // fall through
  }

  const commonCandidates = process.platform === 'win32'
    ? [
        path.resolve(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.resolve(path.dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
    : [
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

function rebuildBetterSqlite3() {
  const npmCli = resolveNpmCli();
  if (!existsSync(npmCli)) {
    throw new Error(`Unable to locate npm-cli.js for runtime ${process.execPath}`);
  }

  execFileSync(
    process.execPath,
    [npmCli, 'rebuild', 'better-sqlite3', '--build-from-source'],
    {
      cwd: nodePackageDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        npm_config_arch: process.arch,
        npm_config_build_from_source: 'true',
      },
    },
  );
}

if (!existsSync(path.resolve(nodePackageDir, 'node_modules', 'better-sqlite3'))) {
  console.log('[native] better-sqlite3 not installed; skipping.');
  process.exit(0);
}

const marker = readMarker();
if (markerMatches(marker)) {
  const loaded = loadBetterSqlite3();
  if (loaded.ok) {
    console.log(`[native] better-sqlite3 already aligned for Node ${runtime.nodeVersion} (${runtime.nodeArch}).`);
    process.exit(0);
  }
}

const before = loadBetterSqlite3();
if (!before.ok) {
  console.log(`[native] rebuilding better-sqlite3 for Node ${runtime.nodeVersion} (${runtime.nodeArch})...`);
  rebuildBetterSqlite3();
}

const after = loadBetterSqlite3();
if (!after.ok) {
  throw new Error(`[native] better-sqlite3 failed to load after rebuild: ${after.reason}`);
}

writeMarker();
console.log('[native] better-sqlite3 runtime alignment complete.');

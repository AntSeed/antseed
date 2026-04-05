/**
 * Replace pnpm workspace symlinks in node_modules with real copies
 * so electron-builder can pack them into the asar archive.
 *
 * Also bundles the CLI into a single self-contained file for extraResources.
 * Bundling (esbuild) instead of copying tsc output means the child process
 * has no external JS dependencies — native modules are marked external and
 * resolved via NODE_PATH pointing to app.asar.unpacked/node_modules/.
 *
 * pnpm links workspace packages as symlinks pointing outside the app
 * directory, which causes electron-builder's asar packer to fail with
 * "must be under <appDir>" errors.
 *
 * Handles both top-level packages (e.g. antseed-dashboard) and scoped
 * packages (e.g. @antseed/node).
 */

import { readdirSync, lstatSync, readlinkSync, rmSync, cpSync, existsSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const appDir = path.resolve(__dirname, '..');
const nmDir = path.join(appDir, 'node_modules');

function isWorkspaceSymlink(fullPath) {
  try {
    if (!lstatSync(fullPath).isSymbolicLink()) return false;
    const target = readlinkSync(fullPath);
    // Workspace symlinks are relative and point outside node_modules
    return !target.includes('node_modules');
  } catch {
    return false;
  }
}

function replaceSymlink(linkPath, label) {
  const realPath = path.resolve(path.dirname(linkPath), readlinkSync(linkPath));
  console.log(`[prepare-dist] Replacing symlink: ${label} -> ${realPath}`);
  rmSync(linkPath, { recursive: true });
  cpSync(realPath, linkPath, { recursive: true });

  // Remove inner node_modules — the copied package's deps are already
  // hoisted into the desktop's own node_modules by pnpm.
  const innerNm = path.join(linkPath, 'node_modules');
  if (existsSync(innerNm)) {
    rmSync(innerNm, { recursive: true });
  }
}

// --- 1. Replace workspace symlinks in node_modules ---

const entries = readdirSync(nmDir);
for (const entry of entries) {
  const fullPath = path.join(nmDir, entry);

  // Handle scoped packages (@scope/name)
  if (entry.startsWith('@') && lstatSync(fullPath).isDirectory()) {
    const scopeDir = fullPath;
    const scopeEntries = readdirSync(scopeDir);
    for (const scopeEntry of scopeEntries) {
      const scopedPath = path.join(scopeDir, scopeEntry);
      if (isWorkspaceSymlink(scopedPath)) {
        replaceSymlink(scopedPath, `${entry}/${scopeEntry}`);
      }
    }
    continue;
  }

  // Handle top-level packages
  if (isWorkspaceSymlink(fullPath)) {
    replaceSymlink(fullPath, entry);
  }
}

// --- 2. Bundle CLI into a single self-contained file for extraResources ---

const cliDir = path.resolve(appDir, '..', 'cli');
const cliDestDir = path.join(appDir, 'cli-dist');
const bundleOutput = path.join(cliDestDir, 'cli', 'index.js');
const esbuildEntry = require.resolve('esbuild/bin/esbuild');

if (existsSync(cliDestDir)) {
  rmSync(cliDestDir, { recursive: true });
}
mkdirSync(path.dirname(bundleOutput), { recursive: true });

console.log('[prepare-dist] Bundling CLI with esbuild...');
execFileSync(esbuildEntry, [
  'src/cli/index.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${bundleOutput}`,
  '--external:better-sqlite3',
  '--external:node-datachannel',
  '--external:koffi',
  '--external:keytar',
  '--define:import.meta.url=__importMetaUrl',
  '--banner:js=const __importMetaUrl=require("url").pathToFileURL(__filename).href;',
], { cwd: cliDir, stdio: 'inherit' });

chmodSync(bundleOutput, 0o755);

// Write a package.json with "type":"commonjs" so Node treats the CJS bundle
// correctly regardless of whether the parent directory has "type":"module".
writeFileSync(
  path.join(cliDestDir, 'package.json'),
  JSON.stringify({ name: 'antseed-cli-bundled', version: '1.0.0', type: 'commonjs' }, null, 2),
);

console.log(`[prepare-dist] Bundled CLI -> ${bundleOutput}`);

// --- 3. Install Electron-compatible native module prebuilds ---
// The native modules (better-sqlite3, etc.) may have been compiled for the
// system node version, which differs from Electron's bundled node.
// prebuild-install fetches the correct prebuilt binary for Electron's ABI.

const electronPkg = JSON.parse(
  readFileSync(path.resolve(appDir, '..', '..', 'node_modules', 'electron', 'package.json'), 'utf8'),
);
const electronVersion = electronPkg.version;
const betterSqlite3Dir = path.resolve(appDir, '..', '..', 'node_modules', 'better-sqlite3');

// Install the prebuild for the current arch — electron-builder handles
// cross-arch builds by running the pack step separately for each arch,
// and better-sqlite3 prebuilds are arch-specific.
console.log(`[prepare-dist] Installing better-sqlite3 prebuild for Electron ${electronVersion} (${process.arch})...`);
execFileSync('npx', [
  'prebuild-install',
  '--runtime', 'electron',
  '--target', electronVersion,
  '--arch', process.arch,
  '--verbose',
], { cwd: betterSqlite3Dir, stdio: 'inherit' });
console.log('[prepare-dist] Native module prebuild installed for Electron.');

console.log('[prepare-dist] Done.');

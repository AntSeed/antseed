/**
 * Replace pnpm workspace symlinks in node_modules with real copies
 * so electron-builder can pack them into the asar archive.
 *
 * Also copies the CLI dist into cli-dist/ so it can be included as
 * an extraResource for spawning child processes.
 *
 * pnpm links workspace packages as symlinks pointing outside the app
 * directory, which causes electron-builder's asar packer to fail with
 * "must be under <appDir>" errors.
 *
 * Handles both top-level packages (e.g. antseed-dashboard) and scoped
 * packages (e.g. @antseed/node).
 */

import { readdirSync, lstatSync, readlinkSync, rmSync, cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

// --- 2. Copy CLI dist for extraResources ---

const cliSrcDir = path.resolve(appDir, '..', 'cli', 'dist');
const cliDestDir = path.join(appDir, 'cli-dist');

if (existsSync(cliSrcDir)) {
  if (existsSync(cliDestDir)) {
    rmSync(cliDestDir, { recursive: true });
  }
  cpSync(cliSrcDir, cliDestDir, { recursive: true });
  console.log(`[prepare-dist] Copied CLI dist -> ${cliDestDir}`);
} else {
  console.warn(`[prepare-dist] WARNING: CLI dist not found at ${cliSrcDir}. Build the CLI first.`);
}

console.log('[prepare-dist] Done.');

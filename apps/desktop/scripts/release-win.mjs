// Loads .env and spawns electron-builder --win --publish always.
// Used by the release:win script so pnpm can resolve electron-builder
// from the workspace root node_modules.
//
// Must be run on Windows. Unlike macOS, there is no notarization step.
// Code signing is optional: if CSC_LINK + CSC_KEY_PASSWORD are set in
// apps/desktop/.env, electron-builder will sign the NSIS installer.
// Without them, the installer is unsigned and users will see a
// SmartScreen warning on first run.

import { config } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

config(); // loads apps/desktop/.env (GH_TOKEN, optional CSC_*)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

// electron-builder is hoisted to workspace root node_modules by pnpm.
// On Windows the executable is electron-builder.cmd; pnpm also drops a
// shim without extension, but execFileSync on win32 needs the .cmd.
const isWin = process.platform === 'win32';
const binName = isWin ? 'electron-builder.cmd' : 'electron-builder';
const binPath = path.resolve(desktopDir, '../../node_modules/.bin/', binName);

execFileSync(binPath, ['--win', '--publish', 'always'], {
  stdio: 'inherit',
  env: process.env,
  cwd: desktopDir,
  shell: isWin, // .cmd requires shell on win32
});

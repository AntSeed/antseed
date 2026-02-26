// Loads .env and spawns electron-builder --mac --publish always.
// Used by the release:mac script so pnpm can resolve electron-builder
// from the workspace root node_modules.

import { config } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

config(); // loads apps/desktop/.env (APPLE_* and GH_TOKEN)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

// electron-builder is hoisted to workspace root node_modules by pnpm
const binPath = path.resolve(desktopDir, '../../node_modules/.bin/electron-builder');

execFileSync(binPath, ['--mac', '--publish', 'always'], {
  stdio: 'inherit',
  env: process.env,
  cwd: desktopDir,
});

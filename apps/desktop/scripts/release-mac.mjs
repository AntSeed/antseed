// Runs prepare-dist + electron-builder once per arch so each DMG contains
// the matching arch's native binaries.

import { config } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const releaseDir = path.resolve(desktopDir, 'release');

const electronBuilderBin = path.resolve(desktopDir, '../../node_modules/.bin/electron-builder');
const prepareDistScript = path.resolve(desktopDir, 'scripts', 'prepare-dist.mjs');

const publish = process.argv.includes('--no-publish') ? 'never' : 'always';

for (const arch of ['x64', 'arm64']) {
  console.log(`\n=== [release-mac] arch=${arch} publish=${publish} ===`);
  const env = { ...process.env, ANTSEED_PACK_ARCH: arch };

  // Wipe any prior arch's output so its artifacts can't get re-uploaded
  // by the next electron-builder run.
  rmSync(releaseDir, { recursive: true, force: true });

  execFileSync(process.execPath, [prepareDistScript], { stdio: 'inherit', cwd: desktopDir, env });
  execFileSync(electronBuilderBin, ['--mac', `--${arch}`, '--publish', publish], { stdio: 'inherit', cwd: desktopDir, env });
}

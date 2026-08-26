// Builds and publishes both mac arches in ONE electron-builder invocation.
// scripts/before-pack.js runs prepare-dist per arch as each app is packed,
// so every DMG/zip still gets matching-arch native modules.
//
// A single invocation matters for auto-updates: electron-builder generates
// one latest-mac.yml listing both arches' artifacts. The previous release
// flow ran electron-builder once per arch, and the second (arm64) pass
// uploaded a channel file containing only arm64 entries — clobbering the
// x64 one. electron-updater picks the file whose name contains
// process.arch and otherwise falls back to the FIRST entry, so Intel
// machines were handed the arm64 zip and updates silently broke.

import { config } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const releaseDir = path.resolve(desktopDir, 'release');

const electronBuilderBin = path.resolve(desktopDir, '../../node_modules/.bin/electron-builder');

const publish = process.argv.includes('--no-publish') ? 'never' : 'always';

rmSync(releaseDir, { recursive: true, force: true });

console.log(`\n=== [release-mac] x64 + arm64, publish=${publish} ===`);
execFileSync(electronBuilderBin, ['--mac', '--x64', '--arm64', '--publish', publish], {
  stdio: 'inherit',
  cwd: desktopDir,
});

// Safety net: the x64 zip/dmg carry no arch marker in their names, so
// electron-updater on Intel relies on the first-file fallback. Fail loudly
// if the generated channel file ever lists an arm64 artifact first.
const channel = parse(readFileSync(path.join(releaseDir, 'latest-mac.yml'), 'utf8'));
const urls = (channel.files ?? []).map((file) => file.url);
if (urls.length < 4 || /arm64/i.test(urls[0])) {
  throw new Error(`[release-mac] Unexpected latest-mac.yml file order/content: ${urls.join(', ')}`);
}
console.log(`[release-mac] latest-mac.yml lists ${urls.length} files, x64 first: ${urls.join(', ')}`);

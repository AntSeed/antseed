// Builds both mac arches in ONE electron-builder invocation, validates the
// combined update channel, then publishes the verified artifacts with gh.
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
import { prepareMacReleaseArtifacts } from './mac-update-channel.mjs';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const releaseDir = path.resolve(desktopDir, 'release');

const electronBuilderBin = path.resolve(desktopDir, '../../node_modules/.bin/electron-builder');
const packageJson = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));

const shouldPublish = !process.argv.includes('--no-publish');

rmSync(releaseDir, { recursive: true, force: true });

console.log(`\n=== [release-mac] x64 + arm64, publish=${shouldPublish ? 'after validation' : 'never'} ===`);
execFileSync(electronBuilderBin, ['--mac', '--x64', '--arm64', '--publish', 'never'], {
  stdio: 'inherit',
  cwd: desktopDir,
});

// Normalize and validate before any artifact is uploaded. The x64 zip carries
// no arch marker, so keep it first and update the legacy path/sha512 fields to
// match it. Both architecture-specific zip and dmg files must be present.
const { channel, artifacts } = prepareMacReleaseArtifacts(releaseDir, path.join(releaseDir, 'latest-mac.yml'));
const urls = channel.files.map((file) => file.url);
console.log(`[release-mac] validated latest-mac.yml: ${urls.join(', ')}`);

if (shouldPublish) {
  const tag = `v${packageJson.version}`;
  try {
    execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore', cwd: desktopDir });
  } catch {
    execFileSync('gh', ['release', 'create', tag, '--draft', '--title', packageJson.version, '--notes', ''], {
      stdio: 'inherit',
      cwd: desktopDir,
    });
  }

  execFileSync('gh', ['release', 'upload', tag, ...artifacts, '--clobber'], {
    stdio: 'inherit',
    cwd: desktopDir,
  });
  console.log(`[release-mac] published ${artifacts.length} validated artifacts to ${tag}`);
}

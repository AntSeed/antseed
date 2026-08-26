// Runs prepare-dist + electron-builder once per arch so each DMG contains
// the matching arch's native binaries.
//
// latest-mac.yml gotcha: each electron-builder pass uploads a latest-mac.yml
// containing only its own arch's files, so the second (arm64) pass used to
// leave a channel file with no x64 entries. electron-updater picks the file
// whose URL contains process.arch and otherwise falls back to the FIRST
// entry — so Intel machines were handed the arm64 zip. After both passes we
// merge the two channel files (x64 entries first, so the no-arch-in-name x64
// zip wins the fallback) and replace the uploaded asset.

import { config } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const releaseDir = path.resolve(desktopDir, 'release');

const electronBuilderBin = path.resolve(desktopDir, '../../node_modules/.bin/electron-builder');
const prepareDistScript = path.resolve(desktopDir, 'scripts', 'prepare-dist.mjs');

const publish = process.argv.includes('--no-publish') ? 'never' : 'always';

const channelFiles = {};

for (const arch of ['x64', 'arm64']) {
  console.log(`\n=== [release-mac] arch=${arch} publish=${publish} ===`);
  const env = { ...process.env, ANTSEED_PACK_ARCH: arch };

  // Wipe any prior arch's output so its artifacts can't get re-uploaded
  // by the next electron-builder run.
  rmSync(releaseDir, { recursive: true, force: true });

  execFileSync(process.execPath, [prepareDistScript], { stdio: 'inherit', cwd: desktopDir, env });
  execFileSync(electronBuilderBin, ['--mac', `--${arch}`, '--publish', publish], { stdio: 'inherit', cwd: desktopDir, env });

  channelFiles[arch] = parse(readFileSync(path.join(releaseDir, 'latest-mac.yml'), 'utf8'));
}

if (publish === 'always') {
  await replaceChannelFile(mergeChannelFiles(channelFiles.x64, channelFiles.arm64));
}

function mergeChannelFiles(x64, arm64) {
  const seen = new Set();
  // x64 first: electron-updater falls back to files[0] when no entry name
  // matches process.arch, and the x64 artifacts carry no arch marker.
  const files = [...(x64.files ?? []), ...(arm64.files ?? [])].filter((file) => {
    if (seen.has(file.url)) return false;
    seen.add(file.url);
    return true;
  });
  return { ...arm64, ...x64, files };
}

async function replaceChannelFile(merged) {
  const owner = 'AntSeed';
  const repo = 'antseed';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('[release-mac] GH_TOKEN is required to fix up latest-mac.yml');

  const headers = {
    authorization: `token ${token}`,
    accept: 'application/vnd.github+json',
  };
  const { version } = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  const tag = `v${version}`;

  // The release is usually still a draft, so look it up via the list endpoint
  // (GET by tag only returns published releases).
  const listRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`, { headers });
  if (!listRes.ok) throw new Error(`[release-mac] Listing releases failed: HTTP ${listRes.status}`);
  const release = (await listRes.json()).find((r) => r.tag_name === tag || r.name === version);
  if (!release) throw new Error(`[release-mac] No release found for ${tag}`);

  const existing = release.assets.find((asset) => asset.name === 'latest-mac.yml');
  if (existing) {
    const delRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${existing.id}`, {
      method: 'DELETE',
      headers,
    });
    if (!delRes.ok) throw new Error(`[release-mac] Deleting latest-mac.yml failed: HTTP ${delRes.status}`);
  }

  const body = stringify(merged, { lineWidth: 0 });
  const uploadUrl = release.upload_url.replace(/\{.*\}$/, '') + '?name=latest-mac.yml';
  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'text/yaml' },
    body,
  });
  if (!upRes.ok) throw new Error(`[release-mac] Uploading merged latest-mac.yml failed: HTTP ${upRes.status}`);
  console.log(`[release-mac] Replaced latest-mac.yml with merged x64+arm64 channel file (${merged.files.length} entries).`);
}

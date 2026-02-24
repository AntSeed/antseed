#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const APP_NAME = 'AntSeed Desktop';
const APP_BUNDLE_ID = 'com.antseed.desktop-dev';

function runPlistBuddy(plistPath, command) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plistPath], {
    stdio: 'ignore',
  });
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function setOrAddPlistKey(plistPath, key, value) {
  try {
    runPlistBuddy(plistPath, `Set :${key} ${quote(value)}`);
  } catch {
    runPlistBuddy(plistPath, `Add :${key} string ${quote(value)}`);
  }
}

function main() {
  if (process.platform !== 'darwin') {
    process.exit(0);
  }

  const distDir = path.resolve(process.cwd(), 'node_modules', 'electron', 'dist');
  const originalApp = path.join(distDir, 'Electron.app');
  const brandedApp = path.join(distDir, `${APP_NAME}.app`);

  // Determine which .app bundle currently exists
  const appDir = existsSync(brandedApp) ? brandedApp : existsSync(originalApp) ? originalApp : null;
  if (!appDir) {
    process.exit(0);
  }

  const plistPath = path.join(appDir, 'Contents', 'Info.plist');

  setOrAddPlistKey(plistPath, 'CFBundleName', APP_NAME);
  setOrAddPlistKey(plistPath, 'CFBundleDisplayName', APP_NAME);
  setOrAddPlistKey(plistPath, 'CFBundleIdentifier', APP_BUNDLE_ID);

  // Rename the .app bundle so macOS picks up the new name in dock / Cmd+Tab
  if (appDir === originalApp) {
    renameSync(originalApp, brandedApp);
  }

  // Update electron's path.txt so the `electron` CLI can find the renamed binary
  const pathTxt = path.resolve(process.cwd(), 'node_modules', 'electron', 'path.txt');
  writeFileSync(pathTxt, `${APP_NAME}.app/Contents/MacOS/Electron`, 'utf-8');
}

main();

#!/usr/bin/env node

import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0) {
  console.error('[fix-executable] No paths provided.');
  process.exit(1);
}

for (const rawArg of rawArgs) {
  const trimmed = rawArg.trim();
  if (trimmed.length === 0) {
    continue;
  }

  const target = path.resolve(process.cwd(), trimmed);
  if (!existsSync(target)) {
    continue;
  }

  try {
    chmodSync(target, 0o755);
    console.log(`[fix-executable] updated ${target}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[fix-executable] skipped ${target}: ${message}`);
  }
}

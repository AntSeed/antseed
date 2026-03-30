#!/usr/bin/env node

import { rmSync } from 'node:fs';
import path from 'node:path';

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0) {
  console.error('[remove-paths] No paths provided.');
  process.exit(1);
}

for (const rawArg of rawArgs) {
  const trimmed = rawArg.trim();
  if (trimmed.length === 0) {
    continue;
  }

  const target = path.resolve(process.cwd(), trimmed);
  rmSync(target, { recursive: true, force: true });
  console.log(`[remove-paths] removed ${target}`);
}

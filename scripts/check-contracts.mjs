#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseCommit = process.argv.slice(2).find((argument) => argument !== '--') ?? null;

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('forge', ['test'], {
  cwd: path.join(repositoryRoot, 'packages/contracts'),
  env: { FOUNDRY_PROFILE: 'ci' },
});
run('node', ['--test', 'scripts/deploy-contracts.test.mjs']);
run('node', ['scripts/validate-contract-deployments.mjs']);
run('node', ['scripts/verify-contract-bytecode.mjs']);
if (baseCommit) {
  run('node', ['scripts/check-contract-deployment-history.mjs', baseCommit]);
} else {
  console.log('\nAppend-only history check skipped; pass a base commit to enable it.');
}

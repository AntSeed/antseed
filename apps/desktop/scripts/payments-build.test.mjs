import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('desktop startup builds the payments frontend used by wallet authorization', () => {
  assert.ok(scripts['ensure:cli-dist'].split(' && ').includes('pnpm -C ../payments build'));
  for (const hook of ['predev', 'prestart', 'prebuild']) {
    assert.ok(scripts[hook].includes('npm run ensure:cli-dist'));
  }
});

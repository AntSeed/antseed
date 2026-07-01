import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyConfigPatch,
  parseJsoncObject,
  removeConfigPatch,
  type ConfigPatchDef,
} from './system-proxy-config-patch.js';

const PEER_ID = '0123456789abcdef0123456789abcdef01234567';

function makePatch(configPath: string): ConfigPatchDef {
  return {
    configPath,
    providerKey: 'antseed',
    npm: '@antseed/tool-provider',
    providerName: 'AntSeed',
    baseURL: 'http://127.0.0.1:{buyerPort}/v1',
    modelFormat: 'peer-routed',
  };
}

async function withTempConfig(fn: (dir: string, configPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-desktop-system-proxy-'));
  try {
    await fn(dir, path.join(dir, 'tool-config.jsonc'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('parseJsoncObject accepts comments and trailing commas without touching strings', () => {
  const parsed = parseJsoncObject(`
    {
      // line comment
      "url": "https://example.test/path//inside-string",
      "glob": "/* also inside string */",
      "items": ["one", "two",],
    }
  `, 'config.jsonc');

  assert.deepEqual(parsed, {
    url: 'https://example.test/path//inside-string',
    glob: '/* also inside string */',
    items: ['one', 'two'],
  });
});

test('applyConfigPatch patches JSONC configs and writes a backup before normalizing JSON', async () => {
  await withTempConfig(async (_dir, configPath) => {
    const original = `{
      // user setting comment
      "provider": {
        "existing": { "name": "Existing" },
      },
      "disabled_providers": ["antseed", "other",],
      "notes": "keep // literal text",
    }\n`;
    await writeFile(configPath, original, 'utf8');

    applyConfigPatch(makePatch(configPath), PEER_ID, 'model-b', 9456, ['model-a', 'model-b']);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      provider: Record<string, {
        name?: string;
        npm?: string;
        options?: { baseURL?: string; apiKey?: string };
        models?: Record<string, { name: string }>;
      }>;
      model: string;
      disabled_providers?: string[];
      notes: string;
    };

    assert.equal(config.provider.existing?.name, 'Existing');
    assert.equal(config.provider.antseed?.name, 'AntSeed');
    assert.equal(config.provider.antseed?.npm, '@antseed/tool-provider');
    assert.equal(config.provider.antseed?.options?.baseURL, 'http://127.0.0.1:9456/v1');
    assert.equal(config.provider.antseed?.options?.apiKey, 'antseed');
    assert.deepEqual(config.provider.antseed?.models, {
      [`${PEER_ID}@model-a`]: { name: 'model-a' },
      [`${PEER_ID}@model-b`]: { name: 'model-b' },
    });
    assert.equal(config.model, `antseed/${PEER_ID}@model-b`);
    assert.deepEqual(config.disabled_providers, ['other']);
    assert.equal(config.notes, 'keep // literal text');

    assert.equal(await readFile(`${configPath}.antseed.bak`, 'utf8'), original);
  });
});

test('applyConfigPatch creates a new config file when one does not exist', async () => {
  await withTempConfig(async (_dir, configPath) => {
    applyConfigPatch(makePatch(configPath), PEER_ID, 'model-a', 8377, ['model-a']);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      provider?: Record<string, unknown>;
      model?: string;
    };
    assert.ok(config.provider?.antseed);
    assert.equal(config.model, `antseed/${PEER_ID}@model-a`);
    assert.equal(existsSync(`${configPath}.antseed.bak`), false);
  });
});

test('applyConfigPatch leaves malformed existing configs unchanged', async () => {
  await withTempConfig(async (_dir, configPath) => {
    const original = '{ "provider": { "broken": } }\n';
    await writeFile(configPath, original, 'utf8');

    assert.throws(
      () => applyConfigPatch(makePatch(configPath), PEER_ID, 'model-a', 8377, ['model-a']),
      /Unable to parse JSONC config/,
    );

    assert.equal(await readFile(configPath, 'utf8'), original);
    assert.equal(await readFile(`${configPath}.antseed.bak`, 'utf8'), original);
  });
});

test('removeConfigPatch removes only the configured provider and matching model selection', async () => {
  await withTempConfig(async (_dir, configPath) => {
    await writeFile(configPath, JSON.stringify({
      provider: {
        existing: { name: 'Existing' },
      },
    }), 'utf8');
    const patch = makePatch(configPath);
    applyConfigPatch(patch, PEER_ID, 'model-a', 8377, ['model-a']);

    assert.equal(removeConfigPatch(patch), true);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      provider: Record<string, unknown>;
      model?: string;
    };
    assert.ok(config.provider.existing);
    assert.equal(config.provider.antseed, undefined);
    assert.equal(config.model, undefined);
  });
});

test('removeConfigPatch is a no-op when the target file does not exist', async () => {
  await withTempConfig(async (_dir, configPath) => {
    assert.equal(removeConfigPatch(makePatch(configPath)), false);
  });
});

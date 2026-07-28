import test from 'node:test';
import assert from 'node:assert/strict';
import { ANTSEED_MODEL_CONTEXT_WINDOW, ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/node/types';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyConfigPatch,
  parseJsoncObject,
  readConfigPatch,
  removeConfigPatch,
  type ConfigPatchDef,
} from './config-patch.js';
import { DEFAULT_APP_PROFILES } from '../connected-apps/defaults.js';

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

function makeT3CodePatch(configPath: string): ConfigPatchDef {
  return {
    format: 't3code',
    configPath,
    providerKey: 'antseed',
    providerName: 'AntSeed',
    baseURL: 'http://localhost:{buyerPort}',
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
        models?: Record<string, { name: string; limit: { context: number; output: number } }>;
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
      antseed: { name: 'AntSeed Auto', limit: { context: ANTSEED_MODEL_CONTEXT_WINDOW, output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS } },
      [`${PEER_ID}@model-a`]: { name: 'model-a', limit: { context: ANTSEED_MODEL_CONTEXT_WINDOW, output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS } },
      [`${PEER_ID}@model-b`]: { name: 'model-b', limit: { context: ANTSEED_MODEL_CONTEXT_WINDOW, output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS } },
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

test('applyConfigPatch falls back to an advertised model when no default model is selected', async () => {
  await withTempConfig(async (_dir, configPath) => {
    applyConfigPatch(makePatch(configPath), PEER_ID, '', 8377, ['model-a']);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      provider?: Record<string, { models?: Record<string, { name: string; limit: { context: number; output: number } }> }>;
      model?: string;
    };
    assert.deepEqual(config.provider?.antseed?.models, {
      antseed: { name: 'AntSeed Auto', limit: { context: ANTSEED_MODEL_CONTEXT_WINDOW, output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS } },
      [`${PEER_ID}@model-a`]: { name: 'model-a', limit: { context: ANTSEED_MODEL_CONTEXT_WINDOW, output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS } },
    });
    assert.equal(config.model, `antseed/${PEER_ID}@model-a`);
  });
});

test('applyConfigPatch rejects routes without any selected or advertised model', async () => {
  await withTempConfig(async (_dir, configPath) => {
    assert.throws(
      () => applyConfigPatch(makePatch(configPath), PEER_ID, '', 8377, []),
      /requires a model/,
    );
    assert.equal(existsSync(configPath), false);
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

function makeCodexPatch(configPath: string): ConfigPatchDef {
  return {
    format: 'codex',
    configPath,
    providerKey: 'antseed',
    providerName: 'AntSeed',
    baseURL: 'http://127.0.0.1:{buyerPort}/v1',
  };
}

test('applyConfigPatch (codex) sets top-level keys before tables and appends a managed provider table', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    const original = [
      '# user comment',
      'model = "gpt-5"',
      '',
      '[mcp_servers.docs]',
      'command = "docs-server"',
      '',
    ].join('\n');
    await writeFile(configPath, original, 'utf8');

    applyConfigPatch(makeCodexPatch(configPath), PEER_ID, 'model-b', 9456, ['model-a', 'model-b']);

    const raw = await readFile(configPath, 'utf8');
    const lines = raw.split('\n');
    const firstTable = lines.findIndex((line) => line.startsWith('['));
    assert.ok(lines.indexOf('model_provider = "antseed"') < firstTable);
    assert.ok(lines.indexOf(`model = "${PEER_ID}@model-b"`) < firstTable);
    assert.ok(lines.indexOf(`model_context_window = ${ANTSEED_MODEL_CONTEXT_WINDOW}`) < firstTable);
    assert.equal(lines[0], '# user comment');
    assert.equal(lines.filter((line) => /^\s*model\s*=/.test(line)).length, 1);
    assert.ok(raw.includes('[mcp_servers.docs]'));
    assert.ok(raw.includes('[model_providers.antseed]'));
    assert.ok(raw.includes('name = "AntSeed"'));
    assert.ok(raw.includes('base_url = "http://127.0.0.1:9456/v1"'));
    assert.ok(raw.includes('wire_api = "responses"'));
    assert.equal(await readFile(`${configPath}.antseed.bak`, 'utf8'), original);
  });
});

test('applyConfigPatch (codex) creates the config file and replaces a previous managed table', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    applyConfigPatch(makeCodexPatch(configPath), PEER_ID, 'model-a', 8377, ['model-a']);
    applyConfigPatch(makeCodexPatch(configPath), PEER_ID, 'model-b', 8378, ['model-b']);

    const raw = await readFile(configPath, 'utf8');
    assert.equal(raw.split('[model_providers.antseed]').length, 2);
    assert.ok(raw.includes(`model = "${PEER_ID}@model-b"`));
    assert.ok(raw.includes('base_url = "http://127.0.0.1:8378/v1"'));
    assert.ok(!raw.includes('8377'));
  });
});

test('removeConfigPatch (codex) removes the managed table and model selection but keeps user tables', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    await writeFile(configPath, '[mcp_servers.docs]\ncommand = "docs-server"\n', 'utf8');
    const patch = makeCodexPatch(configPath);
    applyConfigPatch(patch, PEER_ID, 'model-a', 8377, ['model-a']);

    assert.equal(removeConfigPatch(patch), true);

    const raw = await readFile(configPath, 'utf8');
    assert.ok(raw.includes('[mcp_servers.docs]'));
    assert.ok(!raw.includes('model_provider'));
    assert.ok(!raw.includes(`model = "${PEER_ID}@model-a"`));
    assert.ok(!raw.includes('model_context_window'));
    assert.ok(!raw.includes('[model_providers.antseed]'));

    assert.equal(removeConfigPatch(patch), false);
  });
});

test('removeConfigPatch (codex) keeps a model_provider selection it does not own', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    await writeFile(configPath, 'model_provider = "ollama"\nmodel = "llama3"\n', 'utf8');

    assert.equal(removeConfigPatch(makeCodexPatch(configPath)), false);
    assert.equal(await readFile(configPath, 'utf8'), 'model_provider = "ollama"\nmodel = "llama3"\n');
  });
});

function makePiPatch(modelsPath: string, settingsPath: string): ConfigPatchDef {
  return {
    format: 'pi',
    configPath: modelsPath,
    settingsPath,
    providerKey: 'antseed',
    baseURL: 'http://127.0.0.1:{buyerPort}/v1',
    api: 'openai-completions',
  };
}

test('applyConfigPatch (pi) writes the provider into models.json and the default selection into settings.json', async () => {
  await withTempConfig(async (dir) => {
    const modelsPath = path.join(dir, 'models.json');
    const settingsPath = path.join(dir, 'settings.json');
    await writeFile(modelsPath, JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1' } } }), 'utf8');
    await writeFile(settingsPath, JSON.stringify({ theme: 'dark' }), 'utf8');

    applyConfigPatch(makePiPatch(modelsPath, settingsPath), PEER_ID, 'model-b', 9456, ['model-a', 'model-b']);

    const models = JSON.parse(await readFile(modelsPath, 'utf8')) as {
      providers: Record<string, { baseUrl?: string; api?: string; apiKey?: string; models?: Array<{ id: string; name: string; contextWindow: number; maxTokens: number }> }>;
    };
    assert.ok(models.providers.ollama);
    assert.equal(models.providers.antseed?.baseUrl, 'http://127.0.0.1:9456/v1');
    assert.equal(models.providers.antseed?.api, 'openai-completions');
    assert.equal(models.providers.antseed?.apiKey, 'antseed');
    assert.deepEqual(models.providers.antseed?.models, [
      { id: 'antseed', name: 'AntSeed Auto', contextWindow: ANTSEED_MODEL_CONTEXT_WINDOW, maxTokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
      { id: `${PEER_ID}@model-a`, name: 'model-a', contextWindow: ANTSEED_MODEL_CONTEXT_WINDOW, maxTokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
      { id: `${PEER_ID}@model-b`, name: 'model-b', contextWindow: ANTSEED_MODEL_CONTEXT_WINDOW, maxTokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
    ]);

    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    assert.equal(settings['theme'], 'dark');
    assert.equal(settings['defaultProvider'], 'antseed');
    assert.equal(settings['defaultModel'], `${PEER_ID}@model-b`);
  });
});

test('removeConfigPatch (pi) removes only the managed provider and matching default selection', async () => {
  await withTempConfig(async (dir) => {
    const modelsPath = path.join(dir, 'models.json');
    const settingsPath = path.join(dir, 'settings.json');
    const patch = makePiPatch(modelsPath, settingsPath);
    applyConfigPatch(patch, PEER_ID, 'model-a', 8377, ['model-a']);

    assert.equal(removeConfigPatch(patch), true);

    const models = JSON.parse(await readFile(modelsPath, 'utf8')) as { providers?: Record<string, unknown> };
    assert.equal(models.providers?.['antseed'], undefined);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    assert.equal(settings['defaultProvider'], undefined);
    assert.equal(settings['defaultModel'], undefined);

    assert.equal(removeConfigPatch(patch), false);
  });
});

test('applyConfigPatch writes the routed-model alias as the selection when the tool follows the default route', async () => {
  await withTempConfig(async (dir, configPath) => {
    applyConfigPatch(makePatch(configPath), PEER_ID, 'model-a', 8377, ['model-a'], true);
    const opencode = JSON.parse(await readFile(configPath, 'utf8')) as { model?: string };
    assert.equal(opencode.model, 'antseed/antseed');

    const codexPath = path.join(dir, 'config.toml');
    applyConfigPatch(makeCodexPatch(codexPath), PEER_ID, 'model-a', 8377, ['model-a'], true);
    const codexRaw = await readFile(codexPath, 'utf8');
    assert.ok(codexRaw.includes('model = "antseed"'));
    assert.ok(!codexRaw.includes(`${PEER_ID}@model-a`));

    const modelsPath = path.join(dir, 'models.json');
    const settingsPath = path.join(dir, 'settings.json');
    applyConfigPatch(makePiPatch(modelsPath, settingsPath), PEER_ID, 'model-a', 8377, ['model-a'], true);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    assert.equal(settings['defaultModel'], 'antseed');
    const models = JSON.parse(await readFile(modelsPath, 'utf8')) as {
      providers: Record<string, { models?: Array<{ id: string }> }>;
    };
    // Concrete peer-pinned entries stay listed so the tool's own model picker
    // can still pin a specific route.
    assert.deepEqual(models.providers.antseed?.models?.map((entry) => entry.id), ['antseed', `${PEER_ID}@model-a`]);
  });
});

test('removeConfigPatch (pi) keeps a default selection it does not own', async () => {
  await withTempConfig(async (dir) => {
    const modelsPath = path.join(dir, 'models.json');
    const settingsPath = path.join(dir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude' }), 'utf8');

    assert.equal(removeConfigPatch(makePiPatch(modelsPath, settingsPath)), false);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    assert.equal(settings['defaultProvider'], 'anthropic');
    assert.equal(settings['defaultModel'], 'claude');
  });
});

// --- Crush ---

function makeCrushPatch(configPath: string): ConfigPatchDef {
  return {
    format: 'crush',
    configPath,
    providerKey: 'antseed',
    providerName: 'AntSeed',
    baseURL: 'http://127.0.0.1:{buyerPort}/v1',
  };
}

test('applyConfigPatch (crush) writes an openai-compat provider and the large/small selections', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'crush.json');
    await writeFile(configPath, JSON.stringify({ options: { debug: true } }), 'utf8');

    applyConfigPatch(makeCrushPatch(configPath), PEER_ID, 'model-a', 8377, ['model-a', 'model-b']);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.deepEqual(config['options'], { debug: true });
    const provider = config['providers']['antseed'];
    assert.equal(provider['type'], 'openai-compat');
    assert.equal(provider['base_url'], 'http://127.0.0.1:8377/v1');
    assert.deepEqual(
      provider['models'].map((model: Record<string, unknown>) => model['id']),
      ['antseed', `${PEER_ID}@model-a`, `${PEER_ID}@model-b`],
    );
    assert.ok(provider['models'].every((model: Record<string, unknown>) => model['context_window'] === ANTSEED_MODEL_CONTEXT_WINDOW));
    assert.ok(provider['models'].every((model: Record<string, unknown>) => model['default_max_tokens'] === ANTSEED_MODEL_MAX_OUTPUT_TOKENS));
    assert.deepEqual(config['models']['large'], { provider: 'antseed', model: `${PEER_ID}@model-a` });
    assert.deepEqual(config['models']['small'], { provider: 'antseed', model: `${PEER_ID}@model-a` });
    assert.ok(existsSync(`${configPath}.antseed.bak`));
  });
});

test('removeConfigPatch (crush) removes only the managed provider and its selections', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'crush.json');
    await writeFile(configPath, JSON.stringify({
      providers: {
        antseed: { type: 'openai-compat' },
        deepseek: { type: 'openai-compat' },
      },
      models: {
        large: { provider: 'antseed', model: 'antseed' },
        small: { provider: 'deepseek', model: 'deepseek-chat' },
      },
    }), 'utf8');

    assert.equal(removeConfigPatch(makeCrushPatch(configPath)), true);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.deepEqual(Object.keys(config['providers']), ['deepseek']);
    assert.equal(config['models']['large'], undefined);
    assert.deepEqual(config['models']['small'], { provider: 'deepseek', model: 'deepseek-chat' });
  });
});

// --- goose ---

function makeGoosePatch(configPath: string): ConfigPatchDef {
  return {
    format: 'goose',
    configPath,
    providerKey: 'openai',
    baseURL: 'http://localhost:{buyerPort}',
  };
}

test('applyConfigPatch (goose) sets env-style keys while keeping user lines', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    await writeFile(configPath, '# my goose setup\nGOOSE_MODE: smart_approve\nGOOSE_MODEL: gpt-4o\n', 'utf8');

    applyConfigPatch(makeGoosePatch(configPath), PEER_ID, 'model-a', 8377, ['model-a'], true);

    const raw = await readFile(configPath, 'utf8');
    const lines = raw.split('\n');
    assert.equal(lines[0], '# my goose setup');
    assert.equal(lines[1], 'GOOSE_MODE: smart_approve');
    assert.ok(lines.includes('GOOSE_PROVIDER: "openai"'));
    assert.ok(lines.includes('GOOSE_MODEL: "antseed"'));
    assert.ok(lines.includes('OPENAI_HOST: "http://localhost:8377"'));
    assert.ok(lines.includes('OPENAI_API_KEY: "antseed"'));
    assert.equal(lines.filter((line) => line.startsWith('GOOSE_MODEL')).length, 1);
    assert.ok(existsSync(`${configPath}.antseed.bak`));
  });
});

test('removeConfigPatch (goose) removes only keys the patch owns', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    await writeFile(configPath, [
      'GOOSE_MODE: smart_approve',
      'GOOSE_PROVIDER: "openai"',
      'GOOSE_MODEL: "antseed"',
      'OPENAI_HOST: "http://localhost:8377"',
      'OPENAI_API_KEY: "antseed"',
    ].join('\n') + '\n', 'utf8');

    assert.equal(removeConfigPatch(makeGoosePatch(configPath)), true);
    const raw = await readFile(configPath, 'utf8');
    assert.equal(raw, 'GOOSE_MODE: smart_approve\n');
  });
});

test('removeConfigPatch (goose) keeps a provider selection it does not own', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    await writeFile(configPath, 'GOOSE_PROVIDER: "openai"\nGOOSE_MODEL: "gpt-4o"\nOPENAI_HOST: "https://api.openai.com"\n', 'utf8');

    assert.equal(removeConfigPatch(makeGoosePatch(configPath)), false);
    const raw = await readFile(configPath, 'utf8');
    assert.ok(raw.includes('GOOSE_MODEL: "gpt-4o"'));
    assert.ok(raw.includes('OPENAI_HOST: "https://api.openai.com"'));
  });
});

// --- T3 Code ---

test('T3 Code patch adds an AntSeed Claude provider and preserves existing settings', async () => {
  await withTempConfig(async (_dir, configPath) => {
    await writeFile(configPath, JSON.stringify({
      theme: 'dark',
      providerInstances: {
        codex: { driver: 'codex', displayName: 'Codex' },
      },
    }), 'utf8');

    applyConfigPatch(makeT3CodePatch(configPath), PEER_ID, 'model-a', 9456, ['model-a', 'model-b'], true);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(config['theme'], 'dark');
    const providers = config['providerInstances'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(providers['codex'], { driver: 'codex', displayName: 'Codex' });
    assert.deepEqual(providers['antseed'], {
      driver: 'claudeAgent',
      displayName: 'AntSeed',
      environment: [
        { name: 'ANTHROPIC_BASE_URL', value: 'http://localhost:9456', sensitive: false },
        { name: 'ANTHROPIC_API_KEY', value: 'antseed', sensitive: false },
      ],
      enabled: true,
      config: {
        customModels: [
          'antseed',
          `${PEER_ID}@model-a`,
          `${PEER_ID}@model-b`,
        ],
      },
    });
  });
});

test('T3 Code patch removal only removes the managed AntSeed provider', async () => {
  await withTempConfig(async (_dir, configPath) => {
    const patch = makeT3CodePatch(configPath);
    applyConfigPatch(patch, PEER_ID, 'model-a', 8377, ['model-a'], true);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    (config['providerInstances'] as Record<string, unknown>)['codex'] = { driver: 'codex' };
    await writeFile(configPath, JSON.stringify(config), 'utf8');

    assert.equal(removeConfigPatch(patch), true);
    const cleaned = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(cleaned['providerInstances'], { codex: { driver: 'codex' } });
    assert.equal(removeConfigPatch(patch), false);
  });
});

// --- Zed ---

function makeZedPatch(configPath: string): ConfigPatchDef {
  return {
    format: 'zed',
    configPath,
    providerKey: 'antseed',
    providerName: 'AntSeed',
    baseURL: 'http://127.0.0.1:{buyerPort}/v1',
  };
}

test('applyConfigPatch (zed) writes the openai_compatible provider and agent default model', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    await writeFile(configPath, '{\n  // zed user settings\n  "theme": "One Dark",\n}\n', 'utf8');

    applyConfigPatch(makeZedPatch(configPath), PEER_ID, 'model-a', 8377, ['model-a'], true);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(config['theme'], 'One Dark');
    const provider = config['language_models']['openai_compatible']['AntSeed'];
    assert.equal(provider['api_url'], 'http://127.0.0.1:8377/v1');
    assert.equal(provider['available_models'][0]['name'], 'antseed');
    assert.ok(provider['available_models'].every((model: Record<string, unknown>) => model['max_tokens'] === ANTSEED_MODEL_CONTEXT_WINDOW));
    assert.deepEqual(config['agent']['default_model'], { provider: 'AntSeed', model: 'antseed' });
    assert.ok(existsSync(`${configPath}.antseed.bak`));
  });
});

test('removeConfigPatch (zed) removes the managed provider and matching default model only', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    await writeFile(configPath, JSON.stringify({
      theme: 'One Dark',
      language_models: {
        openai_compatible: {
          AntSeed: { api_url: 'http://127.0.0.1:8377/v1', available_models: [] },
          Groq: { api_url: 'https://api.groq.com/openai/v1', available_models: [] },
        },
      },
      agent: { default_model: { provider: 'AntSeed', model: 'antseed' }, always_allow_tool_actions: true },
    }), 'utf8');

    assert.equal(removeConfigPatch(makeZedPatch(configPath)), true);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(config['theme'], 'One Dark');
    assert.deepEqual(Object.keys(config['language_models']['openai_compatible']), ['Groq']);
    assert.equal(config['agent']['default_model'], undefined);
    assert.equal(config['agent']['always_allow_tool_actions'], true);
  });
});

// Every built-in profile must parse through readConfigPatch and keep its own
// format. A format missing its branch falls through to opencode, whose `npm`
// requirement throws while profiles load — which crashes the app at startup
// (0.1.115-alpha-0.14 shipped that crash for t3code).
test('readConfigPatch parses every default app profile under its declared format', () => {
  for (const profile of DEFAULT_APP_PROFILES) {
    const raw = profile as Record<string, unknown>;
    const name = raw['name'] as string;
    const rawPatch = raw['configPatch'] as Record<string, unknown>;
    const parsed = readConfigPatch(rawPatch, name);
    assert.ok(parsed, `default profile ${name} must define a configPatch`);
    assert.equal(parsed.format, rawPatch['format'] ?? 'opencode', `profile ${name} fell through to another format`);
  }
});

# @anthropic/provider-claude-oauth

Third-party Anthropic Claude provider plugin with OAuth authentication for Antseed.

This plugin demonstrates how a third-party developer can build, test, and publish an Antseed provider plugin using `@antseed/provider-core`.

## How to Create a Plugin

1. Create a new directory under `plugins/` (or anywhere on disk).
2. Add a `package.json` with `@antseed/provider-core` as a dependency and `@antseed/node` as a peer dependency.
3. Implement and default-export an `AntseedProviderPlugin` object from `src/index.ts`.
4. Build with `tsc` and test with `vitest`.

## Plugin Manifest Format

Every provider plugin must default-export an object satisfying `AntseedProviderPlugin`:

```typescript
import type { AntseedProviderPlugin, ConfigField } from '@antseed/node';

const plugin: AntseedProviderPlugin = {
  name: 'my-provider',           // unique plugin name
  displayName: 'My Provider',    // human-readable label
  version: '0.1.0',
  type: 'provider',
  description: 'Description of the provider',
  configSchema: [                // fields the user fills in
    { key: 'API_KEY', label: 'API Key', type: 'secret', required: true },
  ],
  createProvider(config) {
    // Return a Provider instance
  },
};
export default plugin;
```

### ConfigField Types

| Type       | Description                        |
| ---------- | ---------------------------------- |
| `string`   | Plain text input                   |
| `number`   | Numeric input                      |
| `boolean`  | Toggle / checkbox                  |
| `secret`   | Masked input (tokens, keys)        |
| `string[]` | Comma-separated list of strings    |

## Using provider-core

The `@antseed/provider-core` package provides reusable building blocks:

- **`BaseProvider`** -- Implements the `Provider` interface and wires up `HttpRelay`.
- **`StaticTokenProvider`** -- Wraps a static API key with no refresh logic.
- **`OAuthTokenProvider`** -- Manages OAuth access/refresh token pairs with automatic renewal.
- **`HttpRelay`** -- Forwards requests to an upstream API with auth header swapping, model validation, and concurrency control.

```typescript
import { BaseProvider, OAuthTokenProvider, StaticTokenProvider } from '@antseed/provider-core';
```

## Testing Locally

```bash
# Install dependencies
npm install

# Build the plugin
npm run build

# Run tests
npm test
```

To test the plugin end-to-end with a local Antseed node, link it:

```bash
cd plugins/provider-claude-oauth
npm link

cd /path/to/your/antseed-project
npm link @anthropic/provider-claude-oauth
```

Then configure the plugin in your node's plugin config with the required config fields.

## Publishing to npm

1. Ensure `package.json` has the correct `name`, `version`, and `description`.
2. Build the plugin: `npm run build`
3. Login to npm: `npm login`
4. Publish: `npm publish --access public`

For scoped packages like `@anthropic/provider-claude-oauth`, use `--access public` to publish as a public package.

## Installing via antseed plugin add

Once published, users can install the plugin:

```bash
antseed plugin add @anthropic/provider-claude-oauth
```

This will download the plugin from npm, register it with the local Antseed node, and prompt the user to configure the required fields (access token, etc.).

## Configuration Reference

| Key                            | Type     | Required | Default | Description                          |
| ------------------------------ | -------- | -------- | ------- | ------------------------------------ |
| `CLAUDE_ACCESS_TOKEN`          | secret   | Yes      | --      | Claude OAuth access token            |
| `CLAUDE_REFRESH_TOKEN`         | secret   | No       | --      | OAuth refresh token for auto-renewal |
| `CLAUDE_TOKEN_EXPIRES_AT`      | number   | No       | --      | Epoch ms when access token expires   |
| `ANTSEED_INPUT_USD_PER_MILLION`| number   | No       | 10      | Input token price (USD per 1M)       |
| `ANTSEED_OUTPUT_USD_PER_MILLION`| number  | No       | 10      | Output token price (USD per 1M)      |
| `ANTSEED_MAX_CONCURRENCY`      | number   | No       | 5       | Max concurrent requests              |
| `ANTSEED_ALLOWED_MODELS`       | string[] | No       | --      | Comma-separated list of model IDs    |

## License

See the root repository LICENSE file.

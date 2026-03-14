import type { Command } from 'commander'
import chalk from 'chalk'
import { createInterface } from 'node:readline/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface PluginScaffoldOptions {
  name: string
  type: 'provider' | 'router'
  displayName: string
  description: string
}

function generatePackageJson(opts: PluginScaffoldOptions): string {
  return JSON.stringify(
    {
      name: `@antseed/${opts.type}-${opts.name}`,
      version: '0.1.0',
      description: opts.description,
      type: 'module',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      scripts: {
        build: 'tsc',
        test: 'node --test dist/**/*.test.js',
        prepublishOnly: 'npm run build',
      },
      keywords: ['antseed', 'plugin', opts.type],
      peerDependencies: {
        '@antseed/node': '>=0.1.0',
      },
      devDependencies: {
        '@antseed/node': 'workspace:*',
        '@types/node': '^20.11.0',
        typescript: '^5.3.0',
      },
    },
    null,
    2,
  )
}

function generateTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        declaration: true,
        sourceMap: true,
      },
      include: ['src/**/*.ts'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  )
}

function generateIndexTs(opts: PluginScaffoldOptions): string {
  const importType = opts.type === 'provider' ? 'AntseedProviderPlugin' : 'AntseedRouterPlugin'
  const methodImport = opts.type === 'provider'
    ? `import { createProvider } from './${opts.type}.js'`
    : `import { createRouter } from './${opts.type}.js'`
  const method = opts.type === 'provider' ? 'createProvider' : 'createRouter'

  return `import type { ${importType}, ConfigField } from '@antseed/node'
${methodImport}

const configSchema: ConfigField[] = [
  // Define your plugin's configuration fields here
  // { key: 'API_KEY', label: 'API Key', type: 'secret', required: true, description: 'Your API key' },
]

const plugin: ${importType} = {
  name: '${opts.name}',
  displayName: '${opts.displayName}',
  version: '0.1.0',
  description: '${opts.description}',
  type: '${opts.type}',
  configSchema,
  ${method},
}

export default plugin
`
}

function generateProviderTs(opts: PluginScaffoldOptions): string {
  return `import type { Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node'

export function createProvider(config: Record<string, string>): Provider {
  return {
    name: '${opts.name}',
    services: [],
    pricing: {
      defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    },
    maxConcurrency: 1,
    async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
      // Implement your provider logic here
      throw new Error('Not implemented')
    },
    getCapacity() {
      return { current: 0, max: 1 }
    },
  }
}
`
}

function generateRouterTs(_opts: PluginScaffoldOptions): string {
  return `import type { Router, PeerInfo, SerializedHttpRequest } from '@antseed/node'

export function createRouter(config: Record<string, string>): Router {
  return {
    selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
      // Implement your router logic here
      return peers[0] ?? null
    },
    onResult(peer: PeerInfo, result: { success: boolean; latencyMs: number; tokens: number }): void {
      // Track peer performance here
    },
  }
}
`
}

function generateTestTs(opts: PluginScaffoldOptions): string {
  return `import assert from 'node:assert/strict'
import test from 'node:test'

test('${opts.name} plugin exports valid manifest', async () => {
  const { default: plugin } = await import('./index.js')
  assert.equal(plugin.type, '${opts.type}')
  assert.equal(plugin.name, '${opts.name}')
  assert.ok(plugin.displayName)
  assert.ok(plugin.version)
  assert.ok(Array.isArray(plugin.configSchema))
})
`
}

function generateReadme(opts: PluginScaffoldOptions): string {
  return `# antseed-${opts.type}-${opts.name}

${opts.description}

## Installation

\`\`\`bash
antseed plugin add antseed-${opts.type}-${opts.name}
\`\`\`

## Configuration

Configure via interactive prompt:

\`\`\`bash
antseed plugin config <instance-id>
\`\`\`

## Development

\`\`\`bash
npm install
npm run build
npm test
\`\`\`
`
}

export async function scaffoldPlugin(dir: string, opts: PluginScaffoldOptions): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'package.json'), generatePackageJson(opts), 'utf-8')
  await writeFile(join(dir, 'tsconfig.json'), generateTsconfig(), 'utf-8')
  await writeFile(join(dir, 'src', 'index.ts'), generateIndexTs(opts), 'utf-8')

  if (opts.type === 'provider') {
    await writeFile(join(dir, 'src', 'provider.ts'), generateProviderTs(opts), 'utf-8')
  } else {
    await writeFile(join(dir, 'src', 'router.ts'), generateRouterTs(opts), 'utf-8')
  }

  await writeFile(join(dir, 'src', 'index.test.ts'), generateTestTs(opts), 'utf-8')
  await writeFile(join(dir, 'README.md'), generateReadme(opts), 'utf-8')
}

export function registerPluginCreateCommand(pluginCmd: Command): void {
  pluginCmd
    .command('create')
    .description('Scaffold a new plugin project')
    .action(async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        const name = (await rl.question('Plugin name (lowercase, no spaces): ')).trim()
        if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
          console.log(chalk.red('Invalid plugin name. Use lowercase letters, numbers, and hyphens.'))
          process.exit(1)
        }

        const typeAnswer = (await rl.question('Plugin type (provider/router): ')).trim()
        if (typeAnswer !== 'provider' && typeAnswer !== 'router') {
          console.log(chalk.red('Plugin type must be "provider" or "router".'))
          process.exit(1)
        }
        const type = typeAnswer as 'provider' | 'router'

        const displayName = (await rl.question('Display name: ')).trim() || name
        const description = (await rl.question('Description: ')).trim() || `Antseed ${type} plugin`

        const dir = join(process.cwd(), `antseed-${type}-${name}`)
        await scaffoldPlugin(dir, { name, type, displayName, description })

        console.log(chalk.green(`\nScaffolded plugin at: ${dir}`))
        console.log(chalk.dim('\nNext steps:'))
        console.log(chalk.dim(`  cd antseed-${type}-${name}`))
        console.log(chalk.dim('  npm install'))
        console.log(chalk.dim('  npm run build'))
      } finally {
        rl.close()
      }
    })
}

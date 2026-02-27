import type { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getGlobalOptions } from './types.js'
import { loadConfig } from '../../config/loader.js'
import { AntseedNode, BaseEscrowClient, loadOrCreateIdentity, identityToEvmAddress, getInstance } from '@antseed/node'
import type { NodePaymentsConfig } from '@antseed/node'
import { OFFICIAL_BOOTSTRAP_NODES, parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import { setupShutdownHandler } from '../shutdown.js'
import { loadRouterPlugin, buildPluginConfig } from '../../plugins/loader.js'
import { BuyerProxy } from '../../proxy/buyer-proxy.js'
import { resolveEffectiveBuyerConfig, type BuyerRuntimeOverrides } from '../../config/effective.js'
import type { BuyerCLIConfig } from '../../config/types.js'

interface LocalSeederInfo {
  dhtPort: number
  signalingPort: number
  pid: number
}

export function buildBuyerRuntimeOverridesFromFlags(options: {
  port?: number
  minPeerReputation?: number
  preferredProviders?: string[]
  maxInputUsdPerMillion?: number
  maxOutputUsdPerMillion?: number
}): BuyerRuntimeOverrides {
  const overrides: BuyerRuntimeOverrides = {}
  if (options.port !== undefined) {
    overrides.proxyPort = options.port
  }
  if (options.minPeerReputation !== undefined) {
    overrides.minPeerReputation = options.minPeerReputation
  }
  if (options.preferredProviders && options.preferredProviders.length > 0) {
    overrides.preferredProviders = options.preferredProviders
  }
  if (options.maxInputUsdPerMillion !== undefined) {
    overrides.maxInputUsdPerMillion = options.maxInputUsdPerMillion
  }
  if (options.maxOutputUsdPerMillion !== undefined) {
    overrides.maxOutputUsdPerMillion = options.maxOutputUsdPerMillion
  }
  return overrides
}

export function buildRouterRuntimeEnvFromBuyerConfig(buyerConfig: BuyerCLIConfig): Record<string, string> {
  const runtimeEnv: Record<string, string> = {
    ANTSEED_MIN_REPUTATION: String(buyerConfig.minPeerReputation),
    ANTSEED_MAX_PRICING_JSON: JSON.stringify(buyerConfig.maxPricing),
  }
  if (buyerConfig.preferredProviders.length > 0) {
    runtimeEnv['ANTSEED_PREFERRED_PROVIDERS'] = buyerConfig.preferredProviders.join(',')
  }
  return runtimeEnv
}

export function buildBuyerBootstrapEntries(
  configuredBootstrapNodes: string[] | undefined,
  localSeederDhtPort?: number,
): string[] {
  const configured = Array.isArray(configuredBootstrapNodes)
    ? configuredBootstrapNodes.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : []

  // Respect explicit user bootstrap config. If none is provided, keep default public bootstrap nodes.
  const baseEntries = configured.length > 0
    ? configured
    : OFFICIAL_BOOTSTRAP_NODES.map((node) => `${node.host}:${node.port}`)

  const entries = [...baseEntries]

  if (Number.isFinite(localSeederDhtPort) && (localSeederDhtPort ?? 0) > 0) {
    const localBootstrap = `127.0.0.1:${Math.floor(localSeederDhtPort as number)}`
    if (!entries.includes(localBootstrap)) {
      entries.unshift(localBootstrap)
    }
  }

  return entries
}

function parseOptionalBoolEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

async function isRpcReachable(rpcUrl: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      }),
      signal: controller.signal,
    })

    if (!response.ok) return false

    const payload = await response.json() as { result?: unknown }
    return typeof payload.result === 'string' && payload.result.startsWith('0x')
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function getLocalSeederInfo(): Promise<LocalSeederInfo | null> {
  try {
    const stateFile = join(homedir(), '.antseed', 'daemon.state.json')
    const raw = await readFile(stateFile, 'utf-8')
    const state = JSON.parse(raw) as { state?: string; dhtPort?: number; signalingPort?: number; pid?: number }
    if (state.state === 'seeding' && state.dhtPort && state.pid) {
      try {
        process.kill(state.pid, 0)
        const signalingPort = state.signalingPort ?? state.dhtPort
        return { dhtPort: state.dhtPort, signalingPort, pid: state.pid }
      } catch {
        return null
      }
    }
  } catch {
    // No state file or unreadable
  }
  return null
}

export function registerConnectCommand(program: Command): void {
  program
    .command('connect')
    .description('Start the buyer proxy and connect to sellers on the P2P network')
    .option('-p, --port <number>', 'local proxy port', (v) => parseInt(v, 10))
    .option('--router <name>', 'router plugin name or npm package')
    .option('--instance <id>', 'use a configured plugin instance by ID')
    .option('--max-input-usd-per-million <number>', 'runtime-only max input pricing override in USD per 1M tokens', parseFloat)
    .option('--max-output-usd-per-million <number>', 'runtime-only max output pricing override in USD per 1M tokens', parseFloat)
    .option('--peer <peerId>', 'pin all requests to a specific peer ID (64-char hex), bypassing the router')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program)
      const config = await loadConfig(globalOpts.config)

      const pinnedPeerId = options.peer as string | undefined
      if (pinnedPeerId !== undefined && !/^[0-9a-f]{64}$/i.test(pinnedPeerId)) {
        console.error(chalk.red('Error: --peer must be a 64-character hex peer ID.'))
        process.exit(1)
      }

      const runtimeOverrides = buildBuyerRuntimeOverridesFromFlags({
        port: options.port as number | undefined,
        maxInputUsdPerMillion: options.maxInputUsdPerMillion as number | undefined,
        maxOutputUsdPerMillion: options.maxOutputUsdPerMillion as number | undefined,
      })
      const effectiveBuyerConfig = resolveEffectiveBuyerConfig({
        config,
        buyerOverrides: runtimeOverrides,
      })

      let router
      let toolHints: Array<{ name: string; envVar: string }> = []

      if (options.instance) {
        const configPath = join(homedir(), '.antseed', 'config.json')
        const instance = await getInstance(configPath, options.instance)
        if (!instance) {
          console.error(chalk.red(`Instance "${options.instance}" not found.`))
          process.exit(1)
        }
        if (instance.type !== 'router') {
          console.error(chalk.red(`Instance "${options.instance}" is a ${instance.type}, not a router.`))
          process.exit(1)
        }
        const spinner = ora(`Loading router plugin "${instance.package}"...`).start()
        try {
          const plugin = await loadRouterPlugin(instance.package)
          const runtimeEnv = buildRouterRuntimeEnvFromBuyerConfig(effectiveBuyerConfig)
          const pluginConfig = buildPluginConfig(plugin.configSchema ?? plugin.configKeys ?? [], runtimeEnv, instance.config as Record<string, string>)
          router = await plugin.createRouter(pluginConfig)
          spinner.succeed(chalk.green(`Router "${plugin.displayName}" loaded`))
          toolHints = (plugin as any).TOOL_HINTS ?? []
        } catch (err) {
          spinner.fail(chalk.red(`Failed to load router: ${(err as Error).message}`))
          process.exit(1)
        }
      } else if (options.router) {
        const spinner = ora(`Loading router plugin "${options.router}"...`).start()
        try {
          const plugin = await loadRouterPlugin(options.router)
          const runtimeEnv = buildRouterRuntimeEnvFromBuyerConfig(effectiveBuyerConfig)
          const pluginConfig = buildPluginConfig(plugin.configSchema ?? plugin.configKeys ?? [], runtimeEnv)
          router = await plugin.createRouter(pluginConfig)
          spinner.succeed(chalk.green(`Router "${plugin.displayName}" loaded`))
          toolHints = (plugin as any).TOOL_HINTS ?? []
        } catch (err) {
          spinner.fail(chalk.red(`Failed to load router: ${(err as Error).message}`))
          process.exit(1)
        }
      } else {
        console.error(chalk.red('Error: No router specified.'))
        console.error(chalk.dim('Run: antseed connect --router <name>  or  antseed connect --instance <id>'))
        process.exit(1)
      }

      // Auto-discover local seeder
      const seederInfo = await getLocalSeederInfo()
      const allBootstrapEntries = buildBuyerBootstrapEntries(
        config.network?.bootstrapNodes,
        seederInfo?.dhtPort,
      )
      const bootstrapNodes = toBootstrapConfig(parseBootstrapList(allBootstrapEntries))

      const nodeSpinner = ora('Connecting to P2P network...').start()

      // Build payment config from CLI config if available and reachable
      let paymentsConfig: NodePaymentsConfig | undefined
      const settlementEnv = parseOptionalBoolEnv(process.env['ANTSEED_ENABLE_SETTLEMENT'])
      const crypto = config.payments?.crypto
      let settlementEnabled = settlementEnv ?? Boolean(crypto)

      if (settlementEnabled && crypto && settlementEnv !== true) {
        const rpcUp = await isRpcReachable(crypto.rpcUrl)
        if (!rpcUp) {
          settlementEnabled = false
          console.log(chalk.yellow(`Payments disabled: RPC node unreachable at ${crypto.rpcUrl}`))
          console.log(chalk.dim('Start your chain node or set ANTSEED_ENABLE_SETTLEMENT=true to force-enable payments.'))
        }
      }

      if (settlementEnabled && crypto) {
        paymentsConfig = {
          enabled: true,
          rpcUrl: crypto.rpcUrl,
          contractAddress: crypto.escrowContractAddress,
          usdcAddress: crypto.usdcContractAddress,
          defaultEscrowAmountUSDC: crypto.defaultLockAmountUSDC
            ? String(Math.round(parseFloat(crypto.defaultLockAmountUSDC) * 1_000_000))
            : '1000000',
          platformFeeRate: config.payments.platformFeeRate,
        }
      }

      console.log(chalk.bold('Effective buyer settings:'))
      console.log(
        chalk.dim(
          `  preferred providers: ${effectiveBuyerConfig.preferredProviders.length > 0 ? effectiveBuyerConfig.preferredProviders.join(', ') : '(any)'}`
        )
      )
      console.log(
        chalk.dim(
          `  max pricing defaults (USD/1M): input=${effectiveBuyerConfig.maxPricing.defaults.inputUsdPerMillion}, output=${effectiveBuyerConfig.maxPricing.defaults.outputUsdPerMillion}`
        )
      )
      console.log(chalk.dim(`  min peer reputation: ${effectiveBuyerConfig.minPeerReputation}`))
      console.log(chalk.dim(`  proxy port: ${effectiveBuyerConfig.proxyPort}`))
      if (pinnedPeerId) {
        console.log(chalk.yellow(`  pinned peer: ${pinnedPeerId} (router bypassed)`))
      }
      console.log('')

      const node = new AntseedNode({
        role: 'buyer',
        bootstrapNodes,
        allowPrivateIPs: true,
        dataDir: globalOpts.dataDir,
        payments: paymentsConfig,
      })

      node.setRouter(router)

      try {
        await node.start()
        nodeSpinner.succeed(chalk.green('Connected to P2P network'))
      } catch (err) {
        nodeSpinner.fail(chalk.red(`Failed to connect: ${(err as Error).message}`))
        process.exit(1)
      }

      // Display available USDC balance only if payments are active
      if (paymentsConfig?.enabled && config.payments?.crypto) {
        try {
          const identity = await loadOrCreateIdentity(globalOpts.dataDir)
          const address = identityToEvmAddress(identity)
          const escrowClient = new BaseEscrowClient({
            rpcUrl: config.payments.crypto.rpcUrl,
            contractAddress: config.payments.crypto.escrowContractAddress,
            usdcAddress: config.payments.crypto.usdcContractAddress,
          })
          const account = await escrowClient.getBuyerAccount(address)
          console.log(chalk.dim(`Wallet: ${address}`))
          const availUsdc = Number(account.available) / 1_000_000
          console.log(chalk.dim(`Escrow available: ${availUsdc.toFixed(6)} USDC`))
        } catch {
          // Non-fatal — chain may not be available
          console.log(chalk.dim('Payment balance unavailable (chain not reachable)'))
        }
      }

      // Start the local HTTP proxy
      const proxyPort = effectiveBuyerConfig.proxyPort
      const proxySpinner = ora(`Starting local proxy on port ${proxyPort}...`).start()

      const proxy = new BuyerProxy({
        port: proxyPort,
        node,
        pinnedPeerId,
      })

      try {
        await proxy.start()
        proxySpinner.succeed(chalk.green(`Proxy listening on http://localhost:${proxyPort}`))
      } catch (err) {
        proxySpinner.fail(chalk.red(`Failed to start proxy: ${(err as Error).message}`))
        await node.stop()
        process.exit(1)
      }

      const proxyUrl = `http://localhost:${proxyPort}`
      console.log('')

      if (toolHints.length > 0) {
        console.log(chalk.bold('Configure your tools:'))
        for (const hint of toolHints) {
          console.log(`  export ${hint.envVar}=${proxyUrl}   # ${hint.name}`)
        }
      } else {
        console.log(chalk.bold('Configure your CLI tools:'))
        console.log(`  export ANTHROPIC_BASE_URL=${proxyUrl}`)
        console.log(`  export OPENAI_BASE_URL=${proxyUrl}`)
      }
      console.log('')
      console.log(chalk.dim('Enable debug logs: export ANTSEED_DEBUG=1'))
      console.log('')

      setupShutdownHandler(async () => {
        nodeSpinner.start('Shutting down...')
        await proxy.stop()
        await node.stop()
        nodeSpinner.succeed('Disconnected. All sessions finalized.')
      })
    })
}

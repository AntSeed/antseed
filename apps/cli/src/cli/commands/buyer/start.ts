import type { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createConnection } from 'node:net'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { AntseedNode, DepositsClient, getInstance, resolveChainConfig } from '@antseed/node'
import type { NodePaymentsConfig } from '@antseed/node'
import { OFFICIAL_BOOTSTRAP_NODES, parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import { setupShutdownHandler } from '../../shutdown.js'
import { loadRouterPlugin, buildPluginConfig, getPackageVersions } from '../../../plugins/loader.js'
import { ensurePluginsUpToDate } from '../../../plugins/drift.js'
import { resolvePluginPackage } from '../../../plugins/registry.js'
import { BuyerProxy } from '../../../proxy/buyer-proxy.js'
import { resolveEffectiveBuyerConfig, type BuyerRuntimeOverrides } from '../../../config/effective.js'
import type { BuyerCLIConfig } from '../../../config/types.js'

interface LocalSeederInfo {
  dhtPort: number
  signalingPort: number
  pid: number
}

export function buildBuyerRuntimeOverridesFromFlags(options: {
  port?: number
  minPeerReputation?: number
  maxInputUsdPerMillion?: number
  maxOutputUsdPerMillion?: number
}): BuyerRuntimeOverrides {
  const overrides: BuyerRuntimeOverrides = {}
  if (options.port !== undefined) overrides.proxyPort = options.port
  if (options.minPeerReputation !== undefined) overrides.minPeerReputation = options.minPeerReputation
  if (options.maxInputUsdPerMillion !== undefined) overrides.maxInputUsdPerMillion = options.maxInputUsdPerMillion
  if (options.maxOutputUsdPerMillion !== undefined) overrides.maxOutputUsdPerMillion = options.maxOutputUsdPerMillion
  return overrides
}

export function buildRouterRuntimeEnvFromBuyerConfig(buyerConfig: BuyerCLIConfig): Record<string, string> {
  return {
    ANTSEED_MIN_REPUTATION: String(buyerConfig.minPeerReputation),
    ANTSEED_MAX_PRICING_JSON: JSON.stringify(buyerConfig.maxPricing),
  }
}

export function resolveBuyerRouterName(options: { router?: string }): string {
  return (options.router as string | undefined) ?? 'local'
}

export function buildBuyerBootstrapEntries(
  configuredBootstrapNodes: string[] | undefined,
  localSeederDhtPort?: number,
): string[] {
  const configured = Array.isArray(configuredBootstrapNodes)
    ? configuredBootstrapNodes.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : []
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

async function getLocalSeederInfo(dataDir: string): Promise<LocalSeederInfo | null> {
  try {
    const stateFile = join(dataDir, 'daemon.state.json')
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
  } catch {}
  return null
}

function isAddrInUseError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('EADDRINUSE')
}

async function isPortReachable(port: number, timeoutMs = 700): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Math.floor(port) })
    let settled = false
    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reachable)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

async function isCompatibleBuyerProxy(port: number, timeoutMs = 1200): Promise<boolean> {
  const overallBudgetMs = Math.max(1, timeoutMs)
  const startedAt = Date.now()
  const reachabilityTimeoutMs = Math.min(overallBudgetMs, 700)
  if (!await isPortReachable(port, reachabilityTimeoutMs)) return false

  const elapsedMs = Date.now() - startedAt
  const remainingBudgetMs = overallBudgetMs - elapsedMs
  if (remainingBudgetMs <= 0) return false

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), remainingBudgetMs)
  try {
    const response = await fetch(`http://127.0.0.1:${Math.floor(port)}/v1/models`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    const antseedHeaderNames = ['x-antseed-request-id', 'x-antseed-peer-id', 'x-antseed-provider']
    if (antseedHeaderNames.some((header) => response.headers.has(header))) return true

    const body = (await response.text()).toLowerCase()
    // Any of these markers indicate we reached an Antseed buyer proxy on this
    // port. The `no_peer_pinned` case is the common one now that auto
    // selection is disabled — a fresh proxy with no session pin answers
    // /v1/models with a structured `{ error: { type: 'no_peer_pinned', ... } }`.
    return body.includes('no sellers available on the network')
      || body.includes('no peers support')
      || body.includes('p2p request failed')
      || body.includes('pinned peer')
      || body.includes('no peer pinned')
      || body.includes('"no_peer_pinned"')
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export function registerBuyerStartCommand(buyerCmd: Command): void {
  buyerCmd
    .command('start')
    .description('Start the buyer proxy and connect to sellers on the P2P network')
    .option('-p, --port <number>', 'local proxy port', (v) => parseInt(v, 10))
    .option('--router <name>', 'router plugin name or npm package')
    .option('--instance <id>', 'use a configured plugin instance by ID')
    .option('--max-input-usd-per-million <number>', 'runtime-only max input pricing override in USD per 1M tokens', parseFloat)
    .option('--max-output-usd-per-million <number>', 'runtime-only max output pricing override in USD per 1M tokens', parseFloat)
    .option('--peer <peerId>', 'pin all requests to a specific peer ID (40-char hex EVM address), bypassing the router')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(buyerCmd)
      const config = await loadConfig(globalOpts.config)

      const pinnedPeerId = options.peer as string | undefined
      if (pinnedPeerId !== undefined && !/^(0x)?[0-9a-f]{40}$/i.test(pinnedPeerId)) {
        console.error(chalk.red('Error: --peer must be a 40-character hex peer ID (EVM address).'))
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
      const routerName = resolveBuyerRouterName({ router: options.router as string | undefined })

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
        // Refresh stale plugins before importing them. Best-effort; see
        // ensurePluginsUpToDate / plugins/drift.ts for the full rationale.
        await ensurePluginsUpToDate([resolvePluginPackage(instance.package)])
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
      } else {
        // Refresh stale plugins before importing them. Best-effort; see
        // ensurePluginsUpToDate / plugins/drift.ts for the full rationale.
        await ensurePluginsUpToDate([resolvePluginPackage(routerName)])
        const spinner = ora(`Loading router plugin "${routerName}"...`).start()
        try {
          const plugin = await loadRouterPlugin(routerName)
          const runtimeEnv = buildRouterRuntimeEnvFromBuyerConfig(effectiveBuyerConfig)
          const pluginConfig = buildPluginConfig(plugin.configSchema ?? plugin.configKeys ?? [], runtimeEnv)
          router = await plugin.createRouter(pluginConfig)
          spinner.succeed(chalk.green(`Router "${plugin.displayName}" loaded`))
          toolHints = (plugin as any).TOOL_HINTS ?? []
        } catch (err) {
          spinner.fail(chalk.red(`Failed to load router: ${(err as Error).message}`))
          process.exit(1)
        }
      }

      const seederInfo = await getLocalSeederInfo(globalOpts.dataDir)
      const allBootstrapEntries = buildBuyerBootstrapEntries(config.network?.bootstrapNodes, seederInfo?.dhtPort)
      const bootstrapNodes = toBootstrapConfig(parseBootstrapList(allBootstrapEntries))

      const nodeSpinner = ora('Connecting to P2P network...').start()

      let paymentsConfig: NodePaymentsConfig | undefined
      const settlementEnv = parseOptionalBoolEnv(process.env['ANTSEED_ENABLE_SETTLEMENT'])
      const cryptoOverrides = config.payments?.crypto
      const chainConfig = resolveChainConfig({
        chainId: cryptoOverrides?.chainId,
        rpcUrl: cryptoOverrides?.rpcUrl,
        depositsContractAddress: cryptoOverrides?.depositsContractAddress,
        channelsContractAddress: cryptoOverrides?.channelsContractAddress,
        usdcContractAddress: cryptoOverrides?.usdcContractAddress,
      })
      let settlementEnabled = settlementEnv ?? true

      if (settlementEnabled && settlementEnv !== true) {
        const rpcUp = await isRpcReachable(chainConfig.rpcUrl)
        if (!rpcUp) {
          settlementEnabled = false
          console.log(chalk.yellow(`Payments disabled: RPC node unreachable at ${chainConfig.rpcUrl}`))
          console.log(chalk.dim('Start your chain node or set ANTSEED_ENABLE_SETTLEMENT=true to force-enable payments.'))
        }
      }

      if (settlementEnabled) {
        paymentsConfig = {
          enabled: true,
          rpcUrl: chainConfig.rpcUrl,
          ...(chainConfig.fallbackRpcUrls ? { fallbackRpcUrls: chainConfig.fallbackRpcUrls } : {}),
          depositsAddress: chainConfig.depositsContractAddress,
          channelsAddress: chainConfig.channelsContractAddress,
          usdcAddress: chainConfig.usdcContractAddress,
          // Staking + identity registry addresses let the buyer-side node wire
          // a StakingClient and IdentityClient. Without stakingAddress, the
          // on-chain verification loop in AntseedNode.discoverPeers() is
          // skipped entirely, so `onChainTotalVolumeUsdcMicros` and
          // `onChainLastSettledAtSec` never populate on PeerInfo (and end up
          // as `null` in buyer.state.json).
          ...(chainConfig.stakingContractAddress ? { stakingAddress: chainConfig.stakingContractAddress } : {}),
          ...(chainConfig.identityRegistryAddress ? { identityRegistryAddress: chainConfig.identityRegistryAddress } : {}),
          chainId: chainConfig.evmChainId,
          defaultDepositAmountUSDC: cryptoOverrides?.defaultLockAmountUSDC
            ? String(Math.round(parseFloat(cryptoOverrides.defaultLockAmountUSDC) * 1_000_000))
            : '1000000',
          platformFeeRate: config.payments?.platformFeeRate,
          // $0.30 overdraft window per channel — large enough that a single
          // typical long-context request (~$0.05–$0.15 on the priciest
          // published models) fits within verifiedCost + maxPerRequest, so the
          // budget-exhausted 402 catch-up closes in a single signature. Set
          // conservatively to bound the worst-case exposure a malicious
          // seller can extract via an inflated 402 target (per 402 round trip).
          maxPerRequestUsdc: config.payments?.maxPerRequestUsdc ?? '300000',
          maxReserveAmountUsdc: config.payments?.maxReserveAmountUsdc ?? '1000000',
        }
      }

      const resolvedRouterName = options.instance
        ? (await getInstance(join(homedir(), '.antseed', 'config.json'), options.instance))?.package
        : routerName
      const versions = getPackageVersions(resolvedRouterName ?? undefined)
      if (Object.keys(versions).length > 0) {
        console.log(chalk.dim(`Package versions: ${Object.entries(versions).map(([k, v]) => `${k}@${v}`).join(', ')}`))
      }
      console.log(chalk.bold('Effective buyer settings:'))
      console.log(chalk.dim(`  max pricing defaults (USD/1M): input=${effectiveBuyerConfig.maxPricing.defaults.inputUsdPerMillion}, output=${effectiveBuyerConfig.maxPricing.defaults.outputUsdPerMillion}`))
      const maxPerRequestUsdc = config.payments?.maxPerRequestUsdc ?? '300000'
      const maxReserveAmountUsdc = config.payments?.maxReserveAmountUsdc ?? '1000000'
      console.log(chalk.dim(`  max per-request USDC: ${(Number(maxPerRequestUsdc) / 1_000_000).toFixed(6)}`))
      console.log(chalk.dim(`  max reserve USDC: ${(Number(maxReserveAmountUsdc) / 1_000_000).toFixed(6)}`))
      console.log(chalk.dim(`  min peer reputation: ${effectiveBuyerConfig.minPeerReputation}`))
      console.log(chalk.dim(`  proxy port: ${effectiveBuyerConfig.proxyPort}`))
      if (pinnedPeerId) {
        console.log(chalk.yellow(`  pinned peer: ${pinnedPeerId} (router bypassed)`))
      } else {
        console.log(chalk.yellow('  pinned peer: none — auto-selection is disabled, requests will 409 until a peer is pinned'))
        console.log(chalk.dim('    Pin a peer with:  antseed network browse → antseed buyer connection set --peer <peerId>'))
        console.log(chalk.dim('    Or per-request:   x-antseed-pin-peer: <peerId> header'))
      }
      console.log('')

      const node = new AntseedNode({
        role: 'buyer',
        bootstrapNodes,
        allowPrivateIPs: true,
        dataDir: globalOpts.dataDir,
        configPath: globalOpts.config,
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

      if (paymentsConfig?.enabled) {
        try {
          const identity = node.identity!
          const address = identity.wallet.address
          const depositsClient = new DepositsClient({
            rpcUrl: chainConfig.rpcUrl,
            ...(chainConfig.fallbackRpcUrls ? { fallbackRpcUrls: chainConfig.fallbackRpcUrls } : {}),
            contractAddress: chainConfig.depositsContractAddress,
            usdcAddress: chainConfig.usdcContractAddress,
            evmChainId: chainConfig.evmChainId,
          })
          const account = await depositsClient.getBuyerBalance(address)
          console.log(chalk.dim(`Wallet: ${address}`))
          const availUsdc = Number(account.available) / 1_000_000
          console.log(chalk.dim(`Deposits available: ${availUsdc.toFixed(6)} USDC`))
        } catch {
          console.log(chalk.dim('Payment balance unavailable (chain not reachable)'))
        }
      }

      const proxyPort = effectiveBuyerConfig.proxyPort
      const proxySpinner = ora(`Starting local proxy on port ${proxyPort}...`).start()
      const proxy = new BuyerProxy({ port: proxyPort, node, pinnedPeerId, dataDir: globalOpts.dataDir })
      let ownsProxyListener = false

      try {
        await proxy.start()
        ownsProxyListener = true
        proxySpinner.succeed(chalk.green(`Proxy listening on http://localhost:${proxyPort}`))
      } catch (err) {
        if (isAddrInUseError(err) && await isCompatibleBuyerProxy(proxyPort)) {
          proxySpinner.succeed(chalk.yellow(`Proxy port ${proxyPort} already in use; reusing existing local proxy.`))
          console.log(chalk.yellow('Proxy request logs will be emitted by the process that already owns this port.'))
        } else {
          proxySpinner.fail(chalk.red(`Failed to start proxy: ${(err as Error).message}`))
          await node.stop()
          process.exit(1)
        }
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
        if (ownsProxyListener) await proxy.stop()
        await node.stop()
        nodeSpinner.succeed('Disconnected. All channels finalized.')
      })
    })
}

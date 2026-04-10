import type { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { writeFile, unlink } from 'node:fs/promises'
import { join, resolve, isAbsolute, dirname } from 'node:path'
import { homedir } from 'node:os'
import { getGlobalOptions } from './types.js'
import { loadConfig } from '../../config/loader.js'
import type { CLIProviderConfig } from '../../config/types.js'
import { AntseedNode, type Provider, getInstance, resolveChainConfig, loadOrCreateIdentity } from '@antseed/node'
import type { PaymentConfig } from '@antseed/node/payments'
import { checkSellerReadiness } from '@antseed/node/payments'
import {
  createIdentityClient,
  createStakingClient,
} from '../payment-utils.js'
import type { AntseedConfig } from '../../config/types.js'
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import { setupShutdownHandler } from '../shutdown.js'
import { loadProviderPlugin, buildPluginConfig, getPackageVersions } from '../../plugins/loader.js'
import { resolveEffectiveSellerConfig, type SellerRuntimeOverrides } from '../../config/effective.js'
import type { SellerCLIConfig } from '../../config/types.js'
import { AntAgentProvider, loadAntAgent, type AntAgentDefinition } from '@antseed/ant-agent'

function getStateFile(dataDir: string): string {
  return join(dataDir, 'daemon.state.json')
}

/** Map config file provider entry to env-style key/value pairs for the plugin. */
function providerConfigToEnv(p: CLIProviderConfig): Record<string, string> {
  const env: Record<string, string> = {}
  if (p.authValue) env['ANTHROPIC_API_KEY'] = p.authValue
  if (p.authType) env['ANTSEED_AUTH_TYPE'] = p.authType
  return env
}

function parseOptionalBoolEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

/**
 * Gate `antseed seed` on required prerequisites:
 *   1. At least one service is configured for the selected provider.
 *   2. (When payments are enabled) seller is registered on-chain and staked.
 * Runtime pricing overrides that would be silently ignored (because the
 * providers map is empty) are also flagged as a hard error here.
 *
 * On failure: print a clear list of what's missing with the exact command(s)
 * to fix each one, then throw. Callers should catch and `process.exit(1)`.
 */
export async function assertSellerPrerequisites(input: {
  dataDir: string
  config: AntseedConfig
  effectiveSeller: SellerCLIConfig
  providerName: string
  paymentsEnabled: boolean
  runtimePricingOverride: boolean
  skipChainChecks: boolean
}): Promise<void> {
  const {
    dataDir,
    config,
    effectiveSeller,
    providerName,
    paymentsEnabled,
    runtimePricingOverride,
    skipChainChecks,
  } = input

  const failures: Array<{ title: string; detail: string; command?: string }> = []

  // 1. Provider has at least one service configured.
  const providerCfg = effectiveSeller.providers[providerName]
  const serviceCount = providerCfg ? Object.keys(providerCfg.services).length : 0
  if (serviceCount === 0) {
    failures.push({
      title: `No services configured for provider "${providerName}"`,
      detail: 'A seller must announce at least one service. Add one with:',
      command: `antseed config seller add-service ${providerName} <serviceId> --input <usd> --output <usd>`,
    })
  }

  // 2. Runtime pricing override was supplied but would silently no-op because
  // no providers are configured. This is the Greptile P2 flag from PR #275.
  if (runtimePricingOverride && Object.keys(effectiveSeller.providers).length === 0) {
    failures.push({
      title: 'Pricing override has nothing to apply to',
      detail: `--input-usd-per-million / --output-usd-per-million (or ANTSEED_SELLER_*_USD_PER_MILLION env) were supplied, but no providers are configured in seller.providers. The override would silently no-op.`,
      command: `antseed config seller add-service ${providerName} <serviceId> --input <usd> --output <usd>`,
    })
  }

  // 3. On-chain readiness — only when payments are actually on.
  if (paymentsEnabled && config.payments.crypto && !skipChainChecks) {
    try {
      const identity = await loadOrCreateIdentity(dataDir)
      const identityClient = createIdentityClient(config)
      const stakingClient = createStakingClient(config)
      const checks = await checkSellerReadiness(identity, identityClient, stakingClient)
      for (const check of checks) {
        if (!check.passed) {
          failures.push({
            title: check.name,
            detail: check.message,
            command: check.command,
          })
        }
      }
    } catch (err) {
      // If we can't even reach the chain, surface the error rather than
      // silently skipping — that's what broke testnet-together earlier today.
      failures.push({
        title: 'On-chain readiness check failed',
        detail: `Could not query the configured chain (${(err as Error).message}). Set payments.crypto.rpcUrl or pass --skip-prereq-check to bypass.`,
      })
    }
  }

  if (failures.length === 0) return

  console.error(chalk.red('\nCannot start seeding — prerequisites not met:\n'))
  for (const f of failures) {
    console.error(`  ${chalk.red('✗')} ${chalk.bold(f.title)}`)
    console.error(`    ${chalk.dim(f.detail)}`)
    if (f.command) {
      console.error(`    ${chalk.cyan(f.command)}`)
    }
    console.error('')
  }
  console.error(chalk.dim('Run `antseed setup --role provider` for a guided walkthrough, or pass --skip-prereq-check to bypass all checks (not recommended).'))
  throw new Error('seller prerequisites not met')
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

function toUSDCBaseUnits(value: string | undefined, fallbackBaseUnits: string): string {
  if (value === undefined) return fallbackBaseUnits
  const parsed = Number.parseFloat(value.trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackBaseUnits
  return String(Math.round(parsed * 1_000_000))
}

export function buildSellerRuntimeOverridesFromFlags(options: {
  reserve?: number
  inputUsdPerMillion?: number
  outputUsdPerMillion?: number
}): SellerRuntimeOverrides {
  const overrides: SellerRuntimeOverrides = {}
  if (options.reserve !== undefined) {
    overrides.reserveFloor = options.reserve
  }
  if (options.inputUsdPerMillion !== undefined) {
    overrides.inputUsdPerMillion = options.inputUsdPerMillion
  }
  if (options.outputUsdPerMillion !== undefined) {
    overrides.outputUsdPerMillion = options.outputUsdPerMillion
  }
  return overrides
}

/**
 * Translate the unified `seller.providers[name]` block into the flat
 * `ANTSEED_*` env keys that provider plugins consume. Plugins continue to
 * receive the same shape they always have — the CLI just produces it from
 * config.json instead of having users set env vars by hand.
 */
export function buildSellerPluginRuntimeEnv(
  sellerConfig: SellerCLIConfig,
  providerName: string,
): Record<string, string> {
  const providerCfg = sellerConfig.providers?.[providerName]
  const runtimeEnv: Record<string, string> = {
    ANTSEED_MAX_CONCURRENCY: String(sellerConfig.maxConcurrentBuyers),
  }
  if (!providerCfg) {
    return runtimeEnv
  }

  if (providerCfg.defaults) {
    runtimeEnv['ANTSEED_INPUT_USD_PER_MILLION'] = String(providerCfg.defaults.inputUsdPerMillion)
    runtimeEnv['ANTSEED_OUTPUT_USD_PER_MILLION'] = String(providerCfg.defaults.outputUsdPerMillion)
    if (providerCfg.defaults.cachedInputUsdPerMillion != null) {
      runtimeEnv['ANTSEED_CACHED_INPUT_USD_PER_MILLION'] = String(providerCfg.defaults.cachedInputUsdPerMillion)
    }
  }

  const serviceIds = Object.keys(providerCfg.services)
  if (serviceIds.length > 0) {
    runtimeEnv['ANTSEED_ALLOWED_SERVICES'] = serviceIds.join(',')
  }

  // Per-service pricing: { serviceId -> TokenPricingUsdPerMillion }
  // Note: categories are NOT emitted as an env var. No plugin reads
  // ANTSEED_SERVICE_CATEGORIES_JSON — the CLI writes them directly onto
  // `provider.serviceCategories` in seed.ts below. Keeping categories out of
  // the plugin env avoids dead noise in process.env.
  const servicePricing: Record<string, unknown> = {}
  const serviceAliasMap: Record<string, string> = {}
  for (const [serviceId, serviceCfg] of Object.entries(providerCfg.services)) {
    if (serviceCfg.pricing) {
      servicePricing[serviceId] = serviceCfg.pricing
    }
    if (serviceCfg.upstreamModel && serviceCfg.upstreamModel !== serviceId) {
      serviceAliasMap[serviceId] = serviceCfg.upstreamModel
    }
  }
  if (Object.keys(servicePricing).length > 0) {
    runtimeEnv['ANTSEED_SERVICE_PRICING_JSON'] = JSON.stringify(servicePricing)
  }
  if (Object.keys(serviceAliasMap).length > 0) {
    runtimeEnv['ANTSEED_SERVICE_ALIAS_MAP_JSON'] = JSON.stringify(serviceAliasMap)
  }
  if (providerCfg.baseUrl) {
    runtimeEnv['OPENAI_BASE_URL'] = providerCfg.baseUrl
  }

  return runtimeEnv
}

export function mergeSellerRuntimeEnv(
  baseConfig: Record<string, string>,
  runtimeEnv: Record<string, string>,
  options?: {
    forcePricingOverride?: boolean
  },
): Record<string, string> {
  const merged = { ...baseConfig }
  const forcePricingOverride = options?.forcePricingOverride ?? false
  const pricingKeys = new Set([
    'ANTSEED_INPUT_USD_PER_MILLION',
    'ANTSEED_OUTPUT_USD_PER_MILLION',
  ])

  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (!forcePricingOverride && pricingKeys.has(key) && merged[key] !== undefined) {
      continue
    }
    merged[key] = value
  }

  return merged
}



export function registerSeedCommand(program: Command): void {
  program
    .command('seed')
    .description('Start providing AI services on the P2P network')
    .option('--provider <name>', 'provider plugin name (e.g., anthropic)')
    .option('--instance <id>', 'use a configured plugin instance by ID')
    .option('-r, --reserve <number>', 'runtime-only reserve floor override (does not write config file)', parseFloat)
    .option('--input-usd-per-million <number>', 'runtime-only input pricing override in USD per 1M tokens', parseFloat)
    .option('--output-usd-per-million <number>', 'runtime-only output pricing override in USD per 1M tokens', parseFloat)
    .option('--dht-port <number>', 'UDP port for DHT (default: 6881)', parseInt)
    .option('--signaling-port <number>', 'TCP port for P2P signaling (default: 6882)', parseInt)
    .option('--skip-prereq-check', 'skip pre-flight checks (services configured, on-chain registration + stake). Use only for local testing.')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program)
      const config = await loadConfig(globalOpts.config)
      const runtimeOverrides = buildSellerRuntimeOverridesFromFlags({
        reserve: options.reserve as number | undefined,
        inputUsdPerMillion: options.inputUsdPerMillion as number | undefined,
        outputUsdPerMillion: options.outputUsdPerMillion as number | undefined,
      })
      const forcePricingOverride = runtimeOverrides.inputUsdPerMillion !== undefined
        || runtimeOverrides.outputUsdPerMillion !== undefined
      const effectiveSellerConfig = resolveEffectiveSellerConfig({
        config,
        sellerOverrides: runtimeOverrides,
      })

      let provider: Provider

      if (options.instance) {
        const configPath = join(homedir(), '.antseed', 'config.json')
        const instance = await getInstance(configPath, options.instance)
        if (!instance) {
          console.error(chalk.red(`Instance "${options.instance}" not found.`))
          process.exit(1)
        }
        if (instance.type !== 'provider') {
          console.error(chalk.red(`Instance "${options.instance}" is a ${instance.type}, not a provider.`))
          process.exit(1)
        }
        const spinner = ora(`Loading provider plugin "${instance.package}"...`).start()
        try {
          const plugin = await loadProviderPlugin(instance.package)
          const runtimeEnv = buildSellerPluginRuntimeEnv(effectiveSellerConfig, plugin.name)
          const basePluginConfig = buildPluginConfig(
            plugin.configSchema ?? plugin.configKeys ?? [],
            undefined,
            instance.config as Record<string, string>,
          )
          const pluginConfig = mergeSellerRuntimeEnv(basePluginConfig, runtimeEnv, { forcePricingOverride })
          provider = await plugin.createProvider(pluginConfig)
          if (provider.init) {
            spinner.text = 'Validating credentials...'
            await provider.init()
          }
          spinner.succeed(chalk.green(`Provider "${plugin.displayName}" loaded`))
        } catch (err) {
          spinner.fail(chalk.red(`Failed to load provider: ${(err as Error).message}`))
          process.exit(1)
        }
      } else if (options.provider) {
        const spinner = ora(`Loading provider plugin "${options.provider}"...`).start()
        try {
          const plugin = await loadProviderPlugin(options.provider)
          const configProvider = config.providers.find(p => p.type === options.provider)
          const fileConfig = configProvider ? providerConfigToEnv(configProvider) : {}
          const runtimeEnv = buildSellerPluginRuntimeEnv(effectiveSellerConfig, options.provider as string)
          const envAndFileConfig = buildPluginConfig(plugin.configSchema ?? plugin.configKeys ?? [], undefined, fileConfig)
          const pluginConfig = mergeSellerRuntimeEnv(envAndFileConfig, runtimeEnv, { forcePricingOverride })
          provider = await plugin.createProvider(pluginConfig)
          if (provider.init) {
            spinner.text = 'Validating credentials...'
            await provider.init()
          }
          spinner.succeed(chalk.green(`Provider "${plugin.displayName}" loaded`))
        } catch (err) {
          spinner.fail(chalk.red(`Failed to load provider: ${(err as Error).message}`))
          process.exit(1)
        }
      } else {
        console.error(chalk.red('Error: No provider specified.'))
        console.error(chalk.dim('Run: antseed seed --provider <name>  or  antseed seed --instance <id>'))
        process.exit(1)
      }

      const bootstrapNodes = config.network.bootstrapNodes.length > 0
        ? toBootstrapConfig(parseBootstrapList(config.network.bootstrapNodes))
        : undefined

      const preferredMethod = config.payments.preferredMethod
      const defaultDepositAmountUSDC = process.env['ANTSEED_DEFAULT_DEPOSIT_USDC'] ?? config.payments.crypto?.defaultLockAmountUSDC ?? '1'
      const defaultDepositAmountUSDCBaseUnits = toUSDCBaseUnits(defaultDepositAmountUSDC, '1000000')
      const settlementIdleMsRaw = process.env['ANTSEED_SETTLEMENT_IDLE_MS']
      const settlementIdleMs = settlementIdleMsRaw ? parseInt(settlementIdleMsRaw, 10) : 600_000
      const sellerWalletAddress = process.env['ANTSEED_SELLER_WALLET_ADDRESS']

      let paymentConfig: PaymentConfig | null = null
      if (preferredMethod === 'crypto') {
        const cc = resolveChainConfig({
          chainId: config.payments.crypto?.chainId,
          rpcUrl: config.payments.crypto?.rpcUrl,
          depositsContractAddress: config.payments.crypto?.depositsContractAddress,
          channelsContractAddress: config.payments.crypto?.channelsContractAddress,
          usdcContractAddress: config.payments.crypto?.usdcContractAddress,
        })
        const defaultLockAmountUSDCBaseUnits = toUSDCBaseUnits(
          config.payments.crypto?.defaultLockAmountUSDC ?? defaultDepositAmountUSDC,
          defaultDepositAmountUSDCBaseUnits,
        )
        const cryptoConfig: NonNullable<PaymentConfig['crypto']> = {
          chainId: cc.chainId,
          rpcUrl: cc.rpcUrl,
          depositsContractAddress: cc.depositsContractAddress,
          channelsContractAddress: cc.channelsContractAddress,
          usdcAddress: cc.usdcContractAddress,
          defaultLockAmountUSDC: defaultLockAmountUSDCBaseUnits,
        }

        paymentConfig = {
          crypto: cryptoConfig,
        }
      }

      const settlementEnv = parseOptionalBoolEnv(process.env['ANTSEED_ENABLE_SETTLEMENT'])
      let paymentsEnabled = settlementEnv ?? paymentConfig !== null
      const cryptoRpcUrl = paymentConfig?.crypto?.rpcUrl

      if (paymentsEnabled && cryptoRpcUrl && settlementEnv !== true) {
        const rpcUp = await isRpcReachable(cryptoRpcUrl)
        if (!rpcUp) {
          paymentsEnabled = false
          console.log(chalk.yellow(`Payments disabled: RPC node unreachable at ${cryptoRpcUrl}`))
          console.log(chalk.dim('Start your chain node or set ANTSEED_ENABLE_SETTLEMENT=true to force-enable payments.'))
        }
      }

      const providerName = options.provider as string | undefined ?? provider.name ?? 'unknown'

      // Pre-flight: refuse to start if the user hasn't added any services,
      // hasn't registered on-chain, or hasn't staked. A clear error is much
      // better than a seller peer that's online but can't take requests.
      try {
        await assertSellerPrerequisites({
          dataDir: globalOpts.dataDir,
          config,
          effectiveSeller: effectiveSellerConfig,
          providerName,
          paymentsEnabled,
          runtimePricingOverride: forcePricingOverride,
          skipChainChecks: Boolean(options.skipPrereqCheck),
        })
      } catch {
        process.exit(1)
      }

      // Write service categories directly from config onto the plugin's
      // Provider object — plugins don't parse this env key themselves.
      const configProviderCfg = effectiveSellerConfig.providers?.[providerName]
      if (configProviderCfg) {
        const categoriesByService: Record<string, string[]> = {}
        for (const [serviceId, svc] of Object.entries(configProviderCfg.services)) {
          if (svc.categories && svc.categories.length > 0) {
            categoriesByService[serviceId] = [...svc.categories]
          }
        }
        if (Object.keys(categoriesByService).length > 0) {
          provider.serviceCategories = categoriesByService
        }
      }

      const versions = getPackageVersions(providerName)
      if (Object.keys(versions).length > 0) {
        console.log(chalk.dim(`Package versions: ${Object.entries(versions).map(([k, v]) => `${k}@${v}`).join(', ')}`))
      }
      console.log(chalk.bold('Effective seller settings:'))
      console.log(chalk.dim(`  provider: ${providerName}`))
      console.log(
        chalk.dim(
          `  pricing defaults (USD/1M): input=${provider.pricing.defaults.inputUsdPerMillion}, output=${provider.pricing.defaults.outputUsdPerMillion}`
        )
      )
      console.log(
        chalk.dim(
          `  enabled providers: ${effectiveSellerConfig.enabledProviders.length > 0 ? effectiveSellerConfig.enabledProviders.join(', ') : '(none)'}`
        )
      )
      const minBudgetPerRequest = config.payments.minBudgetPerRequest ?? '10000'
      console.log(chalk.dim(`  min budget per request: ${minBudgetPerRequest} base units`))
      console.log(chalk.dim(`  reserve floor: ${effectiveSellerConfig.reserveFloor}`))
      console.log(chalk.dim(`  max concurrent buyers: ${effectiveSellerConfig.maxConcurrentBuyers}`))
      console.log('')

      const nodeSpinner = ora('Starting seeding daemon...').start()

      const dhtPort = options.dhtPort as number | undefined
      const signalingPort = options.signalingPort as number | undefined

      const node = new AntseedNode({
        role: 'seller',
        displayName: config.identity.displayName,
        ...(config.seller.publicAddress ? { publicAddress: config.seller.publicAddress } : {}),
        bootstrapNodes,
        dataDir: globalOpts.dataDir,
        ...(dhtPort ? { dhtPort } : {}),
        ...(signalingPort ? { signalingPort } : {}),
        payments: {
          enabled: paymentsEnabled,
          paymentMethod: preferredMethod,
          platformFeeRate: config.payments.platformFeeRate,
          settlementIdleMs: Number.isFinite(settlementIdleMs) ? settlementIdleMs : 30_000,
          defaultDepositAmountUSDC: defaultDepositAmountUSDCBaseUnits,
          sellerWalletAddress,
          paymentConfig,
          minBudgetPerRequest: config.payments.minBudgetPerRequest ?? '10000',
          // Top-level fields required by the node for contract clients + EIP-712 domain
          ...(paymentConfig?.crypto ? {
            rpcUrl: paymentConfig.crypto.rpcUrl,
            depositsAddress: paymentConfig.crypto.depositsContractAddress,
            channelsAddress: paymentConfig.crypto.channelsContractAddress,
            usdcAddress: paymentConfig.crypto.usdcAddress,
            identityRegistryAddress: resolveChainConfig({ chainId: paymentConfig.crypto.chainId }).identityRegistryAddress,
            stakingAddress: resolveChainConfig({ chainId: paymentConfig.crypto.chainId }).stakingContractAddress,
            chainId: resolveChainConfig({ chainId: paymentConfig.crypto.chainId }).evmChainId,
          } : {}),
        },
      })

      // Wrap provider with ant agent if configured
      if (effectiveSellerConfig.agentDir) {
        const baseDir = globalOpts.config ? dirname(resolve(globalOpts.config)) : process.cwd()
        const resolvePath = (p: string) => isAbsolute(p) ? p : resolve(baseDir, p)

        try {
          if (typeof effectiveSellerConfig.agentDir === 'string') {
            // Single agent for all services
            const agentDef = await loadAntAgent(resolvePath(effectiveSellerConfig.agentDir))
            provider = new AntAgentProvider(provider, agentDef)
            const k = agentDef.knowledge.length
            console.log(chalk.dim(`  ant agent: "${agentDef.name}" (${k} knowledge module${k !== 1 ? 's' : ''})`))
          } else {
            // Per-service agents
            const agentMap: Record<string, AntAgentDefinition> = {}
            for (const [service, dir] of Object.entries(effectiveSellerConfig.agentDir)) {
              const agentDef = await loadAntAgent(resolvePath(dir))
              agentMap[service] = agentDef
              const k = agentDef.knowledge.length
              const label = service === '*' ? '(default)' : service
              console.log(chalk.dim(`  ant agent: "${agentDef.name}" → ${label} (${k} knowledge module${k !== 1 ? 's' : ''})`))
            }
            provider = new AntAgentProvider(provider, agentMap)
          }
        } catch (err) {
          console.error(chalk.red(`Failed to load ant agent: ${(err as Error).message}`))
          process.exit(1)
        }
      }

      node.registerProvider(provider)

      try {
        await node.start()
        nodeSpinner.succeed(chalk.green('Seeding active'))
        console.log(chalk.dim(`  Peer ID: ${node.peerId ?? 'unknown'}`))
        console.log(chalk.dim(`  DHT port: ${node.dhtPort}`))
        console.log(chalk.dim(`  Signaling port: ${node.signalingPort}`))
      } catch (err) {
        nodeSpinner.fail(chalk.red(`Failed to start seeding: ${(err as Error).message}`))
        process.exit(1)
      }

      // Write daemon state so dashboard and connect can discover this seeder
      const startedAt = Date.now()
      const syntheticSessionStarts = new Map<string, number>()
      let stateWriteInFlight = false
      let stateWritePending = false

      function formatUptime(): string {
        const ms = Date.now() - startedAt
        const s = Math.floor(ms / 1000)
        if (s < 60) return `${s}s`
        const m = Math.floor(s / 60)
        if (m < 60) return `${m}m ${s % 60}s`
        const h = Math.floor(m / 60)
        return `${h}h ${m % 60}m`
      }

      function buildDaemonState() {
        const now = Date.now()
        const cap = provider.getCapacity()
        const trackedSessions = node
          .getActiveSellerSessions()
          .filter((session) => !session.settling)
          .map((session) => ({
            sessionId: session.sessionId,
            buyerPeerId: session.buyerPeerId,
            provider: session.provider,
            startedAt: session.startedAt,
            lastActivityAt: session.lastActivityAt,
            totalRequests: session.totalRequests,
            totalTokens: session.totalTokens,
            avgLatencyMs: session.avgLatencyMs,
          }))

        const syntheticCount = Math.max(0, cap.current - trackedSessions.length)
        const syntheticIds = new Set<string>()
        const syntheticDetails: Array<{
          sessionId: string
          buyerPeerId: string
          provider: string
          startedAt: number
          lastActivityAt: number
          totalRequests: number
          totalTokens: number
          avgLatencyMs: number
        }> = []

        for (let i = 0; i < syntheticCount; i += 1) {
          const sessionId = `provider-slot-${i + 1}`
          syntheticIds.add(sessionId)

          const existingStart = syntheticSessionStarts.get(sessionId)
          const startedAtTs = typeof existingStart === 'number' ? existingStart : now
          syntheticSessionStarts.set(sessionId, startedAtTs)

          syntheticDetails.push({
            sessionId,
            buyerPeerId: 'unknown',
            provider: providerName,
            startedAt: startedAtTs,
            lastActivityAt: now,
            totalRequests: 0,
            totalTokens: 0,
            avgLatencyMs: 0,
          })
        }

        for (const existingId of syntheticSessionStarts.keys()) {
          if (!syntheticIds.has(existingId)) {
            syntheticSessionStarts.delete(existingId)
          }
        }

        const activeChannelDetails = [...trackedSessions, ...syntheticDetails]
        const activeChannelsCount = Math.max(node.getActiveSellerChannelCount(), cap.current)

        return {
          state: 'seeding',
          pid: process.pid,
          peerId: node.peerId,
          dhtPort: node.dhtPort,
          signalingPort: node.signalingPort,
          provider: providerName,
          defaultInputUsdPerMillion: provider.pricing.defaults.inputUsdPerMillion,
          defaultOutputUsdPerMillion: provider.pricing.defaults.outputUsdPerMillion,
          providerPricing: {
            [providerName]: {
              defaults: {
                inputUsdPerMillion: provider.pricing.defaults.inputUsdPerMillion,
                outputUsdPerMillion: provider.pricing.defaults.outputUsdPerMillion,
              },
              ...(provider.pricing.services ? { services: provider.pricing.services } : {}),
            },
          },
          ...(provider.serviceCategories
            ? {
                providerServiceCategories: {
                  [providerName]: {
                    services: provider.serviceCategories,
                  },
                },
              }
            : {}),
          startedAt,
          // Fields the dashboard reads
          peerCount: 0,
          activeChannels: activeChannelsCount,
          activeChannelDetails,
          capacityUsedPercent: cap.max > 0 ? Math.round((cap.current / cap.max) * 100) : 0,
          earningsToday: '0',
          tokensToday: 0,
          uptime: formatUptime(),
          updatedAt: now,
          proxyPort: null,
        }
      }

      async function writeDaemonState(): Promise<void> {
        if (stateWriteInFlight) {
          stateWritePending = true
          return
        }

        stateWriteInFlight = true
        try {
          await writeFile(getStateFile(globalOpts.dataDir), JSON.stringify(buildDaemonState(), null, 2))
        } finally {
          stateWriteInFlight = false
          if (stateWritePending) {
            stateWritePending = false
            await writeDaemonState()
          }
        }
      }

      function scheduleDaemonStateWrite(): void {
        void writeDaemonState().catch(() => {})
      }

      await writeDaemonState()
      node.on('connection', scheduleDaemonStateWrite)
      node.on('session:updated', scheduleDaemonStateWrite)
      node.on('session:finalized', scheduleDaemonStateWrite)

      // Refresh state file every 1s so the desktop dashboard reflects live counters.
      const stateInterval = setInterval(async () => {
        await writeDaemonState().catch(() => {})
      }, 1_000)

      setupShutdownHandler(async () => {
        clearInterval(stateInterval)
        node.off('connection', scheduleDaemonStateWrite)
        node.off('session:updated', scheduleDaemonStateWrite)
        node.off('session:finalized', scheduleDaemonStateWrite)
        nodeSpinner.start('Shutting down seeding daemon...')
        await node.stop()
        await unlink(getStateFile(globalOpts.dataDir)).catch(() => {})
        nodeSpinner.succeed('Seeding daemon stopped. Channels finalized.')
      })
    })
}

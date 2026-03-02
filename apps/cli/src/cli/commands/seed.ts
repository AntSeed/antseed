import type { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getGlobalOptions } from './types.js'
import { loadConfig } from '../../config/loader.js'
import type { CLIProviderConfig } from '../../config/types.js'
import { AntseedNode, type Provider, getInstance } from '@antseed/node'
import type { PaymentConfig } from '@antseed/node/payments'
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import { setupShutdownHandler } from '../shutdown.js'
import { loadProviderPlugin, buildPluginConfig } from '../../plugins/loader.js'
import { resolveEffectiveSellerConfig, type SellerRuntimeOverrides } from '../../config/effective.js'
import type { SellerCLIConfig } from '../../config/types.js'
import { parseOptionalBoolEnv, isRpcReachable } from '../payment-utils.js'

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

export function buildSellerPluginRuntimeEnv(
  sellerConfig: SellerCLIConfig,
  providerName: string,
): Record<string, string> {
  const providerPricing = sellerConfig.pricing.providers?.[providerName]
  const effectiveDefaults = providerPricing?.defaults ?? sellerConfig.pricing.defaults
  const modelPricing = providerPricing?.models
  const modelCategories = sellerConfig.modelCategories?.[providerName]
  const runtimeEnv: Record<string, string> = {
    ANTSEED_INPUT_USD_PER_MILLION: String(effectiveDefaults.inputUsdPerMillion),
    ANTSEED_OUTPUT_USD_PER_MILLION: String(effectiveDefaults.outputUsdPerMillion),
    ANTSEED_MAX_CONCURRENCY: String(sellerConfig.maxConcurrentBuyers),
  }
  if (modelPricing && Object.keys(modelPricing).length > 0) {
    runtimeEnv['ANTSEED_MODEL_PRICING_JSON'] = JSON.stringify(modelPricing)
  }
  if (modelCategories && Object.keys(modelCategories).length > 0) {
    runtimeEnv['ANTSEED_MODEL_CATEGORIES_JSON'] = JSON.stringify(modelCategories)
  }
  return runtimeEnv
}

function parseRuntimeModelPricingJson(
  raw: string | undefined,
): Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }> | undefined {
  if (!raw) {
    return undefined
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    const out: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }> = {}
    for (const [model, pricing] of Object.entries(parsed as Record<string, unknown>)) {
      if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) continue
      const input = Number((pricing as Record<string, unknown>)['inputUsdPerMillion'])
      const output = Number((pricing as Record<string, unknown>)['outputUsdPerMillion'])
      if (Number.isFinite(input) && Number.isFinite(output)) {
        out[model] = { inputUsdPerMillion: input, outputUsdPerMillion: output }
      }
    }
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

function parseRuntimeModelCategoriesJson(raw: string | undefined): Record<string, string[]> | undefined {
  if (!raw) {
    return undefined
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    const out: Record<string, string[]> = {}
    for (const [model, categoriesRaw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(categoriesRaw)) continue
      const categories = Array.from(
        new Set(
          categoriesRaw
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim().toLowerCase())
            .filter((entry) => entry.length > 0)
        )
      )
      if (categories.length > 0) {
        out[model] = categories
      }
    }
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
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
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program)
      const config = await loadConfig(globalOpts.config)
      const runtimeOverrides = buildSellerRuntimeOverridesFromFlags({
        reserve: options.reserve as number | undefined,
        inputUsdPerMillion: options.inputUsdPerMillion as number | undefined,
        outputUsdPerMillion: options.outputUsdPerMillion as number | undefined,
      })
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
          const pluginConfig = buildPluginConfig(plugin.configSchema ?? plugin.configKeys ?? [], runtimeEnv, instance.config as Record<string, string>)
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
          const envAndRuntimeConfig = buildPluginConfig(plugin.configSchema ?? plugin.configKeys ?? [], runtimeEnv)
          const pluginConfig = { ...fileConfig, ...envAndRuntimeConfig }
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
      const defaultEscrowAmountUSDC = process.env['ANTSEED_DEFAULT_ESCROW_USDC'] ?? config.payments.crypto?.defaultLockAmountUSDC ?? '1'
      const defaultEscrowAmountUSDCBaseUnits = toUSDCBaseUnits(defaultEscrowAmountUSDC, '1000000')
      const settlementIdleMsRaw = process.env['ANTSEED_SETTLEMENT_IDLE_MS']
      const settlementIdleMs = settlementIdleMsRaw ? parseInt(settlementIdleMsRaw, 10) : 30_000
      const sellerWalletAddress = process.env['ANTSEED_SELLER_WALLET_ADDRESS']

      let paymentConfig: PaymentConfig | null = null
      if (preferredMethod === 'crypto' && config.payments.crypto) {
        const defaultLockAmountUSDCBaseUnits = toUSDCBaseUnits(
          config.payments.crypto.defaultLockAmountUSDC ?? defaultEscrowAmountUSDC,
          defaultEscrowAmountUSDCBaseUnits,
        )
        const cryptoConfig: NonNullable<PaymentConfig['crypto']> = {
          chainId: config.payments.crypto.chainId,
          rpcUrl: config.payments.crypto.rpcUrl,
          contractAddress: config.payments.crypto.escrowContractAddress,
          usdcAddress: config.payments.crypto.usdcContractAddress,
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
      const runtimeProviderPricing = buildSellerPluginRuntimeEnv(effectiveSellerConfig, providerName)
      const runtimeInputUsdPerMillion = Number.parseFloat(runtimeProviderPricing['ANTSEED_INPUT_USD_PER_MILLION'] ?? '')
      const runtimeOutputUsdPerMillion = Number.parseFloat(runtimeProviderPricing['ANTSEED_OUTPUT_USD_PER_MILLION'] ?? '')
      const runtimeModelPricing = parseRuntimeModelPricingJson(runtimeProviderPricing['ANTSEED_MODEL_PRICING_JSON'])
      const runtimeModelCategories = parseRuntimeModelCategoriesJson(runtimeProviderPricing['ANTSEED_MODEL_CATEGORIES_JSON'])
      if (runtimeModelCategories) {
        provider.modelCategories = runtimeModelCategories
      }
      console.log(chalk.bold('Effective seller settings:'))
      console.log(chalk.dim(`  provider: ${providerName}`))
      console.log(
        chalk.dim(
          `  pricing defaults (USD/1M): input=${runtimeProviderPricing['ANTSEED_INPUT_USD_PER_MILLION']}, output=${runtimeProviderPricing['ANTSEED_OUTPUT_USD_PER_MILLION']}`
        )
      )
      console.log(
        chalk.dim(
          `  enabled providers: ${effectiveSellerConfig.enabledProviders.length > 0 ? effectiveSellerConfig.enabledProviders.join(', ') : '(none)'}`
        )
      )
      console.log(chalk.dim(`  reserve floor: ${effectiveSellerConfig.reserveFloor}`))
      console.log(chalk.dim(`  max concurrent buyers: ${effectiveSellerConfig.maxConcurrentBuyers}`))
      console.log('')

      const nodeSpinner = ora('Starting seeding daemon...').start()

      const dhtPort = options.dhtPort as number | undefined
      const signalingPort = options.signalingPort as number | undefined

      const node = new AntseedNode({
        role: 'seller',
        displayName: config.identity.displayName,
        bootstrapNodes,
        dataDir: globalOpts.dataDir,
        ...(dhtPort ? { dhtPort } : {}),
        ...(signalingPort ? { signalingPort } : {}),
        payments: {
          enabled: paymentsEnabled,
          paymentMethod: preferredMethod,
          platformFeeRate: config.payments.platformFeeRate,
          settlementIdleMs: Number.isFinite(settlementIdleMs) ? settlementIdleMs : 30_000,
          defaultEscrowAmountUSDC: defaultEscrowAmountUSDCBaseUnits,
          sellerWalletAddress,
          paymentConfig,
        },
      })

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

        const activeSessionDetails = [...trackedSessions, ...syntheticDetails]
        const activeSessionsCount = Math.max(node.getActiveSellerSessionCount(), cap.current)

        return {
          state: 'seeding',
          pid: process.pid,
          peerId: node.peerId,
          dhtPort: node.dhtPort,
          signalingPort: node.signalingPort,
          provider: providerName,
          defaultInputUsdPerMillion: Number.isFinite(runtimeInputUsdPerMillion) ? runtimeInputUsdPerMillion : undefined,
          defaultOutputUsdPerMillion: Number.isFinite(runtimeOutputUsdPerMillion) ? runtimeOutputUsdPerMillion : undefined,
          providerPricing: {
            [providerName]: {
              defaults: {
                inputUsdPerMillion: Number.isFinite(runtimeInputUsdPerMillion) ? runtimeInputUsdPerMillion : 0,
                outputUsdPerMillion: Number.isFinite(runtimeOutputUsdPerMillion) ? runtimeOutputUsdPerMillion : 0,
              },
              ...(runtimeModelPricing ? { models: runtimeModelPricing } : {}),
            },
          },
          ...(runtimeModelCategories
            ? {
                providerModelCategories: {
                  [providerName]: {
                    models: runtimeModelCategories,
                  },
                },
              }
            : {}),
          startedAt,
          // Fields the dashboard reads
          peerCount: 0,
          activeSessions: activeSessionsCount,
          activeSessionDetails,
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
        nodeSpinner.succeed('Seeding daemon stopped. Sessions finalized.')
      })
    })
}

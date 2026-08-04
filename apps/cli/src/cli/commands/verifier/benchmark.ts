import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import chalk from 'chalk'
import Table from 'cli-table3'
import { InvalidArgumentError, type Command } from 'commander'
import { VerificationStorage } from '@antseed/node'
import { loadConfig } from '../../../config/loader.js'
import {
  attestBenchmarkAudits,
  buildBenchmarkReport,
  estimateBenchmarkMaximumSpend,
  runBenchmarkObservation,
  type BenchmarkParticipantReport,
  type BenchmarkReportV1,
} from '../../../verifier/benchmark.js'
import {
  connectBenchmarkExecutionTransport,
  parseBenchmarkTransportMode,
  type BenchmarkTransportMode,
} from '../../../verifier/benchmark-transport.js'
import { startVerifierRuntime } from '../../../verifier/runtime.js'
import { getGlobalOptions } from '../types.js'
import { parseBenchmarkProbeCountFlag, parsePositiveIntFlag, parseUsdcBaseUnitsFlag } from './flags.js'

export function registerVerifierBenchmarkCommand(verifierCmd: Command): void {
  const benchmark = verifierCmd
    .command('benchmark')
    .description('Run and report local KBF observations against live peers')

  benchmark
    .command('run')
    .requiredOption('--service <id>', 'advertised service to benchmark')
    .option('--probes <n>', 'shared KBF probe count or auto', parseBenchmarkProbeCountFlag, 'auto')
    .requiredOption(
      '--max-total-usdc <amount>',
      'hard total seller-payment cap in USDC base units',
      parseUsdcBaseUnitsFlag,
    )
    .option('--target-concurrency <n>', 'participants tested concurrently', parsePositiveIntFlag, 2)
    .option('--probe-concurrency <n>', 'requests per participant', parsePositiveIntFlag, 2)
    .option('--transport <mode>', 'paid request transport: direct or proxy', parseBenchmarkTransportMode, 'direct')
    .option('--proxy-url <url>', 'local buyer proxy URL', 'http://127.0.0.1:8377')
    .option('--proxy-token-file <path>', 'buyer proxy audit token file')
    .option('--dry-run', 'discover and estimate cost without sending requests')
    .option('--resume <run-id>', 'resume an existing benchmark')
    .action(runBenchmarkCommand)

  benchmark
    .command('report')
    .requiredOption('--run <run-id>', 'benchmark run id')
    .option('--format <format>', 'table, json, or csv', 'table')
    .option('--out <path>', 'write report to this path')
    .action(reportBenchmarkCommand)

  benchmark
    .command('attest')
    .requiredOption('--run <run-id>', 'benchmark run id')
    .requiredOption('--audit-id <id...>', 'explicit completed audit ids to attest')
    .option('--evidence-uri-base <uri>', 'optional evidence publication base URI')
    .action(attestBenchmarkCommand)
}

async function runBenchmarkCommand(options: {
  service: string
  probes: number | 'auto'
  maxTotalUsdc: bigint
  targetConcurrency: number
  probeConcurrency: number
  transport: BenchmarkTransportMode
  proxyUrl: string
  proxyTokenFile?: string
  dryRun?: boolean
  resume?: string
}, command: Command): Promise<void> {
  const globalOptions = getGlobalOptions(command)
  const config = await loadConfig(globalOptions.config)
  const executionTransport = await connectBenchmarkExecutionTransport({
    options,
    responseAuthTimeoutMs: config.verifier?.probeRequestTimeoutMs ?? 120_000,
  })
  const runtime = await startVerifierRuntime({
    config,
    dataDir: globalOptions.dataDir,
    configPath: globalOptions.config,
    readiness: options.dryRun || executionTransport ? 'discover' : 'observe',
  })
  try {
    const run = await runBenchmarkObservation(runtime, {
      service: options.service,
      probeCount: options.probes,
      maxTotalUsdc: options.maxTotalUsdc,
      targetConcurrency: options.targetConcurrency,
      probeConcurrency: options.probeConcurrency,
      dryRun: options.dryRun ?? false,
      ...(options.resume ? { resumeRunId: options.resume } : {}),
    }, {
      log: (message) => console.log(chalk.dim(`[benchmark] ${message}`)),
      warn: (message) => console.warn(chalk.yellow(`[benchmark] ${message}`)),
      ...(executionTransport ? { executionTransport } : {}),
    })
    console.log(chalk.green(`${options.dryRun ? 'Planned' : 'Completed'} benchmark ${run.runId}`))
    console.log(chalk.dim(`  discovered: ${run.discoveredCount}`))
    console.log(chalk.dim(`  eligible: ${run.eligibleCount}`))
    console.log(chalk.dim(`  sizing: ${run.probeSizingMode}; selected probes: ${run.probeCount}`))
    if (run.achievedStatisticalPower !== null) {
      console.log(chalk.dim(
        `  statistical power: ${run.achievedStatisticalPower.toFixed(4)}; per-peer alpha: ${run.perPeerAlpha}`,
      ))
    }
    console.log(chalk.dim(`  completed: ${run.completedCount}`))
    console.log(chalk.dim(`  failed: ${run.failedCount}`))
    console.log(chalk.dim(`  spent: ${run.spentUsdc}/${run.maxTotalUsdc} USDC base units`))
    console.log(chalk.dim(`  paid request transport: ${executionTransport ? 'local buyer proxy' : 'direct buyer node'}`))
    if (executionTransport) {
      console.log(chalk.dim(`  payment identity: ${executionTransport.verifierAddress}`))
    }
    if (options.dryRun) {
      const maximumPerRequest = BigInt(config.payments.maxPerRequestUsdc ?? '300000')
      const estimated = estimateBenchmarkMaximumSpend({
        eligibleCount: run.eligibleCount,
        probeCount: run.probeCount,
        maxPerRequestUsdc: maximumPerRequest,
        maxTotalUsdc: BigInt(run.maxTotalUsdc),
      })
      console.log(chalk.dim(`  maximum planned seller spend: ${estimated} USDC base units`))
    }
    console.log(chalk.dim(`  report: antseed verifier benchmark report --run ${run.runId}`))
  } finally {
    await runtime.node.stop()
  }
}

async function reportBenchmarkCommand(options: {
  run: string
  format: string
  out?: string
}, command: Command): Promise<void> {
  const globalOptions = getGlobalOptions(command)
  const storage = new VerificationStorage(join(globalOptions.dataDir, 'verification.db'))
  try {
    const report = await buildBenchmarkReport(storage, options.run)
    const output = renderBenchmarkReport(report, parseReportFormat(options.format))
    if (options.out) {
      await mkdir(dirname(options.out), { recursive: true })
      await writeFile(options.out, output)
      console.log(chalk.green(`Wrote benchmark report to ${options.out}`))
    } else {
      console.log(output)
    }
  } finally {
    storage.close()
  }
}

async function attestBenchmarkCommand(options: {
  run: string
  auditId: string[]
  evidenceUriBase?: string
}, command: Command): Promise<void> {
  const globalOptions = getGlobalOptions(command)
  const config = await loadConfig(globalOptions.config)
  const runtime = await startVerifierRuntime({
    config,
    dataDir: globalOptions.dataDir,
    configPath: globalOptions.config,
    readiness: 'attest',
  })
  try {
    const results = await attestBenchmarkAudits({
      runtime,
      runId: options.run,
      auditIds: options.auditId,
      ...(options.evidenceUriBase ? { evidenceUriBase: options.evidenceUriBase } : {}),
      warn: (message) => console.warn(chalk.yellow(`[benchmark] ${message}`)),
    })
    for (const result of results) {
      console.log(chalk.green(`Attested ${result.auditId}`))
      console.log(chalk.dim(`  transaction: ${result.attestationTxHash}`))
    }
  } finally {
    await runtime.node.stop()
  }
}

export function renderBenchmarkReport(
  report: BenchmarkReportV1,
  format: 'table' | 'json' | 'csv',
): string {
  if (format === 'json') return JSON.stringify(report, null, 2)
  if (format === 'csv') return renderCsv(report.participants)

  const table = new Table({
    head: ['#', 'Peer', 'Agent', 'Status', 'Auth', 'Hamming', 'p-value', 'USDC', 'Reason'],
    wordWrap: true,
  })
  for (const participant of report.participants) {
    table.push([
      participant.ordinal,
      participant.displayName ? `${participant.displayName}\n${participant.peerId}` : participant.peerId,
      participant.agentId ?? '-',
      participant.status,
      `${participant.authenticatedProbeCount}/${participant.probeCount}`,
      participant.hammingErrors ?? '-',
      formatNumber(participant.oneSidedBinomialPValue),
      participant.sellerChargeUsdc,
      participant.reason ?? '-',
    ])
  }
  const lines = [
    `Benchmark ${report.run.runId}`,
    `Service ${report.run.service} | reference ${report.run.referenceId || '-'} (${report.run.referenceTrust})`,
    `Sizing ${report.run.probeSizingMode} | selected ${report.run.probeCount} probes | power ${formatNumber(report.reference.statisticalPower)} | per-peer alpha ${formatNumber(report.reference.perPeerAlpha)}`,
    `Discovered ${report.summary.discovered} | eligible ${report.summary.eligible} | SAME ${report.summary.same} | DIFF ${report.summary.diff} | UNDETERMINED ${report.summary.undetermined} | FAILED ${report.summary.failed} | INELIGIBLE ${report.summary.ineligible}`,
    `Spent ${report.run.spentUsdc}/${report.run.maxTotalUsdc} USDC base units`,
    table.toString(),
  ]
  return lines.join('\n')
}

function renderCsv(participants: readonly BenchmarkParticipantReport[]): string {
  const fields: Array<keyof BenchmarkParticipantReport> = [
    'ordinal',
    'peerId',
    'displayName',
    'agentId',
    'advertisedService',
    'status',
    'reason',
    'auditId',
    'coverage',
    'hammingErrors',
    'observedErrorRate',
    'referenceErrorUpperBound99',
    'oneSidedBinomialPValue',
    'modelShareBps',
    'authenticatedProbeCount',
    'probeCount',
    'sellerChargeUsdc',
    'p50TtftMs',
    'p95TtftMs',
    'p50OutputTokensPerSecondMilli',
    'evidencePath',
    'evidenceHash',
    'attestationTxHash',
  ]
  return [
    fields.join(','),
    ...participants.map((participant) => fields.map((field) => csvCell(participant[field])).join(',')),
  ].join('\n')
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function parseReportFormat(value: string): 'table' | 'json' | 'csv' {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'table' || normalized === 'json' || normalized === 'csv') return normalized
  throw new InvalidArgumentError('format must be table, json, or csv')
}

function formatNumber(value: number | null): string {
  if (value === null) return '-'
  return value < 0.0001 ? value.toExponential(2) : value.toFixed(4)
}

import { createInterface } from 'node:readline/promises'
import { join } from 'node:path'
import chalk from 'chalk'
import Table from 'cli-table3'
import type { Command } from 'commander'
import { loadConfig } from '../../../config/loader.js'
import { readVerifierRunManifest } from '../../../verifier/audit-artifacts.js'
import {
  listClaimableReferenceCosts,
  markReferenceCostsClaimed,
  reserveReferenceCosts,
} from '../../../verifier/probe-bank.js'
import { openResponseAuthReader } from '../../../verifier/response-auth-reader.js'
import { asError, normalized } from '../../../verifier/utils.js'
import {
  prepareModelVerificationBundle,
  readPreparedModelVerificationBundle,
  writeModelVerificationBundleEvidence,
  type PreparedModelVerificationBundle,
} from '../../../verifier/submission-bundles.js'
import {
  readSubmissionLedger,
  submissionLedgerPath,
  writeSubmissionLedger,
  type ModelSubmissionLedgerEntryV1,
  type SubmissionLedgerV1,
} from '../../../verifier/submission-ledger.js'
import { createVerifierClient, loadCryptoContext } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'

interface SubmitOptions {
  runId: string
  dryRun?: boolean
  yes?: boolean
  rpcUrl?: string
}

interface PreparedSubmission {
  bundle: PreparedModelVerificationBundle
  alreadySubmitted: boolean
  expectedAwardedCreditUsdMicros: bigint
}

interface PreparationFailure {
  model: string
  error: Error
}

export function registerVerifierSubmitCommand(verifierCmd: Command): void {
  verifierCmd
    .command('submit')
    .description('Submit one on-chain verification bundle per audited model')
    .requiredOption('--run-id <run-id>', 'completed verifier run ID')
    .option('--dry-run', 'validate and preview bundles without reserving costs or broadcasting')
    .option('--yes', 'submit without an interactive confirmation prompt')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .action(async (options: SubmitOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      const manifest = await readVerifierRunManifest(evidenceDir, options.runId)
      if (manifest.epochSource !== 'onchain') {
        throw new Error('only verifier runs created from an on-chain epoch can be submitted')
      }

      const rpcOverrides = options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {}
      const verifierClient = createVerifierClient(config, rpcOverrides)
      const { identity, address } = await loadCryptoContext(globalOptions.dataDir)
      const [window, network, approved, maxCreditUsdMicros, creditUsdMicrosBefore] = await Promise.all([
        verifierClient.currentEpochWindow(),
        verifierClient.provider.getNetwork(),
        verifierClient.approvedVerifier(address),
        verifierClient.maxCreditUsdMicrosPerVerifierPerEpoch(),
        verifierClient.epochCreditUsdMicros(BigInt(manifest.epoch), address),
      ])
      validateRunEpoch(manifest, window)
      if (!approved) throw new Error(`verifier wallet ${address} is not approved by the verification contract`)

      const ledgerPath = submissionLedgerPath(
        evidenceDir,
        network.chainId,
        verifierClient.contractAddress,
        manifest.runId,
      )
      const ledger = await readSubmissionLedger(ledgerPath) ?? newLedger({
        runId: manifest.runId,
        chainId: network.chainId,
        contractAddress: verifierClient.contractAddress,
        expectedEpoch: manifest.epoch,
      })
      validateLedger(ledger, manifest.runId, network.chainId, verifierClient.contractAddress, manifest.epoch)

      const responseAuthReader = await openResponseAuthReader({ dataDir: globalOptions.dataDir })
      try {
        const prepared: PreparedSubmission[] = []
        const preparationFailures: PreparationFailure[] = []
        let remainingPreviewCreditUsdMicros = maxCreditUsdMicros > creditUsdMicrosBefore
          ? maxCreditUsdMicros - creditUsdMicrosBefore
          : 0n
        for (const model of manifest.modelOrder) {
          const modelManifest = manifest.models.find((entry) => normalized(entry.model) === normalized(model))
          if (!modelManifest) {
            preparationFailures.push({ model, error: new Error('run manifest is missing the model summary') })
            continue
          }
          try {
            const existing = ledger.models[model]
            const bundle = existing
              ? await readPreparedModelVerificationBundle({
                evidencePath: existing.evidencePath,
                bundleId: existing.bundleId,
                evidenceHash: existing.evidenceHash,
              })
              : await prepareModelVerificationBundle({
                evidenceDir,
                manifest,
                model,
                modelSummaryPath: modelManifest.summaryPath,
                verifierAddress: address,
                requestCostLookup: responseAuthReader,
                referenceCosts: await listClaimableReferenceCosts(banksDir, model),
                resolveAgentOwner: (agentId) => verifierClient.agentOwner(agentId),
              })
            if (bundle.results.length === 0) throw new Error('no valid seller results remain after preflight validation')
            const alreadySubmitted = await verifierClient.isBundleSubmitted(bundle.bundleId)
            const expectedAwardedCreditUsdMicros = alreadySubmitted
              ? 0n
              : minBigInt(bundle.totalAuditCostUsdMicros, remainingPreviewCreditUsdMicros)
            if (!alreadySubmitted) remainingPreviewCreditUsdMicros -= expectedAwardedCreditUsdMicros
            prepared.push({ bundle, alreadySubmitted, expectedAwardedCreditUsdMicros })
          } catch (error) {
            preparationFailures.push({ model, error: asError(error) })
          }
        }

        printPreview(prepared, preparationFailures)
        if (options.dryRun) {
          console.log(chalk.dim('Dry run complete; no reference costs were reserved and no transactions were sent.'))
          if (preparationFailures.length > 0) process.exitCode = 1
          return
        }
        if (prepared.length === 0) {
          throw new Error('no model bundles are eligible for submission')
        }
        if (!options.yes) await confirmSubmission(prepared.filter((entry) => !entry.alreadySubmitted).length)

        let successfulBundles = 0
        let failedBundles = preparationFailures.length
        let skippedBundles = 0
        let submittedSellerResults = 0
        let totalAuditCostUsdMicros = 0n
        let awardedCreditUsdMicros = 0n

        for (const item of prepared) {
          const { bundle } = item
          totalAuditCostUsdMicros += bundle.totalAuditCostUsdMicros
          const now = new Date().toISOString()
          try {
            if (item.alreadySubmitted) {
              const event = await requireBundleEvent(verifierClient, bundle.bundleId)
              await markReferenceCostsClaimed({
                banksDir,
                model: bundle.model,
                bundleId: bundle.bundleId,
                transactionHash: event.transactionHash,
              })
              ledger.models[bundle.model] = ledgerEntry(bundle, {
                status: 'skipped',
                awardedCreditUsdMicros: event.awardedCreditUsdMicros.toString(),
                transactionHash: event.transactionHash,
                blockNumber: event.blockNumber,
                error: null,
                lastAttemptAt: now,
              })
              await writeSubmissionLedger(ledgerPath, ledger)
              skippedBundles += 1
              awardedCreditUsdMicros += event.awardedCreditUsdMicros
              submittedSellerResults += bundle.results.length
              console.log(chalk.dim(`${bundle.model}: bundle already submitted; skipping broadcast`))
              continue
            }

            await writeModelVerificationBundleEvidence(bundle)
            ledger.models[bundle.model] = ledgerEntry(bundle, {
              status: 'pending',
              awardedCreditUsdMicros: null,
              transactionHash: null,
              blockNumber: null,
              error: null,
              lastAttemptAt: now,
            })
            await writeSubmissionLedger(ledgerPath, ledger)
            await reserveReferenceCosts({
              banksDir,
              model: bundle.model,
              bundleId: bundle.bundleId,
              costIds: bundle.referenceCostIds,
            })

            const transactionHash = await verifierClient.submitVerificationBundle(identity.wallet, {
              bundleId: bundle.bundleId,
              expectedEpoch: bundle.expectedEpoch,
              totalAuditCostUsdMicros: bundle.totalAuditCostUsdMicros,
              evidenceHash: bundle.evidenceHash,
              results: bundle.results,
            })
            const event = await requireBundleEvent(verifierClient, bundle.bundleId)
            await markReferenceCostsClaimed({
              banksDir,
              model: bundle.model,
              bundleId: bundle.bundleId,
              transactionHash,
            })
            ledger.models[bundle.model] = ledgerEntry(bundle, {
              status: 'submitted',
              awardedCreditUsdMicros: event.awardedCreditUsdMicros.toString(),
              transactionHash,
              blockNumber: event.blockNumber,
              error: null,
              lastAttemptAt: new Date().toISOString(),
            })
            await writeSubmissionLedger(ledgerPath, ledger)
            successfulBundles += 1
            submittedSellerResults += bundle.results.length
            awardedCreditUsdMicros += event.awardedCreditUsdMicros
            console.log(chalk.green(
              `${bundle.model}: submitted ${bundle.results.length} seller result(s), `
              + `${formatCredits(event.awardedCreditUsdMicros)}/${formatCredits(bundle.totalAuditCostUsdMicros)} `
              + `credit(s) awarded (${transactionHash})`,
            ))
          } catch (error) {
            const failure = asError(error)
            ledger.models[bundle.model] = ledgerEntry(bundle, {
              status: 'failed',
              awardedCreditUsdMicros: null,
              transactionHash: ledger.models[bundle.model]?.transactionHash ?? null,
              blockNumber: null,
              error: failure.message,
              lastAttemptAt: new Date().toISOString(),
            })
            await writeSubmissionLedger(ledgerPath, ledger)
            failedBundles += 1
            console.warn(chalk.yellow(`${bundle.model}: submission failed (continuing): ${failure.message}`))
          }
        }

        for (const failure of preparationFailures) {
          console.warn(chalk.yellow(`${failure.model}: preflight failed: ${failure.error.message}`))
        }
        const creditUsdMicrosAfter = await verifierClient.epochCreditUsdMicros(BigInt(manifest.epoch), address)
        const remainingAllowanceUsdMicros = maxCreditUsdMicros > creditUsdMicrosAfter
          ? maxCreditUsdMicros - creditUsdMicrosAfter
          : 0n
        const costNotCreditedUsdMicros = prepared.reduce((total, item) => {
          const entry = ledger.models[item.bundle.model]
          const awarded = entry?.awardedCreditUsdMicros == null ? 0n : BigInt(entry.awardedCreditUsdMicros)
          return total + (item.bundle.totalAuditCostUsdMicros > awarded
            ? item.bundle.totalAuditCostUsdMicros - awarded
            : 0n)
        }, 0n)
        console.log(chalk.bold('Verification bundle submission summary'))
        console.log(`  Model bundles: ${prepared.length + preparationFailures.length}`)
        console.log(`  Submitted: ${successfulBundles}; skipped: ${skippedBundles}; failed: ${failedBundles}`)
        console.log(`  Seller results submitted: ${submittedSellerResults}`)
        console.log(`  Total audit cost: ${formatUsdMicros(totalAuditCostUsdMicros)} (${formatCredits(totalAuditCostUsdMicros)} credits)`)
        console.log(`  Awarded credit after epoch cap: ${formatCredits(awardedCreditUsdMicros)}`)
        console.log(
          `  Epoch credit balance: ${formatCredits(creditUsdMicrosBefore)} before, `
          + `${formatCredits(creditUsdMicrosAfter)} after; ${formatCredits(remainingAllowanceUsdMicros)} remaining`,
        )
        console.log(`  Audit cost not credited because of epoch cap: ${formatUsdMicros(costNotCreditedUsdMicros)}`)
        console.log(chalk.dim(`Submission ledger: ${ledgerPath}`))
        if (failedBundles > 0) process.exitCode = 1
      } finally {
        responseAuthReader.close()
      }
    })
}

function printPreview(prepared: PreparedSubmission[], failures: PreparationFailure[]): void {
  const table = new Table({
    head: ['Model', 'Results', 'SAME', 'DIFF', 'UNDET', 'Inference', 'Reference', 'Audit Cost', 'Expected Award'],
  })
  for (const item of prepared) {
    const verdictCounts = item.bundle.evidence.results.reduce((counts, result) => {
      counts[result.verdict] += 1
      return counts
    }, { SAME: 0, DIFF: 0, UNDETERMINED: 0 })
    table.push([
      item.bundle.model,
      item.bundle.results.length,
      verdictCounts.SAME,
      verdictCounts.DIFF,
      verdictCounts.UNDETERMINED,
      formatUsdMicros(BigInt(item.bundle.evidence.inferenceCostUsdMicros)),
      formatUsdMicros(BigInt(item.bundle.evidence.referenceCostUsdMicros)),
      formatUsdMicros(item.bundle.totalAuditCostUsdMicros),
      item.alreadySubmitted ? 'already submitted' : formatCredits(item.expectedAwardedCreditUsdMicros),
    ])
  }
  for (const failure of failures) {
    table.push([failure.model, 'BLOCKED', '—', '—', '—', '—', '—', '—', failure.error.message])
  }
  console.log(table.toString())
}

async function confirmSubmission(bundleCount: number): Promise<void> {
  if (bundleCount === 0) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('refusing non-interactive on-chain submission without --yes')
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Submit ${bundleCount} model bundle transaction(s)? [y/N] `)
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) throw new Error('submission cancelled')
  } finally {
    prompt.close()
  }
}

async function requireBundleEvent(
  verifierClient: ReturnType<typeof createVerifierClient>,
  bundleId: string,
) {
  const events = await verifierClient.queryBundles(bundleId)
  const event = events.at(-1)
  if (!event) throw new Error(`submitted bundle event not found for ${bundleId}`)
  return event
}

function ledgerEntry(
  bundle: PreparedModelVerificationBundle,
  state: Pick<ModelSubmissionLedgerEntryV1,
    'status' | 'awardedCreditUsdMicros' | 'transactionHash' | 'blockNumber' | 'error' | 'lastAttemptAt'>,
): ModelSubmissionLedgerEntryV1 {
  return {
    model: bundle.model,
    bundleId: bundle.bundleId,
    serviceHashes: bundle.results.map((result) => result.serviceHash),
    evidenceHash: bundle.evidenceHash,
    evidencePath: bundle.evidencePath,
    resultCount: bundle.results.length,
    inferenceCostUsdMicros: bundle.evidence.inferenceCostUsdMicros,
    referenceCostUsdMicros: bundle.evidence.referenceCostUsdMicros,
    totalAuditCostUsdMicros: bundle.totalAuditCostUsdMicros.toString(),
    referenceCostIds: bundle.referenceCostIds,
    ...state,
  }
}

function newLedger(input: {
  runId: string
  chainId: bigint
  contractAddress: string
  expectedEpoch: string
}): SubmissionLedgerV1 {
  const now = new Date().toISOString()
  return {
    version: 1,
    kind: 'antseed-verifier-submission-ledger',
    runId: input.runId,
    chainId: input.chainId.toString(),
    contractAddress: input.contractAddress,
    expectedEpoch: input.expectedEpoch,
    createdAt: now,
    updatedAt: now,
    models: {},
  }
}

function validateLedger(
  ledger: SubmissionLedgerV1,
  runId: string,
  chainId: bigint,
  contractAddress: string,
  expectedEpoch: string,
): void {
  if (ledger.runId !== runId
    || ledger.chainId !== chainId.toString()
    || normalized(ledger.contractAddress) !== normalized(contractAddress)
    || ledger.expectedEpoch !== expectedEpoch) {
    throw new Error('submission ledger does not match the selected run, chain, contract, and epoch')
  }
}

function validateRunEpoch(
  manifest: Awaited<ReturnType<typeof readVerifierRunManifest>>,
  window: { epoch: bigint; startedAt: number; endsAt: number },
): void {
  if (BigInt(manifest.epoch) !== window.epoch) {
    throw new Error(`run epoch ${manifest.epoch} does not match current on-chain epoch ${window.epoch}`)
  }
  const runStartedAt = Date.parse(manifest.startedAt)
  const runCompletedAt = Date.parse(manifest.completedAt)
  const epochStartedAt = window.startedAt * 1_000
  const epochEndsAt = window.endsAt * 1_000
  if (!Number.isFinite(runStartedAt) || !Number.isFinite(runCompletedAt)
    || runStartedAt < epochStartedAt || runCompletedAt > epochEndsAt) {
    throw new Error('verifier run timestamps are outside the current on-chain epoch window')
  }
}

function formatUsdMicros(value: bigint): string {
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, '0')
  return `$${whole}.${fraction}`
}

function formatCredits(value: bigint): string {
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${fraction}`
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right
}

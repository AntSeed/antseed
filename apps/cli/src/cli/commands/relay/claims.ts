import type { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'node:path'
import { getAddress, ZeroHash } from 'ethers'
import {
  extractContractResponseAuthSigningPayload,
  VerificationStorage,
  verifyResponseAuthExecutionWindow,
  type RelayEntitlementState,
  type StoredRelayEntitlement,
} from '@antseed/node'
import type { AuditJob, RelayAssignment, RelayClaim, VerifierRegistryClient } from '@antseed/node/payments'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { loadCryptoContext } from '../../payment-utils.js'
import { resolveVerificationChain } from '../verification-chain.js'

const ENTITLEMENT_STATES = new Set<RelayEntitlementState>([
  'awaiting-attestation',
  'paid',
  'challenge-available',
  'expired',
])

export function registerRelayClaimsCommand(relayCmd: Command): void {
  const claimsCmd = relayCmd
    .command('claims')
    .description('Recover embedded relay payouts')

  claimsCmd
    .command('list')
    .description('List relay payout entitlements after reconciling them with chain state')
    .option('--status <state>', 'filter by awaiting-attestation, paid, challenge-available, or expired')
    .option('--rpc-url <url>', 'runtime JSON-RPC override')
    .action(async (options, command: Command) => {
      const context = await openClaimsContext(command, options.rpcUrl as string | undefined)
      try {
        const status = options.status as RelayEntitlementState | undefined
        if (status && !ENTITLEMENT_STATES.has(status)) throw new Error(`invalid claim status ${status}`)
        await reconcileRelayEntitlements(context.storage, context.registryClient)
        const entitlements = context.storage.listRelayEntitlements(status)
        if (entitlements.length === 0) {
          console.log(chalk.dim('No relay entitlements found.'))
          return
        }
        for (const entitlement of entitlements) {
          console.log([
            entitlement.state.padEnd(20),
            entitlement.auditId,
            `job=${entitlement.jobIndex}`,
            `payout=${entitlement.payoutUsdc}`,
            entitlement.claimTxHash ? `tx=${entitlement.claimTxHash}` : '',
          ].filter(Boolean).join('  '))
        }
      } catch (error) {
        console.error(chalk.red((error as Error).message))
        process.exitCode = 1
      } finally {
        context.storage.close()
      }
    })

  registerForceClaimCommand(claimsCmd)
}

function registerForceClaimCommand(claimsCmd: Command): void {
  claimsCmd
    .command('force')
    .description('Permissionlessly claim an omitted valid relay payout')
    .option('--audit-id <id>', 'audit id')
    .option('--job-index <n>', 'job index', parseJobIndex)
    .option('--all', 'process every eligible entitlement serially', false)
    .option('--rpc-url <url>', 'runtime JSON-RPC override')
    .action(async (options, command: Command) => {
      const context = await openClaimsContext(command, options.rpcUrl as string | undefined)
      try {
        await reconcileRelayEntitlements(context.storage, context.registryClient)
        const candidates = options.all
          ? context.storage.listRelayEntitlements('challenge-available')
          : [requireEntitlement(context.storage, options.auditId, options.jobIndex)]
        if (candidates.length === 0) {
          console.log(chalk.dim('No force-claimable relay entitlements.'))
          return
        }
        let paid = 0
        let failed = 0
        for (const entitlement of candidates) {
          try {
            const txHash = await forceClaimEntitlement(
              context.storage,
              context.registryClient,
              context.signer,
              entitlement,
            )
            paid += 1
            console.log(chalk.green(`${entitlement.auditId}/${entitlement.jobIndex}: ${txHash}`))
          } catch (error) {
            failed += 1
            console.error(chalk.red(`${entitlement.auditId}/${entitlement.jobIndex}: ${(error as Error).message}`))
            if (!options.all) throw error
          }
        }
        if (options.all) console.log(chalk.dim(`Force claims complete: ${paid} paid, ${failed} failed.`))
        if (failed > 0) process.exitCode = 1
      } catch (error) {
        if (!options.all) console.error(chalk.red((error as Error).message))
        process.exitCode = 1
      } finally {
        context.storage.close()
      }
    })
}

async function openClaimsContext(command: Command, rpcUrlFlag?: string) {
  const globalOpts = getGlobalOptions(command)
  const config = await loadConfig(globalOpts.config)
  const chain = resolveVerificationChain(config, rpcUrlFlag)
  const { identity } = await loadCryptoContext(globalOpts.dataDir)
  return {
    storage: new VerificationStorage(join(globalOpts.dataDir, 'verification.db')),
    registryClient: chain.registryClient,
    signer: identity.wallet,
  }
}

export async function reconcileRelayEntitlements(
  storage: VerificationStorage,
  registryClient: VerifierRegistryClient,
  nowSecs = Math.floor(Date.now() / 1_000),
): Promise<void> {
  for (const entitlement of storage.listRelayEntitlements()) {
    if (await registryClient.isRelayJobPaid(entitlement.auditId, entitlement.jobIndex)) {
      if (entitlement.state !== 'paid') storage.updateRelayEntitlementState(entitlement.auditId, entitlement.jobIndex, 'paid')
      continue
    }
    if (nowSecs > entitlement.forceClaimDeadline) {
      if (entitlement.state !== 'expired') storage.updateRelayEntitlementState(entitlement.auditId, entitlement.jobIndex, 'expired')
      continue
    }
    if (nowSecs >= entitlement.forceClaimAvailableAt && entitlement.state !== 'challenge-available') {
      storage.updateRelayEntitlementState(entitlement.auditId, entitlement.jobIndex, 'challenge-available')
    }
  }
}

export async function forceClaimEntitlement(
  storage: VerificationStorage,
  registryClient: VerifierRegistryClient,
  signer: Awaited<ReturnType<typeof loadCryptoContext>>['identity']['wallet'],
  entitlement: StoredRelayEntitlement,
  nowSecs = Math.floor(Date.now() / 1_000),
): Promise<string> {
  if (await registryClient.isRelayJobPaid(entitlement.auditId, entitlement.jobIndex)) {
    storage.updateRelayEntitlementState(entitlement.auditId, entitlement.jobIndex, 'paid')
    throw new Error('relay job is already paid')
  }
  if (nowSecs < entitlement.forceClaimAvailableAt) throw new Error('force-claim delay has not elapsed')
  if (nowSecs > entitlement.forceClaimDeadline) {
    storage.updateRelayEntitlementState(entitlement.auditId, entitlement.jobIndex, 'expired')
    throw new Error('force-claim window has expired')
  }
  const job = parseAuditJob(entitlement.job)
  const assignment = parseRelayAssignment(entitlement.assignment)
  if (job.auditId.toLowerCase() !== entitlement.auditId.toLowerCase() || job.jobIndex !== entitlement.jobIndex) {
    throw new Error('stored entitlement job identity mismatch')
  }
  if (assignment.auditId.toLowerCase() !== job.auditId.toLowerCase() || assignment.jobIndex !== job.jobIndex) {
    throw new Error('stored entitlement assignment identity mismatch')
  }
  const audit = await registryClient.getAudit(entitlement.auditId)
  const leaf = await registryClient.hashAuditJob(job)
  if (!await registryClient.verifyAuditJobProof(
    audit.auditJobRoot,
    leaf,
    job.jobIndex,
    audit.jobCount,
    entitlement.positionalProof,
  )) throw new Error('stored positional proof is invalid')
  const auth = await registryClient.parseResponseAuthPayload(
    hex(extractContractResponseAuthSigningPayload(entitlement.responseAuthPayload)),
  )
  if (getAddress(auth.buyer) !== getAddress(assignment.relayBuyer)) throw new Error('ResponseAuth buyer mismatch')
  if (getAddress(auth.seller) !== getAddress(job.sellerPeerId)) throw new Error('ResponseAuth seller mismatch')
  if (auth.advertisedServiceHash.toLowerCase() !== job.serviceHash.toLowerCase()) throw new Error('ResponseAuth service mismatch')
  if (auth.requestHash.toLowerCase() !== job.requestHash.toLowerCase()) throw new Error('ResponseAuth request mismatch')
  if (auth.statusCode !== 200 || /^0x0{64}$/i.test(auth.responseHash)) throw new Error('ResponseAuth status or response hash is invalid')
  const executionWindow = verifyResponseAuthExecutionWindow(auth, job.executeAfter, job.executeBefore)
  if (!executionWindow.valid) throw new Error(`ResponseAuth execution window is invalid: ${executionWindow.reason}`)
  if ((await registryClient.paidRequestHash(job.requestHash)).toLowerCase() !== ZeroHash.toLowerCase()) {
    throw new Error('request hash is already paid')
  }
  const claim: RelayClaim = {
    job,
    jobProof: entitlement.positionalProof,
    assignment,
    verifierSignature: entitlement.verifierSignature,
    responseAuthPayload: hex(entitlement.responseAuthPayload),
  }
  const txHash = await registryClient.forceClaimRelayJob(signer, entitlement.auditId, claim)
  storage.updateRelayEntitlementState(entitlement.auditId, entitlement.jobIndex, 'paid', txHash)
  return txHash
}

function requireEntitlement(storage: VerificationStorage, auditId: unknown, jobIndex: unknown): StoredRelayEntitlement {
  if (typeof auditId !== 'string' || !auditId) throw new Error('--audit-id is required unless --all is used')
  if (!Number.isInteger(jobIndex)) throw new Error('--job-index is required unless --all is used')
  const entitlement = storage.getRelayEntitlement(auditId, Number(jobIndex))
  if (!entitlement) throw new Error(`unknown relay entitlement ${auditId}/${String(jobIndex)}`)
  return entitlement
}

function parseAuditJob(value: Record<string, unknown>): AuditJob {
  const requiredString = (key: keyof AuditJob): string => {
    const field = value[key]
    if (typeof field !== 'string' || field.length === 0) throw new Error(`stored job ${key} is invalid`)
    return field
  }
  const requiredNumber = (key: keyof AuditJob): number => {
    const field = value[key]
    if (!Number.isInteger(field)) throw new Error(`stored job ${key} is invalid`)
    return Number(field)
  }
  return {
    auditId: requiredString('auditId'),
    jobIndex: requiredNumber('jobIndex'),
    sellerPeerId: requiredString('sellerPeerId'),
    serviceHash: requiredString('serviceHash'),
    requestHash: requiredString('requestHash'),
    jobSalt: requiredString('jobSalt'),
    executeAfter: requiredNumber('executeAfter'),
    executeBefore: requiredNumber('executeBefore'),
  }
}

function parseRelayAssignment(value: Record<string, unknown>): RelayAssignment {
  const requiredString = (key: 'auditId' | 'relayBuyer'): string => {
    const field = value[key]
    if (typeof field !== 'string' || field.length === 0) throw new Error(`stored assignment ${key} is invalid`)
    return field
  }
  const requiredNumber = (key: 'jobIndex' | 'attempt' | 'executeAfter' | 'executeBefore'): number => {
    const field = value[key]
    if (!Number.isInteger(field)) throw new Error(`stored assignment ${key} is invalid`)
    return Number(field)
  }
  const payout = value['payoutPerJobUsdc']
  if (typeof payout !== 'string' && typeof payout !== 'number' && typeof payout !== 'bigint') {
    throw new Error('stored assignment payoutPerJobUsdc is invalid')
  }
  return {
    auditId: requiredString('auditId'),
    jobIndex: requiredNumber('jobIndex'),
    attempt: requiredNumber('attempt'),
    relayBuyer: requiredString('relayBuyer'),
    payoutPerJobUsdc: BigInt(payout),
    executeAfter: requiredNumber('executeAfter'),
    executeBefore: requiredNumber('executeBefore'),
  }
}

function parseJobIndex(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('job index must be a non-negative integer')
  return Number(value)
}

function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`
}

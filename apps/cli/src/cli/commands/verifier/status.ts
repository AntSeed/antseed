import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'
import { VerificationStorage, type StoredAuditPlan } from '@antseed/node'
import type { CanonicalAuditEvidenceV2 } from '../../../verifier/evidence-v2.js'
import { loadConfig } from '../../../config/loader.js'
import { certificationProfileHash } from '../../../verifier/probe-catalog.js'
import { resolveReferenceSource } from '../../../verifier/reference-config.js'
import { getGlobalOptions } from '../types.js'

interface VerifierStatusRow {
  auditId: string
  state: StoredAuditPlan['state']
  source: StoredAuditPlan['source']
  target: { agentId: string | null; peerId: string; service: string }
  reference: { referenceId: string | null; sourceId: string | null; provider: string | null; trust: string | null }
  round: {
    roundId: string | null
    state: string | null
    cachedProbeCount: number | null
    generatedProbeCount: number | null
    finalProbeCount: number | null
    statisticalPower: number | null
    deficit: number | null
    catalogSize: number | null
  }
  result: {
    verdict: string | null
    validProbeCount: number | null
    probeCount: number | null
    coverage: number | null
    targetHammingErrors: number | null
    observedErrorRate: number | null
    referenceSelfTestErrors: number | null
    referenceSelfTestTotal: number | null
    referenceErrorUpperBound99: number | null
    oneSidedBinomialPValue: number | null
  }
  relay: { jobCount: number; succeeded: number; failed: number; valid: number; coverage: number }
  timestamps: {
    createdAt: string
    updatedAt: string
    executeAfter: string | null
    executeBefore: string | null
    attestedAt: string | null
  }
  transactions: { commit: string | null; attestation: string | null }
  evidence: { hash: string | null; uri: string | null; state: StoredAuditPlan['evidenceState'] }
  failureReason: string | null
}

export function registerVerifierStatusCommand(verifierCmd: Command): void {
  verifierCmd
    .command('status')
    .description('Show durable verifier audit workflow state and final KBF statistics')
    .option('--audit-id <id>', 'show one audit')
    .option('--json', 'emit stable machine-readable JSON')
    .action(async (options, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const storage = new VerificationStorage(join(globalOptions.dataDir, 'verification.db'))
      try {
        const plans = options.auditId
          ? [storage.getAuditPlan(String(options.auditId))].filter((plan): plan is StoredAuditPlan => plan !== null)
          : storage.listAuditPlans()
        const rows = await Promise.all(plans.map(async (plan) => {
          const source = resolveReferenceSource(config.verifier, plan.targetService, plan.targetService)
          return buildStatusRow(globalOptions.dataDir, storage, plan, source)
        }))
        if (options.json) {
          console.log(JSON.stringify(rows, null, 2))
          return
        }
        if (rows.length === 0) {
          console.log(chalk.dim('No verifier audits found.'))
          return
        }
        printStatusTable(rows)
      } finally {
        storage.close()
      }
    })
}

async function buildStatusRow(
  dataDir: string,
  storage: VerificationStorage,
  plan: StoredAuditPlan,
  source: ReturnType<typeof resolveReferenceSource>,
): Promise<VerifierStatusRow> {
  const jobs = storage.listAuditJobs(plan.auditId)
  const succeeded = jobs.filter((job) => job.state === 'succeeded').length
  const failed = jobs.filter((job) => job.state === 'failed').length
  const evidence = await readLocalEvidence(dataDir, plan.auditId)
  const validJobs = evidence?.validation.validJobCount ?? succeeded
  const jobCount = jobs.length
  const selfErrors = evidence?.exactSubsetBaseline.hamming ?? evidence?.kbf.stats.selfHamming ?? null
  const selfTotal = evidence?.exactSubsetBaseline.total ?? evidence?.kbf.stats.selfTotal ?? null
  const targetErrors = evidence?.kbf.stats.targetHamming ?? null
  const targetTotal = evidence?.kbf.stats.targetTotal ?? null
  const generatorParams = evidence?.reference.generator.params as Record<string, unknown> | undefined
  const provenance = evidence?.reference.provenance as Record<string, unknown> | undefined
  const member = storage.getAuditRoundMemberByAuditId(plan.auditId)
  const round = member ? storage.getAuditRound(member.roundId) : null
  const catalogSize = source
    ? storage.countCertifiedKbfProbes(plan.targetService, certificationProfileHash(source))
    : null

  return {
    auditId: plan.auditId,
    state: plan.state,
    source: plan.source,
    target: { agentId: plan.agentId, peerId: plan.targetPeerId, service: plan.targetService },
    reference: {
      referenceId: plan.referenceId,
      sourceId: stringValue(generatorParams?.['sourceId'] ?? provenance?.['sourceId']),
      provider: stringValue(provenance?.['referenceProvider']),
      trust: stringValue(generatorParams?.['trust'] ?? provenance?.['trust']),
    },
    round: {
      roundId: round?.roundId ?? null,
      state: round?.state ?? null,
      cachedProbeCount: member?.cachedProbeCount ?? null,
      generatedProbeCount: member?.generatedProbeCount ?? null,
      finalProbeCount: member?.probeCount ?? plan.probeCount,
      statisticalPower: evidence?.reference.statisticalPower ?? null,
      deficit: source ? Math.max(0, source.policy.minimumAuditProbeCount - (member?.probeCount ?? 0)) : null,
      catalogSize,
    },
    result: {
      verdict: evidence?.kbf.verdict ?? null,
      validProbeCount: evidence?.kbf.parsedProbeCount ?? null,
      probeCount: evidence?.kbf.probeCount ?? plan.probeCount,
      coverage: evidence?.kbf.stats.targetCoverage ?? null,
      targetHammingErrors: targetErrors,
      observedErrorRate: targetErrors !== null && targetTotal !== null && targetTotal > 0 ? targetErrors / targetTotal : null,
      referenceSelfTestErrors: selfErrors,
      referenceSelfTestTotal: selfTotal,
      referenceErrorUpperBound99: evidence?.kbf.stats.p0Cp99 ?? evidence?.reference.statisticalPowerEvidence.p0UpperBound ?? null,
      oneSidedBinomialPValue: evidence?.kbf.stats.pValueBinomial ?? null,
    },
    relay: {
      jobCount,
      succeeded,
      failed,
      valid: validJobs,
      coverage: jobCount === 0 ? 0 : validJobs / jobCount,
    },
    timestamps: {
      createdAt: new Date(plan.createdAt).toISOString(),
      updatedAt: new Date(plan.updatedAt).toISOString(),
      executeAfter: unixTimestamp(plan.executeAfter),
      executeBefore: unixTimestamp(plan.executeBefore),
      attestedAt: evidence?.createdAt ?? null,
    },
    transactions: { commit: plan.commitTxHash, attestation: plan.attestationTxHash },
    evidence: { hash: plan.evidenceHash, uri: plan.evidenceUri, state: plan.evidenceState },
    failureReason: plan.failureReason,
  }
}

async function readLocalEvidence(dataDir: string, auditId: string): Promise<CanonicalAuditEvidenceV2 | null> {
  try {
    const raw = await readFile(join(dataDir, 'verifier', 'evidence', `${auditId}.json`), 'utf8')
    const parsed = JSON.parse(raw) as CanonicalAuditEvidenceV2
    return parsed.version === 2 ? parsed : null
  } catch {
    return null
  }
}

function printStatusTable(rows: VerifierStatusRow[]): void {
  console.log('STATE'.padEnd(22), 'VERDICT'.padEnd(13), 'PROBES'.padEnd(12), 'JOBS'.padEnd(10), 'AGENT'.padEnd(10), 'SERVICE')
  for (const row of rows) {
    const probes = row.result.validProbeCount === null || row.result.probeCount === null
      ? '-'
      : `${row.result.validProbeCount}/${row.result.probeCount}`
    const jobs = `${row.relay.valid}/${row.relay.jobCount}`
    console.log(
      row.state.padEnd(22),
      (row.result.verdict ?? '-').padEnd(13),
      probes.padEnd(12),
      jobs.padEnd(10),
      (row.target.agentId ?? '-').padEnd(10),
      row.target.service,
    )
    console.log(chalk.dim(`  audit=${row.auditId} peer=${row.target.peerId}`))
    console.log(chalk.dim(
      `  reference=${row.reference.referenceId ?? '-'} source=${row.reference.sourceId ?? '-'} provider=${row.reference.provider ?? '-'} trust=${row.reference.trust ?? '-'}`,
    ))
    console.log(chalk.dim(
      `  round=${row.round.roundId ?? '-'} state=${row.round.state ?? '-'} catalog=${row.round.catalogSize ?? '-'} cached=${row.round.cachedProbeCount ?? '-'} generated=${row.round.generatedProbeCount ?? '-'} final=${row.round.finalProbeCount ?? '-'} power=${formatNumber(row.round.statisticalPower)} deficit=${row.round.deficit ?? '-'}`,
    ))
    if (row.result.verdict !== null) {
      console.log(chalk.dim(
        `  errors=${formatRatio(row.result.targetHammingErrors, row.result.validProbeCount)} rate=${formatPercent(row.result.observedErrorRate)} self=${formatRatio(row.result.referenceSelfTestErrors, row.result.referenceSelfTestTotal)} cp99=${formatNumber(row.result.referenceErrorUpperBound99)} p=${formatNumber(row.result.oneSidedBinomialPValue)}`,
      ))
    }
    console.log(chalk.dim(
      `  relay=${row.relay.succeeded} succeeded/${row.relay.failed} failed coverage=${formatPercent(row.relay.coverage)} updated=${row.timestamps.updatedAt}`,
    ))
    if (row.failureReason) console.log(chalk.yellow(`  failure: ${row.failureReason}`))
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function unixTimestamp(value: number | null): string | null {
  return value === null ? null : new Date(value * 1_000).toISOString()
}

function formatRatio(numerator: number | null, denominator: number | null): string {
  return numerator === null || denominator === null ? '-' : `${numerator}/${denominator}`
}

function formatPercent(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(1)}%`
}

function formatNumber(value: number | null): string {
  return value === null ? '-' : value.toPrecision(4)
}

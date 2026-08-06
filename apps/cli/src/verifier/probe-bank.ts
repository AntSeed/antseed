import { randomInt } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  canonicalHashBytes32,
  computeBinomialPower,
  computeReferenceId,
  queryProfileHash,
  validateKbfReferenceV1,
  type KbfProbe,
  type KbfReferenceSelfTestV1,
  type KbfReferenceV1,
  type ReferenceProbeSelfTestV1,
} from '@antseed/fingerprints'
import type { VerifierCLIConfig } from '../config/types.js'
import { acquirePidFileLock, writeJsonAtomic } from './atomic-files.js'
import { resolveReferenceSizingPolicy } from './reference-sizing.js'
import { safeServiceSlug } from './slug.js'

export const BANK_EXHAUSTED = 'BANK_EXHAUSTED'

interface BankProbeV1 {
  probe: KbfProbe
  selfTest: ReferenceProbeSelfTestV1
  distinguishingContrastModels: string[]
}

export interface ProbeBankV1 {
  version: 1
  kind: 'antseed-kbf-probe-bank'
  model: string
  compatibilityHash: string
  queryProfile: KbfReferenceV1['queryProfile']
  referenceTemplate: Pick<KbfReferenceV1,
    'referenceModel' | 'serviceAliases' | 'source' | 'generator' | 'provenance'
    | 'minimumMismatchDelta'>
  statisticalAssumptions: {
    alpha: number
    clopperPearsonConfidence: number
  }
  contrastModels: string[]
  probes: BankProbeV1[]
  sourceReferenceIds: string[]
  createdAt: string
  updatedAt: string
}

export interface SellerProbeLedgerV1 {
  version: 1
  kind: 'antseed-kbf-seller-probe-ledger'
  model: string
  sellerPeerId: string
  assignments: Array<{
    auditId: string
    runId: string
    epoch: string
    service: string
    referenceId: string
    probeIds: string[]
    reservedAt: string
  }>
}

export async function appendModelReferenceToBank(input: {
  banksDir: string
  model: string
  reference: KbfReferenceV1
}): Promise<{ path: string; addedProbeCount: number; totalProbeCount: number }> {
  const path = bankPath(input.banksDir, input.model)
  const lock = await acquirePidFileLock(join(dirname(path), '.bank.lock'))
  try {
    const validatedReference = validateKbfReferenceV1(input.reference, {
      trustImported: true,
      minimumStatisticalPower: Number.EPSILON,
    })
    const existing = await readJsonIfExists<ProbeBankV1>(path)
    const incoming = bankFromReference(input.model, validatedReference)
    if (!existing) {
      await writeJsonAtomic(path, incoming)
      return { path, addedProbeCount: incoming.probes.length, totalProbeCount: incoming.probes.length }
    }
    const bank = existing
    if (existing && existing.compatibilityHash !== incoming.compatibilityHash) {
      throw new Error(`probe bank for ${input.model} is incompatible with the new reference`)
    }
    const byId = new Map(bank.probes.map((entry) => [entry.probe.id, entry]))
    let addedProbeCount = 0
    for (const entry of incoming.probes) {
      const previous = byId.get(entry.probe.id)
      if (!previous) {
        bank.probes.push(entry)
        byId.set(entry.probe.id, entry)
        addedProbeCount += 1
        continue
      }
      if (canonicalHashBytes32(previous.probe) !== canonicalHashBytes32(entry.probe)
        || canonicalHashBytes32(previous.selfTest) !== canonicalHashBytes32(entry.selfTest)) {
        throw new Error(`probe ${entry.probe.id} conflicts with existing canonical content or self-test evidence`)
      }
      previous.distinguishingContrastModels = [...new Set([
        ...previous.distinguishingContrastModels,
        ...entry.distinguishingContrastModels,
      ])].sort()
    }
    bank.contrastModels = [...incoming.contrastModels].sort()
    if (!bank.sourceReferenceIds.includes(validatedReference.referenceId)) {
      bank.sourceReferenceIds.push(validatedReference.referenceId)
    }
    bank.updatedAt = new Date().toISOString()
    await writeJsonAtomic(path, bank)
    return { path, addedProbeCount, totalProbeCount: bank.probes.length }
  } finally {
    await lock.release()
  }
}

export async function reserveModelAuditReference(input: {
  banksDir: string
  model: string
  sellerPeerId: string
  service: string
  runId: string
  epoch: string
  allowProbeReuse?: boolean
  config?: VerifierCLIConfig
  now?: () => number
  shuffle?: <T>(values: readonly T[]) => T[]
}): Promise<{ reference: KbfReferenceV1; auditId: string; ledgerPath: string }> {
  const path = bankPath(input.banksDir, input.model)
  const ledgerPath = sellerLedgerPath(input.banksDir, input.model, input.sellerPeerId)
  const lock = await acquirePidFileLock(`${ledgerPath}.lock`)
  try {
    const bank = await readRequiredBank(path, input.model)
    const ledger = await readJsonIfExists<SellerProbeLedgerV1>(ledgerPath) ?? {
      version: 1,
      kind: 'antseed-kbf-seller-probe-ledger',
      model: input.model,
      sellerPeerId: input.sellerPeerId,
      assignments: [],
    }
    if (normalized(ledger.model) !== normalized(input.model)
      || normalized(ledger.sellerPeerId) !== normalized(input.sellerPeerId)) {
      throw new Error(`invalid seller probe ledger at ${ledgerPath}`)
    }
    const used = new Set(ledger.assignments
      .filter((assignment) => !input.allowProbeReuse || assignment.runId === input.runId)
      .flatMap((assignment) => assignment.probeIds))
    const activeContrasts = new Set(bank.contrastModels.map(normalized))
    const available = bank.probes.filter((entry) => !used.has(entry.probe.id)
      && entry.distinguishingContrastModels.some((model) => activeContrasts.has(normalized(model))))
    const shuffled = (input.shuffle ?? cryptoShuffle)(available)
    const now = input.now?.() ?? Date.now()
    const reference = selectPoweredReference(bank, shuffled, input.config, now)
    if (!reference) {
      throw new Error(`${BANK_EXHAUSTED}: ${available.length} unused probes remain for ${input.sellerPeerId}`)
    }
    const reservedAt = new Date(now).toISOString()
    const auditId = canonicalHashBytes32({
      domain: 'antseed-verifier-audit-reservation-v1',
      runId: input.runId,
      epoch: input.epoch,
      model: normalized(input.model),
      sellerPeerId: normalized(input.sellerPeerId),
      service: normalized(input.service),
      referenceId: reference.referenceId,
      reservedAt,
    })
    const probeIds = reference.probes.map((probe) => probe.id)
    ledger.assignments.push({
      auditId,
      runId: input.runId,
      epoch: input.epoch,
      service: input.service,
      referenceId: reference.referenceId,
      probeIds,
      reservedAt,
    })
    await mkdir(dirname(ledgerPath), { recursive: true })
    await writeJsonAtomic(ledgerPath, ledger)
    return { reference, auditId, ledgerPath }
  } finally {
    await lock.release()
  }
}

export function bankPath(banksDir: string, model: string): string {
  return join(banksDir, safeServiceSlug(model), 'bank.json')
}

export function sellerLedgerPath(banksDir: string, model: string, sellerPeerId: string): string {
  const hash = canonicalHashBytes32({ peerId: normalized(sellerPeerId) }).slice(2)
  return join(banksDir, safeServiceSlug(model), 'sellers', `${hash}.json`)
}

function bankFromReference(model: string, reference: KbfReferenceV1): ProbeBankV1 {
  const assumptions = {
    alpha: reference.statisticalPowerEvidence.alpha,
    clopperPearsonConfidence: reference.statisticalPowerEvidence.clopperPearsonConfidence,
  }
  const compatibilityHash = canonicalHashBytes32({
    model: normalized(model),
    referenceModel: normalized(reference.referenceModel),
    serviceAliases: reference.serviceAliases.map(normalized).sort(),
    queryProfileHash: queryProfileHash(reference.queryProfile),
    provenance: reference.provenance ?? null,
    minimumMismatchDelta: reference.minimumMismatchDelta,
    assumptions,
  })
  const contrastByProbe = new Map<string, string[]>()
  for (const contrast of reference.contrasts) {
    for (const probeId of contrast.distinguishingProbeIds) {
      const models = contrastByProbe.get(probeId) ?? []
      models.push(contrast.model)
      contrastByProbe.set(probeId, models)
    }
  }
  const outcomes = new Map(reference.selfTest.outcomes.map((outcome) => [outcome.probeId, outcome]))
  const now = new Date().toISOString()
  return {
    version: 1,
    kind: 'antseed-kbf-probe-bank',
    model,
    compatibilityHash,
    queryProfile: reference.queryProfile,
    referenceTemplate: {
      referenceModel: reference.referenceModel,
      serviceAliases: reference.serviceAliases,
      source: reference.source,
      generator: reference.generator,
      ...(reference.provenance ? { provenance: reference.provenance } : {}),
      minimumMismatchDelta: reference.minimumMismatchDelta,
    },
    statisticalAssumptions: assumptions,
    contrastModels: reference.contrasts.map((contrast) => contrast.model),
    probes: reference.probes.map((probe) => ({
      probe,
      selfTest: outcomes.get(probe.id)!,
      distinguishingContrastModels: (contrastByProbe.get(probe.id) ?? []).sort(),
    })),
    sourceReferenceIds: [reference.referenceId],
    createdAt: now,
    updatedAt: now,
  }
}

function selectPoweredReference(
  bank: ProbeBankV1,
  available: readonly BankProbeV1[],
  config: VerifierCLIConfig | undefined,
  now: number,
): KbfReferenceV1 | null {
  const sizing = resolveReferenceSizingPolicy(config)
  for (let count = sizing.minimumProbeCount;
    count <= sizing.maximumProbeCount && count <= available.length;
    count += sizing.probeStep) {
    const selected = available.slice(0, count)
    const selfTest = aggregateSelfTest(selected.map((entry) => entry.selfTest))
    const power = computeBinomialPower({
      selfHamming: selfTest.hamming,
      selfTotal: selfTest.total,
      minimumMismatchDelta: bank.referenceTemplate.minimumMismatchDelta,
      alpha: bank.statisticalAssumptions.alpha,
      cpConfidence: bank.statisticalAssumptions.clopperPearsonConfidence,
    })
    if (selfTest.coverage < 0.8 || selfTest.errorRate > 0.35
      || power.power < sizing.minimumStatisticalPower) continue
    const selectedIds = new Set(selected.map((entry) => entry.probe.id))
    const reference: KbfReferenceV1 = {
      version: 1,
      kind: 'kbf',
      referenceId: '',
      ...bank.referenceTemplate,
      createdAt: new Date(now).toISOString(),
      queryProfile: bank.queryProfile,
      selfTest,
      probes: selected.map((entry) => entry.probe),
      selectedProbeCount: count,
      statisticalPower: power.power,
      statisticalPowerEvidence: {
        test: 'one-sided-binomial',
        alpha: bank.statisticalAssumptions.alpha,
        clopperPearsonConfidence: bank.statisticalAssumptions.clopperPearsonConfidence,
        selfHamming: selfTest.hamming,
        selfTotal: selfTest.total,
        p0UpperBound: power.p0,
        alternativeMismatchRate: power.p1,
        criticalMismatchCount: power.criticalMismatchCount,
        power: power.power,
      },
      contrasts: bank.contrastModels.map((model) => ({
        model,
        distinguishingProbeIds: selected
          .filter((entry) => entry.distinguishingContrastModels.includes(model) && selectedIds.has(entry.probe.id))
          .map((entry) => entry.probe.id),
      })),
    }
    reference.referenceId = computeReferenceId(reference)
    return validateKbfReferenceV1(reference, { minimumStatisticalPower: sizing.minimumStatisticalPower })
  }
  return null
}

function aggregateSelfTest(outcomes: ReferenceProbeSelfTestV1[]): KbfReferenceSelfTestV1 {
  const parsed = outcomes.filter((outcome) => outcome.match !== null).length
  const hamming = outcomes.filter((outcome) => outcome.match !== 1).length
  return {
    hamming,
    total: outcomes.length,
    coverage: outcomes.length === 0 ? 0 : parsed / outcomes.length,
    errorRate: outcomes.length === 0 ? 0 : hamming / outcomes.length,
    outcomes,
  }
}

function cryptoShuffle<T>(values: readonly T[]): T[] {
  const shuffled = [...values]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1)
    ;[shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!]
  }
  return shuffled
}

async function readRequiredBank(path: string, model: string): Promise<ProbeBankV1> {
  const bank = await readJsonIfExists<ProbeBankV1>(path)
  if (!bank) throw new Error(`no probe bank exists for ${model}; run antseed verifier reference build ${model}`)
  return bank
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function normalized(value: string): string {
  return value.trim().toLowerCase()
}

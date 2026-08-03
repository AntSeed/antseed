import { canonicalHash, type KbfReferenceV1 } from '@antseed/fingerprints'
import type {
  VerifierCLIConfig,
  VerifierReferenceEndpointConfig,
  VerifierReferencePolicyConfig,
} from '../config/types.js'
import {
  ADAPTIVE_KBF_GENERATOR_NAME,
  ADAPTIVE_KBF_GENERATOR_VERSION,
} from './adaptive-probes.js'
import {
  endpointConfigHash,
  resolveUpstream,
  resolveUpstreamModel,
  type UpstreamApiConfig,
} from './reference-builder.js'

export interface ResolvedReferencePolicy {
  minimumAuditProbeCount: number
  maximumAuditProbeCount: number
  auditProbeStep: number
  minimumStatisticalPower: number
  maxReferenceAgeDays: number
  maxRequestsPerRound: number
  requestTimeoutMs: number
  batchRetryCount: number
  generationDomainConcurrency: number
  maxConcurrentReferenceRequests: number
  maxConcurrentRequestsPerModel: number
}

export interface ResolvedReferenceSource {
  upstream: UpstreamApiConfig
  model: string
  contrastModels: string[]
  policy: ResolvedReferencePolicy
}

export const DEFAULT_REFERENCE_POLICY: ResolvedReferencePolicy = {
  minimumAuditProbeCount: 100,
  maximumAuditProbeCount: 500,
  auditProbeStep: 10,
  minimumStatisticalPower: 0.9,
  maxReferenceAgeDays: 49,
  maxRequestsPerRound: 2000,
  requestTimeoutMs: 120_000,
  batchRetryCount: 3,
  generationDomainConcurrency: 3,
  maxConcurrentReferenceRequests: 4,
  maxConcurrentRequestsPerModel: 2,
}

export function resolveReferencePolicy(policy: VerifierReferencePolicyConfig | undefined): ResolvedReferencePolicy {
  if (!policy) return { ...DEFAULT_REFERENCE_POLICY }
  return {
    minimumAuditProbeCount: policy.minimumAuditProbeCount ?? policy.auditProbeCount
      ?? DEFAULT_REFERENCE_POLICY.minimumAuditProbeCount,
    maximumAuditProbeCount: policy.maximumAuditProbeCount ?? DEFAULT_REFERENCE_POLICY.maximumAuditProbeCount,
    auditProbeStep: policy.auditProbeStep ?? DEFAULT_REFERENCE_POLICY.auditProbeStep,
    minimumStatisticalPower: policy.minimumStatisticalPower ?? DEFAULT_REFERENCE_POLICY.minimumStatisticalPower,
    maxReferenceAgeDays: policy.maxReferenceAgeDays ?? DEFAULT_REFERENCE_POLICY.maxReferenceAgeDays,
    maxRequestsPerRound: policy.maxRequestsPerRound ?? policy.maxRequestsPerBuild
      ?? DEFAULT_REFERENCE_POLICY.maxRequestsPerRound,
    requestTimeoutMs: policy.requestTimeoutMs ?? DEFAULT_REFERENCE_POLICY.requestTimeoutMs,
    batchRetryCount: policy.batchRetryCount ?? DEFAULT_REFERENCE_POLICY.batchRetryCount,
    generationDomainConcurrency: policy.generationDomainConcurrency
      ?? DEFAULT_REFERENCE_POLICY.generationDomainConcurrency,
    maxConcurrentReferenceRequests: policy.maxConcurrentReferenceRequests
      ?? DEFAULT_REFERENCE_POLICY.maxConcurrentReferenceRequests,
    maxConcurrentRequestsPerModel: policy.maxConcurrentRequestsPerModel
      ?? DEFAULT_REFERENCE_POLICY.maxConcurrentRequestsPerModel,
  }
}

export function resolveReferenceSource(
  verifier: VerifierCLIConfig | undefined,
  service: string,
  advertised = service,
): ResolvedReferenceSource | null {
  const policy = resolveReferencePolicy(verifier?.referencePolicy)
  if (verifier?.referenceEndpoint) {
    const modelEntry = findModelEntry(verifier.referenceEndpoint, service, advertised)
    if (!modelEntry) return null
    const upstream = resolveUpstream(verifier.referenceEndpoint)
    if (!upstream) return null
    return {
      upstream,
      model: modelEntry.upstreamModel,
      contrastModels: [...modelEntry.contrastModels],
      policy,
    }
  }
  const upstream = resolveUpstream(verifier?.upstream)
  if (!upstream) return null
  return {
    upstream: { ...upstream, sourceId: 'legacy-upstream', trust: 'trusted' },
    model: resolveUpstreamModel(verifier?.upstream?.modelMap, service.trim().toLowerCase(), advertised),
    contrastModels: [],
    policy,
  }
}

export function isAutomaticReferenceEligible(
  reference: KbfReferenceV1,
  source: ResolvedReferenceSource,
  service: string,
  now = Date.now(),
): boolean {
  if (reference.generator.name !== ADAPTIVE_KBF_GENERATOR_NAME
    || reference.generator.version !== ADAPTIVE_KBF_GENERATOR_VERSION) return false
  if (reference.probes.length < source.policy.minimumAuditProbeCount) return false
  if (reference.referenceModel.trim().toLowerCase() !== service.trim().toLowerCase()
    && !reference.serviceAliases.some((alias) => alias.trim().toLowerCase() === service.trim().toLowerCase())) return false
  const createdAt = Date.parse(reference.createdAt)
  if (!Number.isFinite(createdAt) || now - createdAt > source.policy.maxReferenceAgeDays * 86_400_000) return false
  const expectedHash = endpointConfigHash({
    upstream: source.upstream,
    model: source.model,
    contrastModels: source.contrastModels,
    queryProfile: reference.queryProfile,
  })
  const params = reference.generator.params as Record<string, unknown>
  if (params.endpointConfigHash !== expectedHash) return false
  const contrasts = reference.contrasts.map((contrast) => contrast.model)
  return JSON.stringify(contrasts) === JSON.stringify(source.contrastModels)
}

export function referenceBuildKey(source: ResolvedReferenceSource): string {
  return canonicalHash({
    baseUrl: source.upstream.baseUrl.trim().replace(/\/+$/, ''),
    sourceId: source.upstream.sourceId ?? 'legacy-upstream',
    trust: source.upstream.trust ?? 'trusted',
    antseedPeerId: source.upstream.antseedPeerId ?? null,
    model: source.model,
    contrastModels: source.contrastModels,
    generator: { name: ADAPTIVE_KBF_GENERATOR_NAME, version: ADAPTIVE_KBF_GENERATOR_VERSION },
    policy: source.policy,
  })
}

function findModelEntry(endpoint: VerifierReferenceEndpointConfig, service: string, advertised: string) {
  const direct = endpoint.models[service] ?? endpoint.models[advertised]
  if (direct) return direct
  const normalized = service.trim().toLowerCase()
  return Object.entries(endpoint.models).find(([key]) => key.trim().toLowerCase() === normalized)?.[1]
}

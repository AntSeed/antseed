import type { VerifierCLIConfig, VerifierModelPricingConfig } from '../config/types.js'

export interface VerifierCatalogModel {
  upstreamModel: string
  pricing: VerifierModelPricingConfig
  capabilityRank: number | null
}

export type VerifierModelCatalog = ReadonlyMap<string, VerifierCatalogModel>

export async function loadConfiguredVerifierModelCatalog(
  config: VerifierCLIConfig | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<VerifierModelCatalog | null> {
  if (config?.contrastSelection?.catalogSource !== 'openrouter') return null
  const endpoint = config.referenceEndpoint
  if (!endpoint) throw new Error('verifier.referenceEndpoint is required')
  const apiKey = (endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : undefined) ?? endpoint.apiKey
  const response = await fetchFn(`${endpoint.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  })
  if (!response.ok) {
    throw new Error(`OpenRouter model catalog ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
  const parsed = await response.json() as { data?: unknown }
  if (!Array.isArray(parsed.data)) throw new Error('OpenRouter model catalog response omitted data[]')
  const catalog = new Map<string, VerifierCatalogModel>()
  for (const raw of parsed.data) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const model = raw as Record<string, unknown>
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (!id) continue
    const pricing = parsePricing(model.pricing)
    if (!pricing) continue
    catalog.set(normalized(id), {
      upstreamModel: id,
      pricing,
      capabilityRank: parseIntelligenceIndex(model.benchmarks),
    })
  }
  if (catalog.size === 0) throw new Error('OpenRouter model catalog contained no priced models')
  return catalog
}

function parsePricing(value: unknown): VerifierModelPricingConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const pricing = value as Record<string, unknown>
  const inputUsdPerToken = parseNonNegativeNumber(pricing.prompt)
  const outputUsdPerToken = parseNonNegativeNumber(pricing.completion)
  if (inputUsdPerToken === null || outputUsdPerToken === null) return null
  return {
    inputUsdPerMillion: inputUsdPerToken * 1_000_000,
    outputUsdPerMillion: outputUsdPerToken * 1_000_000,
  }
}

function parseIntelligenceIndex(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const artificialAnalysis = (value as Record<string, unknown>).artificial_analysis
  if (!artificialAnalysis || typeof artificialAnalysis !== 'object' || Array.isArray(artificialAnalysis)) return null
  return parseNonNegativeNumber((artificialAnalysis as Record<string, unknown>).intelligence_index)
}

function parseNonNegativeNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function normalized(value: string): string {
  return value.trim().toLowerCase()
}

import { sha256Hex, type KbfProbe } from '@antseed/fingerprints'

export const ADAPTIVE_KBF_GENERATOR_NAME = 'antseed-kbf-adaptive-frontier'
export const ADAPTIVE_KBF_GENERATOR_VERSION = '1'

interface DomainDefinition {
  name: string
  tolerance: KbfProbe['tolerance']
  range: [number, number]
  template: string
  subject: string
  themes: string[]
}

const DOMAINS: Record<string, DomainDefinition> = {
  chemistry_bp: domain('Chemistry (boiling points)', 'absolute', 3, [-300, 600], 'The boiling point of {name} at 1 atm is ___°C.', 'chemical compounds with well-defined boiling points at 1 atm', ['organometallics and organosilicons', 'heterocyclic nitrogen compounds', 'specialty sulfur and phosphorus reagents', 'obscure halogenated compounds']),
  chemistry_mp: domain('Chemistry (melting points)', 'absolute', 3, [-300, 4000], 'The melting point of {name} is ___°C.', 'chemical compounds or minerals with well-defined melting points', ['metal oxides and ceramics', 'organic crystals and intermediates', 'coordination compounds', 'intermetallic compounds']),
  physics: domain('Physics (material properties)', 'relative', 0.02, [0, 1e15], 'The numerical value of {name} in SI units is ___.', 'physical constants, material properties, or measured quantities expressed in SI units', ['thermal and acoustic material properties', 'optical properties', 'nuclear constants', 'electromagnetic material properties']),
  astronomy: domain('Astronomy', 'relative', 0.05, [0, 1e15], 'The numerical value of {name} is ___.', 'astronomical measurements with units stated in the name', ['irregular moon orbital periods', 'minor planet measurements', 'dim stellar systems', 'unusual galaxies and nebulae']),
  biology: domain('Biology', 'relative', 0.05, [0, 1e15], 'The numerical value of {name} is ___.', 'specialist biological measurements with units stated in the name', ['genome and chromosome measurements', 'enzyme and protein measurements', 'microbiology growth parameters', 'comparative physiology']),
  math: domain('Mathematics', 'relative', 0.0001, [-1e15, 1e15], 'The numerical value of {name} is ___.', 'named mathematical constants, sequence terms, or exact finite counts', ['combinatorics and graph theory', 'number theory constants', 'special functions', 'finite geometry and topology']),
  programming: domain('Programming systems', 'absolute', 0, [0, 1e15], 'The numerical value of {name} is ___.', 'documented programming language, runtime, protocol, or file-format numeric constants', ['virtual machine opcodes and limits', 'binary formats and protocol constants', 'language implementation limits', 'historical system parameters']),
  medical: domain('Medical science', 'relative', 0.05, [0, 1e15], 'The numerical value of {name} is ___.', 'specialist medical measurements, scores, or epidemiological quantities with units stated', ['rare diseases', 'diagnostic thresholds', 'pharmacokinetic constants', 'anatomical measurements']),
  pop_culture: domain('Pop culture', 'absolute', 0, [-1e9, 1e12], 'The numerical value of {name} is ___.', 'verifiable numeric details from less-famous films, television, music, games, or books', ['production and release facts', 'episode and track details', 'box-office or sales records with units', 'fictional-world measurements']),
  internet_culture: domain('Internet culture', 'absolute', 0, [-1e9, 1e15], 'The numerical value of {name} is ___.', 'verifiable numeric facts about internet history, communities, standards, or notable online events', ['early web services', 'community milestones', 'protocol history', 'open-source project history']),
  chinese_history: domain('Chinese history', 'absolute', 0, [-5000, 3000], 'The year associated with {name} is ___.', 'specific events, reigns, institutions, or works in Chinese history expressed as a year', ['regional dynastic events', 'administrative reforms', 'scientific and literary history', 'trade and diplomatic history']),
  chinese_geography: domain('Chinese geography', 'relative', 0.03, [0, 1e9], 'The numerical value of {name} is ___.', 'Chinese geographic measurements with units stated in the name', ['county and prefecture geography', 'rivers and lakes', 'mountain passes and basins', 'transport geography']),
  chinese_internet: domain('Chinese internet culture', 'absolute', 0, [-1e9, 1e15], 'The numerical value of {name} is ___.', 'verifiable numeric facts about Chinese internet platforms, communities, products, or events', ['platform launches and milestones', 'online communities', 'games and livestreaming', 'technology companies']),
  chinese_literature: domain('Chinese literature', 'absolute', 0, [-5000, 1e9], 'The numerical value of {name} is ___.', 'verifiable numeric facts about Chinese literary works, authors, editions, or publication history', ['classical collections', 'regional literature', 'modern publishing', 'poetry and drama']),
  crypto_params: domain('Cryptographic parameters', 'absolute', 0, [0, 1e15], 'The numerical value of {name} is ___.', 'published cryptographic, blockchain, encoding, or consensus parameters', ['elliptic curves and signature schemes', 'hash and proof systems', 'blockchain consensus parameters', 'encoding and key formats']),
}

function domain(
  name: string,
  mode: KbfProbe['tolerance']['mode'],
  tolerance: number,
  range: [number, number],
  template: string,
  subject: string,
  themes: string[],
): DomainDefinition {
  return { name, tolerance: { mode, value: tolerance }, range, template, subject, themes }
}

export interface AdaptiveGenerationStats {
  generationMode: 'adaptive_frontier'
  requestedCandidates: number
  generatedCandidates: number
  domains: Record<string, {
    name: string
    roundsUsed: number
    parsed: number
    unique: number
    zeroRounds: number
    frontierReached: boolean
  }>
}

export interface AdaptiveGenerationCheckpoint {
  probes: KbfProbe[]
  stats: AdaptiveGenerationStats
}

export async function generateAdaptiveProbes(input: {
  model: string
  count: number
  maxRounds?: number
  domainConcurrency?: number
  query: (prompt: string, maxTokens: number) => Promise<string>
  log?: (message: string) => void
  resume?: AdaptiveGenerationCheckpoint
  onProgress?: (checkpoint: AdaptiveGenerationCheckpoint) => Promise<void>
}): Promise<{ probes: KbfProbe[]; stats: AdaptiveGenerationStats }> {
  const maxRounds = input.maxRounds ?? 6
  const domainConcurrency = input.domainConcurrency ?? 1
  if (!Number.isInteger(domainConcurrency) || domainConcurrency < 1) {
    throw new Error('domainConcurrency must be an integer >= 1')
  }
  if (input.resume && input.resume.probes.length >= input.count) {
    const probes = input.resume.probes.slice(0, input.count).map((probe) => ({ ...probe }))
    return {
      probes,
      stats: {
        ...cloneStats(input.resume.stats),
        requestedCandidates: input.count,
        generatedCandidates: probes.length,
      },
    }
  }
  const domainEntries = Object.entries(DOMAINS)
  const targetPerDomain = Math.max(10, Math.ceil(input.count / domainEntries.length))
  let remaining = input.count
  const activeDomains = domainEntries.flatMap(([domainKey, definition]) => {
    if (remaining <= 0) return []
    const targetCount = Math.min(targetPerDomain, remaining)
    remaining -= targetCount
    return [{ domainKey, definition, targetCount }]
  })
  const domainProbes = new Map<string, KbfProbe[]>()
  for (const { domainKey } of activeDomains) {
    domainProbes.set(
      domainKey,
      (input.resume?.probes ?? []).filter((probe) => probe.domain === domainKey).map((probe) => ({ ...probe })),
    )
  }
  const stats: AdaptiveGenerationStats = input.resume
    ? {
        ...input.resume.stats,
        requestedCandidates: input.count,
        generatedCandidates: orderedResumeProbeCount(input.resume.probes, activeDomains.map(({ domainKey }) => domainKey)),
        domains: Object.fromEntries(Object.entries(input.resume.stats.domains).map(([key, value]) => [key, { ...value }])),
      }
    : {
        generationMode: 'adaptive_frontier',
        requestedCandidates: input.count,
        generatedCandidates: 0,
        domains: {},
      }
  const orderedProbes = (): KbfProbe[] => activeDomains
    .flatMap(({ domainKey }) => domainProbes.get(domainKey) ?? [])
    .slice(0, input.count)
  let progressTail = Promise.resolve()
  const publishProgress = async (): Promise<void> => {
    if (!input.onProgress) return
    const probes = orderedProbes()
    stats.generatedCandidates = probes.length
    const checkpoint = { probes, stats: cloneStats(stats) }
    const current = progressTail.then(() => input.onProgress!(checkpoint))
    progressTail = current.catch(() => undefined)
    await current
  }

  await runDomainsConcurrently(activeDomains, domainConcurrency, async ({ domainKey, definition, targetCount }) => {
    const previous = stats.domains[domainKey]
    const probes = domainProbes.get(domainKey) ?? []
    const seen = new Set(probes.map((probe) => probe.name.trim().toLowerCase()))
    let zeroRounds = previous?.zeroRounds ?? 0
    let parsedTotal = previous?.parsed ?? 0
    let uniqueTotal = Math.max(previous?.unique ?? 0, probes.length)
    let roundsUsed = previous?.roundsUsed ?? 0
    if (previous?.frontierReached) return
    for (let round = roundsUsed; round < maxRounds && uniqueTotal < targetCount; round += 1) {
      if (zeroRounds >= 2) break
      roundsUsed += 1
      const theme = definition.themes[round % definition.themes.length]!
      const difficulty = difficultyInstruction(round)
      const prompt = [
        `List 15 ${definition.subject}.`,
        `Focus on: ${theme}.`,
        difficulty,
        'Use only facts with a single defensible finite numeric answer.',
        'Put units or scale in the fact name so the answer is only the number.',
        'Format every line exactly as: fact_name | numeric_value',
        'Output only the list.',
      ].join('\n')
      const response = await input.query(prompt, 3000)
      const parsed = parseGeneratedFacts(response, definition.range)
      parsedTotal += parsed.length
      let added = 0
      for (const fact of parsed) {
        if (uniqueTotal >= targetCount) break
        const normalizedName = fact.name.trim().toLowerCase()
        if (seen.has(normalizedName)) continue
        seen.add(normalizedName)
        const normalized = `${domainKey}:${normalizedName}`
        const id = `kbf-${sha256Hex(normalized).slice(0, 24)}`
        probes.push({
          id,
          name: fact.name,
          domain: domainKey,
          template: definition.template.replace('{name}', fact.name),
          consensus: fact.value,
          range: [...definition.range],
          tolerance: { ...definition.tolerance },
          adaptiveDomainName: definition.name,
          generationRound: round + 1,
          generationTheme: theme,
          advisoryConsensus: true,
        })
        added += 1
        uniqueTotal += 1
      }
      zeroRounds = added === 0 ? zeroRounds + 1 : 0
      stats.domains[domainKey] = {
        name: definition.name,
        roundsUsed,
        parsed: parsedTotal,
        unique: uniqueTotal,
        zeroRounds,
        frontierReached: zeroRounds >= 2,
      }
      stats.generatedCandidates = orderedProbes().length
      input.log?.(`${domainKey}: round ${round + 1}, ${parsed.length} parsed, ${added} new`)
      await publishProgress()
    }
    stats.domains[domainKey] = {
      name: definition.name,
      roundsUsed,
      parsed: parsedTotal,
      unique: uniqueTotal,
      zeroRounds,
      frontierReached: zeroRounds >= 2,
    }
  })
  await progressTail
  const probes = orderedProbes()
  stats.generatedCandidates = probes.length
  return { probes, stats }
}

function orderedResumeProbeCount(probes: readonly KbfProbe[], activeDomainKeys: readonly string[]): number {
  const active = new Set(activeDomainKeys)
  return probes.filter((probe) => active.has(probe.domain)).length
}

async function runDomainsConcurrently<T>(
  domains: readonly T[],
  concurrency: number,
  operation: (domain: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  let firstError: unknown
  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const index = nextIndex
      if (index >= domains.length) return
      nextIndex += 1
      try {
        await operation(domains[index]!)
      } catch (error) {
        firstError = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length) }, () => worker()))
  if (firstError !== undefined) throw firstError
}

function cloneStats(stats: AdaptiveGenerationStats): AdaptiveGenerationStats {
  return {
    ...stats,
    domains: Object.fromEntries(Object.entries(stats.domains).map(([key, value]) => [key, { ...value }])),
  }
}

function difficultyInstruction(round: number): string {
  if (round === 0) return 'Choose specialist-level facts and avoid textbook examples.'
  if (round === 1) return 'Choose obscure facts unlikely to appear in general trivia or introductory references.'
  if (round === 2) return 'Move further into specialist subfields, regional material, and rarely cited entities.'
  return 'Choose frontier-obscure facts: niche entities and measurements a domain specialist may recall but a nearby model may not.'
}

function parseGeneratedFacts(text: string, range: [number, number]): Array<{ name: string; value: number }> {
  const facts: Array<{ name: string; value: number }> = []
  for (const rawLine of text.replace(/<think>[\s\S]*?<\/think>/gi, '').split('\n')) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '')
    const separator = line.lastIndexOf('|')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    const numeric = line.slice(separator + 1).trim().replace(/[,_\s]/g, '').replace(/−/g, '-')
    if (!name || name.length > 240 || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(numeric)) continue
    const value = Number(numeric)
    if (!Number.isFinite(value) || value < range[0] || value > range[1]) continue
    facts.push({ name, value })
  }
  return facts
}

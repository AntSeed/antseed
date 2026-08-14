export type BuyerApplicationRoutePolicy =
  | { mode: 'client-model' }
  | { mode: 'follow-global' }
  | { mode: 'model'; provider: string; service: string }

export type BuyerApplicationRoute = BuyerApplicationRoutePolicy & {
  profileName: string
  toolSlugs: string[]
}

export type BuyerApplicationRouteMap = Record<string, BuyerApplicationRoute>

const MAX_APPLICATION_ROUTES = 64
const MAX_TOOL_SLUGS = 16
const MAX_NAME_LENGTH = 128

export function normalizeToolSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
}

export function toolMatchesSlug(tool: string, slug: string): boolean {
  const normalizedTool = normalizeToolSlug(tool)
  const normalizedSlug = normalizeToolSlug(slug)
  if (!normalizedTool || !normalizedSlug) return false
  if (normalizedTool === normalizedSlug) return true
  return normalizedTool.startsWith(`${normalizedSlug}-`) || normalizedSlug.startsWith(`${normalizedTool}-`)
}

export function matchApplicationRoute(
  routes: BuyerApplicationRouteMap,
  tool: string,
): BuyerApplicationRoute | null {
  const normalizedTool = normalizeToolSlug(tool)
  let matched: { route: BuyerApplicationRoute; exact: boolean; slugLength: number } | null = null
  for (const route of Object.values(routes)) {
    for (const slug of [route.profileName, ...route.toolSlugs]) {
      const normalizedSlug = normalizeToolSlug(slug)
      if (!toolMatchesSlug(normalizedTool, normalizedSlug)) continue
      const candidate = {
        route,
        exact: normalizedTool === normalizedSlug,
        slugLength: normalizedSlug.length,
      }
      if (
        !matched
        || (candidate.exact && !matched.exact)
        || (candidate.exact === matched.exact && candidate.slugLength > matched.slugLength)
      ) {
        matched = candidate
      }
    }
  }
  return matched?.route ?? null
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} must not be empty`)
  if (trimmed.length > MAX_NAME_LENGTH) throw new Error(`${field} is too long`)
  return trimmed
}

function parseToolSlugs(value: unknown, profileName: string): string[] {
  if (!Array.isArray(value)) throw new Error(`routes.${profileName}.toolSlugs must be an array`)
  if (value.length > MAX_TOOL_SLUGS) throw new Error(`routes.${profileName}.toolSlugs has too many entries`)
  const slugs = value.map((entry, index) => normalizeToolSlug(parseString(entry, `routes.${profileName}.toolSlugs[${index}]`)))
    .filter((entry) => entry.length > 0)
  return Array.from(new Set(slugs))
}

export function parseApplicationRouteMap(value: unknown): BuyerApplicationRouteMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routes must be an object')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_APPLICATION_ROUTES) throw new Error('routes has too many entries')

  const routes: BuyerApplicationRouteMap = {}
  for (const [rawProfileName, rawRoute] of entries) {
    const profileName = normalizeToolSlug(parseString(rawProfileName, 'profile name'))
    if (!profileName) throw new Error('profile name must contain letters or numbers')
    if (!rawRoute || typeof rawRoute !== 'object' || Array.isArray(rawRoute)) {
      throw new Error(`routes.${profileName} must be an object`)
    }
    const record = rawRoute as Record<string, unknown>
    const mode = record.mode
    if (mode !== 'client-model' && mode !== 'follow-global' && mode !== 'model') {
      throw new Error(`routes.${profileName}.mode is invalid`)
    }
    const toolSlugs = parseToolSlugs(record.toolSlugs, profileName)
    if (mode === 'model') {
      routes[profileName] = {
        profileName,
        toolSlugs,
        mode,
        provider: parseString(record.provider, `routes.${profileName}.provider`).toLowerCase(),
        service: parseString(record.service, `routes.${profileName}.service`),
      }
    } else {
      routes[profileName] = { profileName, toolSlugs, mode }
    }
  }
  return routes
}

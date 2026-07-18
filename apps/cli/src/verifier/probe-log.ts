import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeServiceSlug } from './slug.js'

/**
 * Per-(verifier, service) probe rotation log.
 *
 * The evidence bundle reveals every probe it used (that is inherent to
 * commit-reveal), so a seller learns a probe the moment an audit completes.
 * To stop past reveals from teaching future audits, the daemon records the
 * probe ids it has used against a service and feeds them back as the `exclude`
 * set, so a probe is not reused until the live pool is exhausted and the ring
 * buffer cycles it out.
 *
 * The log is a best-effort local hint, not a security boundary — a corrupt or
 * missing file simply means less rotation, never a crash.
 */

/**
 * Generic per-service id-set store: one JSON file per service
 * (`<slug><suffix>`) holding `{version, service, [field]: string[], updatedAt}`.
 * Backs both the probe rotation log here and the burned-references marker in
 * audit-runner.ts. `load` preserves file order (the Set iterates oldest-first
 * for ring-buffer semantics) and is empty on any read/parse error; `save`
 * creates the directory on demand.
 */
export interface ServiceIdSetStore {
  load(dir: string, service: string): Promise<Set<string>>
  save(dir: string, service: string, ids: readonly string[], now: string): Promise<void>
}

// safeServiceSlug throws on dot-only names (`..` would write one directory
// up); load treats that like any other read error (empty set), save surfaces
// it to the caller.
export function createServiceIdSetStore(suffix: string, field: string): ServiceIdSetStore {
  const path = (dir: string, service: string): string => join(dir, `${safeServiceSlug(service)}${suffix}`)
  return {
    async load(dir, service) {
      try {
        const raw = await readFile(path(dir, service), 'utf8')
        const ids = (JSON.parse(raw) as Record<string, unknown>)[field]
        if (!Array.isArray(ids)) return new Set()
        return new Set(ids.filter((id): id is string => typeof id === 'string'))
      } catch {
        return new Set()
      }
    },
    async save(dir, service, ids, now) {
      const file = { version: 1, service, [field]: ids, updatedAt: now }
      await mkdir(dir, { recursive: true })
      await writeFile(path(dir, service), JSON.stringify(file, null, 2))
    },
  }
}

const probeLogStore = createServiceIdSetStore('.json', 'usedIds')

/** Load the set of recently-used probe ids for a service (empty on any error). */
export async function loadUsedProbeIds(dir: string, service: string): Promise<Set<string>> {
  return probeLogStore.load(dir, service)
}

/**
 * Append `ids` to the service's rotation log, keeping the most recent `cap`.
 * Older ids fall off the front so the pool eventually recycles.
 */
export async function recordUsedProbeIds(
  dir: string,
  service: string,
  ids: readonly string[],
  cap: number,
  now: string,
): Promise<void> {
  if (ids.length === 0) return
  const existing = await loadUsedProbeIds(dir, service)
  // Preserve prior order (loadUsedProbeIds returns a Set built in file order),
  // drop any ids we are re-adding, then append the new ids at the end.
  const merged = [...existing].filter((id) => !ids.includes(id))
  merged.push(...ids)
  const trimmed = cap > 0 && merged.length > cap ? merged.slice(merged.length - cap) : merged
  await probeLogStore.save(dir, service, trimmed, now)
}

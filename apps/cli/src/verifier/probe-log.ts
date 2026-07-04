import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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

interface ProbeLogFile {
  version: 1
  service: string
  /** Most-recently-used ids last; capped to a ring buffer. */
  usedIds: string[]
  updatedAt: string
}

function serviceSlug(service: string): string {
  return service.replace(/[^a-z0-9._-]/gi, '_')
}

function logPath(dir: string, service: string): string {
  return join(dir, `${serviceSlug(service)}.json`)
}

/** Load the set of recently-used probe ids for a service (empty on any error). */
export async function loadUsedProbeIds(dir: string, service: string): Promise<Set<string>> {
  try {
    const raw = await readFile(logPath(dir, service), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ProbeLogFile>
    if (!Array.isArray(parsed.usedIds)) return new Set()
    return new Set(parsed.usedIds.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
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

  const file: ProbeLogFile = {
    version: 1,
    service,
    usedIds: trimmed,
    updatedAt: now,
  }
  await mkdir(dir, { recursive: true })
  await writeFile(logPath(dir, service), JSON.stringify(file, null, 2))
}

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FingerprintReference } from '@antseed/fingerprints'

/**
 * Load trusted KBF references from a local directory. Files are JSON in the
 * spec-07 reference envelope format. Invalid files are skipped with a warning
 * via the provided logger — a broken reference must never abort an audit run.
 */
export async function loadReferences(
  referencesDir: string,
  warn: (message: string) => void,
): Promise<FingerprintReference[]> {
  let entries: string[]
  try {
    entries = await readdir(referencesDir)
  } catch {
    return []
  }

  const references: FingerprintReference[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const filePath = join(referencesDir, entry)
    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as FingerprintReference
      if (parsed?.kind !== 'kbf' || !Array.isArray(parsed.probes) || parsed.probes.length === 0) {
        warn(`Skipping reference ${entry}: not a KBF reference with probes`)
        continue
      }
      references.push(parsed)
    } catch (err) {
      warn(`Skipping reference ${entry}: ${(err as Error).message}`)
    }
  }
  return references
}

/** Find the first reference whose serviceAliases match the advertised service. */
export function findReferenceForService(
  references: FingerprintReference[],
  service: string,
): FingerprintReference | undefined {
  const normalized = service.trim().toLowerCase()
  return references.find((ref) =>
    (ref.serviceAliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized)
    || ref.referenceModel?.trim().toLowerCase() === normalized,
  )
}

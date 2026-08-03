import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateKbfReferenceV1, type KbfReferenceV1 } from '@antseed/fingerprints'

/**
 * Load trusted KBF references from a local directory. Files are JSON in the
 * spec-07 reference envelope format. Invalid files are skipped with a warning
 * via the provided logger — a broken reference must never abort an audit run.
 */
export async function loadReferences(
  referencesDir: string,
  warn: (message: string) => void,
  options: { trustedImportedReferenceIds?: readonly string[] } = {},
): Promise<KbfReferenceV1[]> {
  let entries: string[]
  try {
    entries = await readdir(referencesDir)
  } catch {
    return []
  }

  const references: KbfReferenceV1[] = []
  const trustedImported = new Set(options.trustedImportedReferenceIds ?? [])
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const filePath = join(referencesDir, entry)
    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as { referenceId?: unknown; source?: unknown }
      const trustImported = parsed.source !== 'imported'
        || (typeof parsed.referenceId === 'string' && trustedImported.has(parsed.referenceId))
      references.push(validateKbfReferenceV1(parsed, { trustImported }))
    } catch (err) {
      warn(`Skipping reference ${entry}: ${(err as Error).message}`)
    }
  }
  return references.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
}

/** Find the first reference whose serviceAliases match the advertised service. */
export function findReferenceForService(
  references: KbfReferenceV1[],
  service: string,
): KbfReferenceV1 | undefined {
  const normalized = service.trim().toLowerCase()
  return references.find((ref) =>
    (ref.serviceAliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized)
    || ref.referenceModel?.trim().toLowerCase() === normalized,
  )
}

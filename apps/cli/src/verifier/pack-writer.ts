import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import type { EvidenceBundle } from '@antseed/fingerprints'

/**
 * Audit pack publication (transparent audits).
 *
 * The pack is the off-chain half of a fully recomputable audit: the exact
 * request/response plaintexts and seller ResponseAuths whose hashes are
 * anchored on-chain, plus the revealed probe set and the verdicts. Response
 * bodies are far too big for calldata, so only their hashes live on-chain —
 * the pack supplies the bytes those hashes commit to.
 *
 * The pack schema IS the existing evidence-bundle schema
 * (@antseed/fingerprints EvidenceBundle) and the file is written as CANONICAL
 * JSON, so `sha256(file bytes)` equals the bundle's `computeEvidenceHash`
 * (the on-chain attestation's evidenceHash) — a verifier of the pack never
 * needs to re-serialize anything.
 */

/**
 * Exact canonical probe-set JSON bytes matching `computeProbeCommitment`:
 * `sha256(utf8(this string))` (0x-prefixed) IS the on-chain probe commitment,
 * which is what `revealProbeSet` verifies on-chain. Re-exported from
 * @antseed/fingerprints, where `computeProbeCommitment` is defined as the hash
 * of exactly this function's output — a single canonical projection, so the
 * commitment and the reveal bytes cannot drift apart.
 */
export { canonicalProbeSetJson } from '@antseed/fingerprints'

/**
 * Pack path for one audit round: `<publishDir>/<probeCommitment>.json`.
 * The commitment must be a bytes32 hex string — enforced so a hostile value
 * can never traverse out of the publish directory.
 */
export function auditPackPath(publishDir: string, probeCommitment: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(probeCommitment)) {
    throw new Error(`auditPackPath: probeCommitment must be a 0x-prefixed bytes32 hex string, got "${probeCommitment}"`)
  }
  return join(publishDir, `${probeCommitment.toLowerCase()}.json`)
}

/**
 * Write the audit pack as canonical JSON. Deterministic: the same bundle
 * always produces byte-identical output, and the file's SHA-256 equals the
 * bundle's evidenceHash. Returns the written path.
 *
 * Accepts either the bundle or its already-canonical JSON string — the audit
 * runner serializes once, hashes those bytes for the on-chain evidenceHash,
 * and hands the same string here so the file and the hash can never diverge.
 *
 * The write is atomic (temp file in the same directory, then rename): the
 * pack is served over HTTP at the on-chain-referenced URI and its exact bytes
 * must sha256-match the attested evidenceHash, so a concurrent reader or a
 * crash mid-write must never observe a truncated file at the final path.
 */
export async function writeAuditPack(
  publishDir: string,
  probeCommitment: string,
  pack: EvidenceBundle | string,
): Promise<string> {
  const path = auditPackPath(publishDir, probeCommitment)
  await mkdir(publishDir, { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, typeof pack === 'string' ? pack : canonicalJsonStringify(pack))
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  return path
}

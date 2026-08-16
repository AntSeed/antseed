import { File } from 'node:buffer'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalJsonStringify, sha256Hex } from '@antseed/fingerprints'
import {
  renderModelAuditReports,
  verifierRunManifestPath,
  type EpochAuditSummaryV1,
  type ModelAuditSummaryV1,
  type VerifierRunManifestV1,
} from './audit-artifacts.js'
import type { PreparedModelVerificationBundle } from './submission-bundles.js'
import { safeServiceSlug } from './slug.js'

const PINATA_UPLOAD_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS'
const PINATA_UPLOAD_ATTEMPTS = 3
const PINATA_UPLOAD_TIMEOUT_MS = 10 * 60_000

export interface VerificationPublicationFile {
  path: string
  bytes: Uint8Array
  size: number
  sha256: string
}

export interface PreparedVerificationPublication {
  version: 1
  kind: 'antseed-verifier-ipfs-publication-package'
  runId: string
  model: string
  evidenceHash: string
  packageName: string
  files: VerificationPublicationFile[]
  fileCount: number
  totalBytes: number
}

export interface PublishedVerificationEvidence {
  provider: 'pinata'
  evidenceHash: string
  cid: string
  uri: string
  pinSize: number
  fileCount: number
  publishedAt: string
}

interface PinataResponse {
  IpfsHash?: unknown
  PinSize?: unknown
  Timestamp?: unknown
}

interface PinataUploadDependencies {
  endpoint?: string
  fetchImpl?: typeof fetch
  sleep?: (delayMs: number) => Promise<void>
}

class PinataUploadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
  }
}

export async function prepareVerificationPublication(input: {
  evidenceDir: string
  manifest: VerifierRunManifestV1
  modelSummaryPath: string
  bundle: PreparedModelVerificationBundle
}): Promise<PreparedVerificationPublication> {
  const evidenceRoot = resolve(input.evidenceDir)
  const epochSummary = await readEpochSummary(input.manifest.summaryPath, input.manifest.runId)
  const modelEntry = epochSummary.models.find((entry) => entry.model === input.bundle.model)
  if (!modelEntry) throw new Error(`run summary is missing model ${input.bundle.model}`)
  const modelSummary = await readModelSummary(input.modelSummaryPath, input.manifest.runId, input.bundle.model)
  const files = new Map<string, VerificationPublicationFile>()

  const addFile = async (path: string): Promise<void> => {
    const publicationPath = portablePath(evidenceRoot, path)
    const bytes = await readFile(path)
    addPublicationFile(files, publicationPath, bytes)
  }
  const addDirectory = async (directory: string): Promise<void> => {
    for (const path of await listFinalizedFiles(directory)) await addFile(path)
  }

  await addFile(verifierRunManifestPath(input.evidenceDir, input.manifest.runId))
  await addFile(input.manifest.summaryPath)
  addPublicationFile(
    files,
    portablePath(evidenceRoot, input.bundle.evidencePath),
    Buffer.from(canonicalJsonStringify(input.bundle.evidence), 'utf8'),
  )
  await addDirectory(dirname(input.modelSummaryPath))
  if (modelSummary.referenceIntegrityPath) await addFile(modelSummary.referenceIntegrityPath)

  const renderedReports = await renderModelAuditReports(input.evidenceDir, input.manifest.epoch, {
    ...epochSummary,
    reportPaths: [],
    models: [modelEntry],
    failureCount: modelEntry.failureCount,
    cost: modelEntry.cost,
    reasonCounts: modelEntry.reasonCounts,
  })
  const report = renderedReports.find((entry) => entry.model === input.bundle.model)
  if (!report) throw new Error(`could not render report for ${input.bundle.model}`)
  addPublicationFile(files, portablePath(evidenceRoot, report.path), Buffer.from(report.html, 'utf8'))

  const evidenceFiles = [...files.values()].sort((left, right) => left.path.localeCompare(right.path))
  const indexedBytes = evidenceFiles.reduce((total, file) => total + file.size, 0)
  const publicationIndex = {
    version: 1,
    kind: 'antseed-verifier-ipfs-publication',
    runId: input.manifest.runId,
    epoch: input.manifest.epoch,
    model: input.bundle.model,
    evidenceHash: input.bundle.evidenceHash,
    bundlePath: portablePath(evidenceRoot, input.bundle.evidencePath),
    createdAt: input.manifest.completedAt,
    scope: {
      public: true,
      sellerSignedResponses: true,
      exactSignedPreimages: true,
      onChainEvidenceUri: true,
    },
    fileCount: evidenceFiles.length,
    totalBytes: indexedBytes,
    files: evidenceFiles.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
  }
  addPublicationFile(files, 'publication.json', Buffer.from(canonicalJsonStringify(publicationIndex), 'utf8'))
  const allFiles = [...files.values()].sort((left, right) => left.path.localeCompare(right.path))
  return {
    version: 1,
    kind: 'antseed-verifier-ipfs-publication-package',
    runId: input.manifest.runId,
    model: input.bundle.model,
    evidenceHash: input.bundle.evidenceHash,
    packageName: `antseed-verification-${safeServiceSlug(input.manifest.runId)}-${safeServiceSlug(input.bundle.model)}`,
    files: allFiles,
    fileCount: allFiles.length,
    totalBytes: allFiles.reduce((total, file) => total + file.size, 0),
  }
}

export async function publishVerificationToPinata(
  publication: PreparedVerificationPublication,
  jwt: string,
  dependencies: PinataUploadDependencies = {},
): Promise<PublishedVerificationEvidence> {
  if (!jwt.trim()) throw new Error('PINATA_JWT is required with --publish-ipfs')
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const sleep = dependencies.sleep ?? ((delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)))
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= PINATA_UPLOAD_ATTEMPTS; attempt++) {
    try {
      return await uploadPublication(publication, jwt, dependencies.endpoint ?? PINATA_UPLOAD_URL, fetchImpl)
    } catch (error) {
      const failure = error instanceof PinataUploadError
        ? error
        : new PinataUploadError('Pinata upload failed before receiving a response', true)
      lastError = failure
      if (!failure.retryable || attempt === PINATA_UPLOAD_ATTEMPTS) throw failure
      await sleep(500 * (2 ** (attempt - 1)))
    }
  }
  throw lastError ?? new Error('Pinata upload failed')
}

async function uploadPublication(
  publication: PreparedVerificationPublication,
  jwt: string,
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<PublishedVerificationEvidence> {
  const form = new FormData()
  for (const file of publication.files) {
    form.append(
      'file',
      new File([file.bytes], basename(file.path), { type: mediaType(file.path) }),
      `${publication.packageName}/${file.path}`,
    )
  }
  form.append('pinataMetadata', JSON.stringify({
    name: publication.packageName,
    keyvalues: {
      kind: 'antseed-verifier-evidence',
      runId: publication.runId,
      model: publication.model,
      evidenceHash: publication.evidenceHash,
    },
  }))
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }))

  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
      signal: AbortSignal.timeout(PINATA_UPLOAD_TIMEOUT_MS),
    })
  } catch {
    throw new PinataUploadError('Pinata upload failed before receiving a response', true)
  }
  if (!response.ok) {
    throw new PinataUploadError(
      `Pinata upload failed with HTTP ${response.status}`,
      response.status === 429 || response.status >= 500,
    )
  }
  let parsed: PinataResponse
  try {
    parsed = await response.json() as PinataResponse
  } catch {
    throw new PinataUploadError('Pinata returned an invalid JSON response', false)
  }
  const cid = typeof parsed.IpfsHash === 'string' ? parsed.IpfsHash.trim() : ''
  if (!/^b[a-z2-7]{20,}$/.test(cid)) {
    throw new PinataUploadError('Pinata returned an invalid CIDv1', false)
  }
  const pinSize = typeof parsed.PinSize === 'number' && Number.isSafeInteger(parsed.PinSize) && parsed.PinSize >= 0
    ? parsed.PinSize
    : publication.totalBytes
  const publishedAt = typeof parsed.Timestamp === 'string' && Number.isFinite(Date.parse(parsed.Timestamp))
    ? new Date(parsed.Timestamp).toISOString()
    : new Date().toISOString()
  return {
    provider: 'pinata',
    evidenceHash: publication.evidenceHash,
    cid,
    uri: `ipfs://${cid}`,
    pinSize,
    fileCount: publication.fileCount,
    publishedAt,
  }
}

async function readEpochSummary(path: string, runId: string): Promise<EpochAuditSummaryV1> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as EpochAuditSummaryV1
  if (parsed.version !== 1 || parsed.kind !== 'antseed-verifier-epoch-summary' || parsed.runId !== runId) {
    throw new Error(`invalid verifier run summary: ${path}`)
  }
  return parsed
}

async function readModelSummary(path: string, runId: string, model: string): Promise<ModelAuditSummaryV1> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as ModelAuditSummaryV1
  if (parsed.version !== 1 || parsed.kind !== 'antseed-verifier-model-summary'
    || parsed.runId !== runId || parsed.model !== model) {
    throw new Error(`invalid verifier model summary: ${path}`)
  }
  return parsed
}

async function listFinalizedFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (isOperationalEvidenceEntry(entry.name)) continue
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`refusing symlink in verifier evidence: ${path}`)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await walk(directory)
  return files.sort()
}

function isOperationalEvidenceEntry(name: string): boolean {
  return name === '.checkpoints'
    || name === 'status.json'
    || name === 'events.jsonl'
    || name === 'submissions'
    || name.endsWith('.lock')
    || name.includes('.tmp-')
}

function portablePath(evidenceRoot: string, path: string): string {
  const absolutePath = resolve(path)
  const output = relative(evidenceRoot, absolutePath)
  if (!output || output === '..' || output.startsWith(`..${sep}`) || isAbsolute(output)) {
    throw new Error(`verifier evidence path is outside evidenceDir: ${path}`)
  }
  return output.split(sep).join('/')
}

function addPublicationFile(
  files: Map<string, VerificationPublicationFile>,
  path: string,
  bytes: Uint8Array,
): void {
  if (files.has(path)) return
  files.set(path, {
    path,
    bytes,
    size: bytes.byteLength,
    sha256: `sha256:${sha256Hex(bytes)}`,
  })
}

function mediaType(path: string): string {
  if (extname(path) === '.json') return 'application/json'
  if (extname(path) === '.html') return 'text/html; charset=utf-8'
  if (extname(path) === '.md') return 'text/markdown; charset=utf-8'
  return 'application/octet-stream'
}

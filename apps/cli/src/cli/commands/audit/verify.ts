import type { Command } from 'commander'
import chalk from 'chalk'
import { lookup } from 'node:dns/promises'
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Interface, JsonRpcProvider, toUtf8String, zeroPadValue } from 'ethers'
import type { ExchangeRecord } from '@antseed/node'
import { VerifierRegistryClient } from '@antseed/node'
import type { EvidenceBundle, EvidenceSeller } from '@antseed/fingerprints'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { requireCryptoConfig } from '../../payment-utils.js'
import { verifyAudit } from '../../../verifier/audit-verify.js'
import type { OnChainAttestation } from '../../../verifier/audit-verify.js'

/**
 * `antseed audit verify` — the "re-run it yourself" button of Transparent
 * audits. Given only public data (the on-chain anchor calldata, the
 * on-chain probe-set reveal, and optionally the published audit pack), it
 * recomputes the batch root, the commitment opening, every seller signature,
 * the answer extraction, and the verdicts — and compares them against the
 * on-chain attestations. Exits non-zero on any mismatch.
 */

const REGISTRY_IFACE = new Interface([
  'function anchorExchangeBatch(bytes32 probeCommitment, (uint256 agentId, bytes32 requestHash, bytes32 responseHash, bytes responseAuthSig)[] records, bytes[] signingPayloads, uint32[] recordProbeCounts) returns (bytes32)',
  'function revealProbeSet(bytes32 probeCommitment, bytes probeSetJson, string packUri)',
  'event ExchangeBatchAnchored(address indexed verifier, bytes32 indexed probeCommitment, bytes32 indexed batchRoot, uint32 recordCount, uint32 probeCount)',
  'event ProbeSetRevealed(address indexed verifier, bytes32 indexed probeCommitment, string packUri)',
])

const ANCHOR_EVENT_TOPIC = REGISTRY_IFACE.getEvent('ExchangeBatchAnchored')!.topicHash
const REVEAL_EVENT_TOPIC = REGISTRY_IFACE.getEvent('ProbeSetRevealed')!.topicHash
const MAX_REMOTE_PACK_BYTES = 64 * 1024 * 1024
const REMOTE_PACK_TIMEOUT_MS = 30_000

const BLOCKED_PACK_IPV4_ADDRESSES = new BlockList()
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('0.0.0.0', 8, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('10.0.0.0', 8, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('100.64.0.0', 10, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('172.16.0.0', 12, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('192.0.0.0', 24, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('192.0.2.0', 24, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('192.168.0.0', 16, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('198.18.0.0', 15, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('198.51.100.0', 24, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('203.0.113.0', 24, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('224.0.0.0', 4, 'ipv4')
BLOCKED_PACK_IPV4_ADDRESSES.addSubnet('240.0.0.0', 4, 'ipv4')

const BLOCKED_PACK_IPV6_ADDRESSES = new BlockList()
BLOCKED_PACK_IPV6_ADDRESSES.addAddress('::', 'ipv6')
BLOCKED_PACK_IPV6_ADDRESSES.addAddress('::1', 'ipv6')
BLOCKED_PACK_IPV6_ADDRESSES.addSubnet('::ffff:0:0', 96, 'ipv6')
BLOCKED_PACK_IPV6_ADDRESSES.addSubnet('100::', 64, 'ipv6')
BLOCKED_PACK_IPV6_ADDRESSES.addSubnet('2001:db8::', 32, 'ipv6')
BLOCKED_PACK_IPV6_ADDRESSES.addSubnet('fc00::', 7, 'ipv6')
BLOCKED_PACK_IPV6_ADDRESSES.addSubnet('fe80::', 10, 'ipv6')
BLOCKED_PACK_IPV6_ADDRESSES.addSubnet('ff00::', 8, 'ipv6')

export interface DecodedAnchor {
  probeCommitment: string
  records: ExchangeRecord[]
}

/** Decode anchorExchangeBatch calldata into the commitment + records. */
export function decodeAnchorCalldata(data: string): DecodedAnchor {
  const parsed = REGISTRY_IFACE.parseTransaction({ data })
  if (!parsed || parsed.name !== 'anchorExchangeBatch') {
    throw new Error('transaction is not an anchorExchangeBatch call')
  }
  const rawRecords = parsed.args[1] as Array<[bigint, string, string, string]>
  return {
    probeCommitment: parsed.args[0] as string,
    records: rawRecords.map((r) => ({
      agentId: r[0],
      requestHash: r[1],
      responseHash: r[2],
      responseAuthSig: r[3],
    })),
  }
}

/** Decode revealProbeSet calldata into the commitment, probe-set JSON, and pack URI. */
export function decodeRevealCalldata(data: string): { probeCommitment: string; probeSetJson: string; packUri: string } {
  const parsed = REGISTRY_IFACE.parseTransaction({ data })
  if (!parsed || parsed.name !== 'revealProbeSet') {
    throw new Error('transaction is not a revealProbeSet call')
  }
  return {
    probeCommitment: parsed.args[0] as string,
    probeSetJson: toUtf8String(parsed.args[1] as string),
    packUri: (parsed.args[2] as string) ?? '',
  }
}

function isBlockedPackAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return BLOCKED_PACK_IPV4_ADDRESSES.check(address, 'ipv4')
  if (version === 6) return BLOCKED_PACK_IPV6_ADDRESSES.check(address, 'ipv6')
  return true
}

/** Validate an explicitly requested remote pack fetch. */
export function validatePackFetchUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('remote pack URI must use HTTPS')
  if (url.username || url.password) throw new Error('remote pack URI must not contain credentials')
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('remote pack URI must not target a local hostname')
  }
  const ipVersion = isIP(hostname)
  if (ipVersion !== 0 && isBlockedPackAddress(hostname)) {
    throw new Error('remote pack URI must not target a private IP')
  }
  return url
}

export interface PackFetchTarget {
  url: URL
  address: string
  family: 4 | 6
}

export type PackHostResolver = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>

const resolvePackHost: PackHostResolver = async (hostname) => {
  const entries = await lookup(hostname, { all: true, verbatim: true })
  return entries.map((entry) => {
    if (entry.family !== 4 && entry.family !== 6) {
      throw new Error(`remote pack hostname resolved with unsupported address family ${entry.family}`)
    }
    return { address: entry.address, family: entry.family }
  })
}

export async function resolvePackFetchTarget(
  value: string,
  resolveHost: PackHostResolver = resolvePackHost,
): Promise<PackFetchTarget> {
  const url = validatePackFetchUrl(value)
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const literalFamily = isIP(hostname)
  if (literalFamily === 4 || literalFamily === 6) {
    return { url, address: hostname, family: literalFamily as 4 | 6 }
  }

  const resolved = await resolveHost(hostname)
  if (resolved.length === 0) throw new Error('remote pack hostname did not resolve')
  for (const entry of resolved) {
    if (isBlockedPackAddress(entry.address)) {
      throw new Error(`remote pack hostname resolves to a private IP (${entry.address})`)
    }
  }
  const target = resolved[0]!
  return { url, address: target.address, family: target.family }
}

export async function fetchRemoteAuditPack(value: string): Promise<EvidenceBundle> {
  const target = await resolvePackFetchTarget(value)
  return new Promise<EvidenceBundle>((resolve, reject) => {
    const request = httpsRequest({
      protocol: 'https:',
      hostname: target.address,
      family: target.family,
      port: target.url.port ? Number(target.url.port) : 443,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'GET',
      servername: target.url.hostname,
      headers: {
        accept: 'application/json',
        host: target.url.host,
        'user-agent': 'antseed-audit-verify/1',
      },
    }, (response) => {
      const statusCode = response.statusCode ?? 0
      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        reject(new Error(`HTTP ${statusCode}`))
        return
      }

      const declaredLength = Number(response.headers['content-length'] ?? 0)
      if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_PACK_BYTES) {
        response.destroy()
        reject(new Error(`remote pack exceeds ${MAX_REMOTE_PACK_BYTES} bytes`))
        return
      }

      const chunks: Buffer[] = []
      let received = 0
      response.on('data', (chunk: Buffer | Uint8Array) => {
        received += chunk.byteLength
        if (received > MAX_REMOTE_PACK_BYTES) {
          request.destroy(new Error(`remote pack exceeds ${MAX_REMOTE_PACK_BYTES} bytes`))
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as EvidenceBundle)
        } catch (err) {
          reject(new Error(`invalid audit pack JSON: ${(err as Error).message}`))
        }
      })
    })
    request.setTimeout(REMOTE_PACK_TIMEOUT_MS, () => {
      request.destroy(new Error(`remote pack request timed out after ${REMOTE_PACK_TIMEOUT_MS}ms`))
    })
    request.on('error', reject)
    request.end()
  })
}

export interface FetchedAnchor extends DecodedAnchor {
  verifier: string
  batchRoot: string
  txHash: string
  /** Block the anchor tx was mined in — the lower bound for the reveal scan. */
  blockNumber: number
}

async function fetchAnchorByTx(
  provider: JsonRpcProvider,
  txHash: string,
): Promise<FetchedAnchor> {
  const tx = await provider.getTransaction(txHash)
  if (!tx) throw new Error(`anchor transaction ${txHash} not found`)
  const decoded = decodeAnchorCalldata(tx.data)
  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt) throw new Error(`anchor transaction ${txHash} has no receipt (still pending?)`)
  const log = receipt.logs.find((l) => l.topics[0] === ANCHOR_EVENT_TOPIC)
  if (!log || !log.topics[3]) {
    throw new Error('anchor transaction emitted no ExchangeBatchAnchored event (reverted or wrong contract?)')
  }
  return {
    ...decoded,
    verifier: tx.from,
    batchRoot: log.topics[3],
    txHash,
    blockNumber: receipt.blockNumber,
  }
}

async function fetchAnchorByCommitment(
  provider: JsonRpcProvider,
  registry: string,
  verifier: string,
  commitment: string,
  fromBlock: number,
): Promise<FetchedAnchor> {
  const logs = await provider.getLogs({
    address: registry,
    fromBlock,
    toBlock: 'latest',
    topics: [ANCHOR_EVENT_TOPIC, zeroPadValue(verifier, 32), commitment],
  })
  const log = logs.at(-1)
  if (!log) {
    throw new Error(`no ExchangeBatchAnchored event for commitment ${commitment} by verifier ${verifier} (scanned from block ${fromBlock})`)
  }
  const tx = await provider.getTransaction(log.transactionHash)
  if (!tx) throw new Error(`anchor transaction ${log.transactionHash} not found`)
  const decoded = decodeAnchorCalldata(tx.data)
  if (!log.topics[3]) throw new Error('malformed ExchangeBatchAnchored event')
  return {
    ...decoded,
    verifier,
    batchRoot: log.topics[3],
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
  }
}

/** Fetch the revealed probe-set JSON (and pack URI) for an anchor. */
async function fetchReveal(
  provider: JsonRpcProvider,
  registry: string,
  verifier: string,
  commitment: string,
  fromBlock: number,
): Promise<{ probeSetJson: string; packUri: string }> {
  const logs = await provider.getLogs({
    address: registry,
    fromBlock,
    toBlock: 'latest',
    topics: [REVEAL_EVENT_TOPIC, zeroPadValue(verifier, 32), commitment],
  })
  const log = logs.at(-1)
  if (!log) {
    throw new Error(
      `no ProbeSetRevealed event for commitment ${commitment} — the verifier has not revealed this probe set yet (scanned from block ${fromBlock})`,
    )
  }
  const tx = await provider.getTransaction(log.transactionHash)
  if (!tx) throw new Error(`reveal transaction ${log.transactionHash} not found`)
  const decoded = decodeRevealCalldata(tx.data)
  return { probeSetJson: decoded.probeSetJson, packUri: decoded.packUri }
}

/**
 * Resolve the anchor (by tx hash, or by a commitment event scan bounded by
 * `fromBlock`) and its matching reveal. The reveal scan is always bounded by
 * the anchor's block — the reveal is mined at or after the anchor — so the
 * --tx path never degenerates into an unbounded genesis-to-head scan.
 */
export async function fetchAnchorAndReveal(
  provider: JsonRpcProvider,
  registry: string,
  opts: { txHash?: string; verifier?: string; commitment?: string; fromBlock: number },
): Promise<{ anchor: FetchedAnchor; reveal: { probeSetJson: string; packUri: string } }> {
  const anchor = opts.txHash
    ? await fetchAnchorByTx(provider, opts.txHash)
    : await fetchAnchorByCommitment(provider, registry, opts.verifier!, opts.commitment!, opts.fromBlock)
  const reveal = await fetchReveal(provider, registry, anchor.verifier, anchor.probeCommitment, anchor.blockNumber)
  return { anchor, reveal }
}

/**
 * Read the latest on-chain attestation for every audited seller, in parallel.
 * A failed read for one seller warns and is skipped; the rest still populate
 * the map (keyed by agentId).
 */
export async function fetchLatestAttestations(
  client: Pick<VerifierRegistryClient, 'latestAttestation'>,
  sellers: ReadonlyArray<Pick<EvidenceSeller, 'agentId'>>,
  service: string,
): Promise<Map<number, OnChainAttestation>> {
  const attestations = new Map<number, OnChainAttestation>()
  await Promise.all(sellers.map(async (seller) => {
    if (!seller.agentId) return
    try {
      const latest = await client.latestAttestation(seller.agentId, service)
      if (latest) {
        attestations.set(seller.agentId, {
          verdict: latest.verdict,
          probeCommitment: latest.probeCommitment,
          evidenceHash: latest.evidenceHash,
          batchRoot: latest.batchRoot,
        })
      }
    } catch (err) {
      console.warn(chalk.yellow(`attestation read failed for agent ${seller.agentId}: ${(err as Error).message}`))
    }
  }))
  return attestations
}

function mark(ok: boolean): string {
  return ok ? chalk.green('OK ') : chalk.red('FAIL')
}

export function registerAuditVerifyCommand(auditCmd: Command): void {
  auditCmd
    .command('verify')
    .description('Recompute a published audit from on-chain data (and optionally its audit pack) and compare against the attestations')
    .option('--rpc-url <url>', 'Base JSON-RPC URL (default: from config payments.crypto)')
    .option('--registry <address>', 'AntseedVerifierRegistry address (default: from config payments.crypto)')
    .option('--commitment <hex>', 'probe-set commitment (bytes32) of the audit to verify')
    .option('--verifier <address>', 'verifier wallet address (required with --commitment)')
    .option('--tx <hash>', 'anchorExchangeBatch transaction hash — the DIRECT path (no log scan); preferred on public RPCs')
    .option('--pack <path>', 'local audit pack file (overrides the on-chain pack URI) — enables signature, answer and verdict recomputation')
    .option('--fetch-pack', 'explicitly allow fetching the verifier-provided HTTPS pack URI')
    .option('--from-block <n>', 'first block for the --commitment event scan (use the registry deployment block; public RPCs reject unbounded genesis scans)', (v) => parseInt(v, 10))
    .action(async (options) => {
      const globalOpts = getGlobalOptions(auditCmd)

      // Config is only a fallback for --rpc-url/--registry; a fully explicit
      // invocation must work on a machine with no AntSeed config at all.
      let rpcUrl = options.rpcUrl as string | undefined
      let registry = options.registry as string | undefined
      if (!rpcUrl || !registry) {
        try {
          const config = await loadConfig(globalOpts.config)
          const crypto = requireCryptoConfig(config, rpcUrl ? { rpcUrl } : {})
          rpcUrl = rpcUrl ?? crypto.rpcUrl
          registry = registry ?? crypto.verifierRegistryAddress
        } catch {
          // fall through to the explicit-flags check below
        }
      }
      if (!rpcUrl) {
        console.error(chalk.red('No RPC URL. Pass --rpc-url or configure payments.crypto.'))
        process.exit(1)
      }
      if (!registry) {
        console.error(chalk.red('No registry address. Pass --registry or configure payments.crypto.verifierRegistryAddress.'))
        process.exit(1)
      }

      const txHash = options.tx as string | undefined
      const commitmentFlag = options.commitment as string | undefined
      const verifierFlag = options.verifier as string | undefined
      if (!txHash && !commitmentFlag) {
        console.error(chalk.red('Pass --tx <anchorTxHash> or --commitment <hex> --verifier <address>.'))
        process.exit(1)
      }
      if (!txHash && commitmentFlag && !verifierFlag) {
        console.error(chalk.red('--commitment requires --verifier <address> (events are indexed per verifier).'))
        process.exit(1)
      }

      // Event-scan lower bound for the --commitment anchor scan (pass the
      // registry deployment block). The reveal scan is always bounded by the
      // anchor's own block, so only the anchor scan can hit genesis — real
      // RPCs reject an unbounded genesis scan, hence the --tx path (no anchor
      // scan) is preferred.
      const fromBlock = Number.isFinite(options.fromBlock as number) ? (options.fromBlock as number) : 0
      if (!txHash && fromBlock === 0) {
        console.warn(chalk.yellow('Scanning events from genesis (block 0) — most public RPCs reject this. Pass --from-block <deployBlock> or use --tx <anchorTxHash>, and point --rpc-url at an archive node.'))
      }

      const provider = new JsonRpcProvider(rpcUrl)
      try {
        const { anchor, reveal } = await fetchAnchorAndReveal(provider, registry, {
          ...(txHash ? { txHash } : {}),
          ...(verifierFlag ? { verifier: verifierFlag } : {}),
          ...(commitmentFlag ? { commitment: commitmentFlag } : {}),
          fromBlock,
        })
        console.log(chalk.dim(`Anchor tx ${anchor.txHash} — ${anchor.records.length} exchange(s), batch root ${anchor.batchRoot}`))

        const revealedProbeSetJson = reveal.probeSetJson
        console.log(chalk.dim(`Probe set revealed (${revealedProbeSetJson.length} bytes)${reveal.packUri ? `, pack URI ${reveal.packUri}` : ''}`))

        let pack: EvidenceBundle | undefined
        if (options.pack) {
          pack = JSON.parse(await readFile(options.pack as string, 'utf8')) as EvidenceBundle
          console.log(chalk.dim(`Pack loaded from ${options.pack as string} (${pack.sellers.length} seller(s))`))
        } else if (reveal.packUri && options.fetchPack === true) {
          // No local pack: fetch it from the on-chain pack URI so recomputation
          // works from chain data alone. (VerifierRegistryClient.getRevealedPackUri
          // returns this same value from the ProbeSetRevealed event; it is
          // already decoded from the reveal calldata above, so no extra scan.)
          try {
            pack = await fetchRemoteAuditPack(reveal.packUri)
            console.log(chalk.dim(`Pack fetched from ${reveal.packUri} (${pack.sellers.length} seller(s))`))
          } catch (err) {
            console.warn(chalk.yellow(`Could not fetch the on-chain pack (${(err as Error).message}); running chain-only checks. Pass --pack <path> to recompute verdicts.`))
          }
        } else if (reveal.packUri) {
          console.log(chalk.yellow('Remote pack not fetched automatically. Pass --fetch-pack to opt in, or --pack <path> to use a local copy.'))
        }

        // Latest on-chain attestations per audited seller (pack mode only —
        // agent ids come from the pack).
        let attestations: Map<number, OnChainAttestation> | undefined
        if (pack) {
          const client = new VerifierRegistryClient({ rpcUrl, contractAddress: registry })
          attestations = await fetchLatestAttestations(client, pack.sellers, pack.service)
        }

        const report = verifyAudit({
          probeCommitment: anchor.probeCommitment,
          records: anchor.records,
          onChainBatchRoot: anchor.batchRoot,
          revealedProbeSetJson,
          ...(pack ? { pack } : {}),
          ...(attestations ? { attestations } : {}),
        })

        console.log('')
        console.log(chalk.bold(`Audit ${anchor.probeCommitment}`))
        for (const check of report.checks) {
          console.log(`  ${mark(check.ok)} ${check.name} — ${check.detail}`)
        }
        if (report.sellers.length > 0) {
          console.log('')
          console.log(chalk.bold('Sellers:'))
          for (const seller of report.sellers) {
            const chain = seller.onChainVerdict
              ? `on-chain ${seller.onChainVerdict} (${seller.attestationStatus})`
              : `attestation ${seller.attestationStatus}`
            console.log(
              `  ${mark(seller.ok)} agent ${seller.agentId} ${seller.sellerPeerId.slice(0, 12)}… — ` +
              `pack ${seller.packVerdict}, recomputed ${seller.recomputedVerdict ?? 'n/a'} ` +
              `(cohort ${seller.recomputedCohortVerdict ?? 'n/a'}${seller.recomputedReferenceVerdict ? `, ref ${seller.recomputedReferenceVerdict}` : ''}), ${chain}` +
              `${seller.responseAuthsValid ? '' : ', BAD SIGNATURES'}` +
              `${seller.anchored ? '' : ', NOT ANCHORED'}` +
              `${seller.answersMatch ? '' : ', ANSWER MISMATCH'}` +
              `${seller.recomputedVerdict !== null && seller.recomputedVerdict !== seller.packVerdict ? ', VERDICT NOT REPRODUCED' : ''}`,
            )
            // Soft signals (not failures): surface separately so they don't
            // read as hard mismatches.
            if (seller.suspiciousAnchorSubset) {
              console.log(chalk.yellow(`      ⚠ only a subset of this seller's probes were anchored (possible selective anchoring)`))
            }
            if (seller.singleCarrierSame) {
              console.log(chalk.yellow(`      ⚠ SAME corroborated by a single delegate carrier (weak stealth)`))
            }
          }
        }
        console.log('')
        if (report.ok) {
          console.log(chalk.green.bold('VERIFIED — the audit recomputes cleanly from public data.'))
        } else {
          console.log(chalk.red.bold('MISMATCH — the audit does not recompute from public data.'))
          process.exitCode = 1
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message))
        process.exitCode = 1
      } finally {
        provider.destroy()
      }
    })
}

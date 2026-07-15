import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Interface, keccak256, toUtf8Bytes, zeroPadValue } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { serviceHash } from '@antseed/node'
import {
  decodeAnchorCalldata,
  decodeRevealCalldata,
  fetchAnchorAndReveal,
  fetchMatchingAttestations,
  resolvePackFetchTarget,
  validatePackFetchUrl,
} from './verify.js'

const IFACE = new Interface([
  'function anchorExchangeBatch(bytes32 probeCommitment, (uint256 agentId, bytes32 requestHash, bytes32 responseHash, bytes responseAuthSig)[] records, bytes[] signingPayloads, uint32[] recordProbeCounts) returns (bytes32)',
  'function revealProbeSet(bytes32 probeCommitment, bytes probeSetJson, string packUri)',
  'event ExchangeBatchAnchored(address indexed verifier, bytes32 indexed probeCommitment, bytes32 indexed batchRoot, uint32 recordCount, uint32 probeCount)',
  'event ProbeSetRevealed(address indexed verifier, bytes32 indexed probeCommitment, string packUri)',
  'event AttestationSubmitted(uint256 indexed agentId, bytes32 indexed serviceHash, address indexed verifier, uint8 verdict, bytes32 evidenceHash, bytes32 probeCommitment, bytes32 batchRoot, uint32 probeCount, uint32 cohortSize, bool credited, uint256 epoch)',
])

const ANCHOR_TOPIC = IFACE.getEvent('ExchangeBatchAnchored')!.topicHash
const REVEAL_TOPIC = IFACE.getEvent('ProbeSetRevealed')!.topicHash

const COMMITMENT = '0x' + 'ab'.repeat(32)
const BATCH_ROOT = '0x' + 'cd'.repeat(32)
const VERIFIER = '0x' + '11'.repeat(20)
const REGISTRY = '0x' + '22'.repeat(20)
const ANCHOR_TX = '0x' + '33'.repeat(32)
const REVEAL_TX = '0x' + '44'.repeat(32)
const PROBE_SET_JSON = '{"nonce":"ff","probes":[]}'
const PACK_URI = 'https://packs.example.com/audits/0xabc.json'

interface GetLogsFilter { fromBlock: number; toBlock: string; topics: string[] }

/** Minimal RPC stub: canned txs/receipt, recorded getLogs calls. */
function stubProvider(opts: {
  anchorBlock: number
  anchorTo?: string
  anchorLogAddress?: string
  onGetLogs: (filter: GetLogsFilter) => Array<{ transactionHash: string; blockNumber: number; topics: string[] }>
}): { provider: JsonRpcProvider; getLogsCalls: GetLogsFilter[] } {
  const anchorData = IFACE.encodeFunctionData('anchorExchangeBatch', [COMMITMENT, [], [], []])
  const revealData = IFACE.encodeFunctionData('revealProbeSet', [COMMITMENT, toUtf8Bytes(PROBE_SET_JSON), PACK_URI])
  const txs: Record<string, { data: string; from: string; to: string }> = {
    [ANCHOR_TX]: { data: anchorData, from: VERIFIER, to: opts.anchorTo ?? REGISTRY },
    [REVEAL_TX]: { data: revealData, from: VERIFIER, to: REGISTRY },
  }
  const getLogsCalls: GetLogsFilter[] = []
  const provider = {
    async getTransaction(hash: string) {
      return txs[hash] ?? null
    },
    async getTransactionReceipt(hash: string) {
      if (hash !== ANCHOR_TX) return null
      return {
        blockNumber: opts.anchorBlock,
        logs: [{
          address: opts.anchorLogAddress ?? REGISTRY,
          topics: [ANCHOR_TOPIC, zeroPadValue(VERIFIER, 32), COMMITMENT, BATCH_ROOT],
        }],
      }
    },
    async getLogs(filter: GetLogsFilter) {
      getLogsCalls.push(filter)
      return opts.onGetLogs(filter)
    },
  } as unknown as JsonRpcProvider
  return { provider, getLogsCalls }
}

test('decodeAnchorCalldata round-trips the commitment and every record field', () => {
  const records = [0, 1, 2].map((i) => [
    BigInt(i + 7),
    keccak256(toUtf8Bytes(`req-${i}`)),
    keccak256(toUtf8Bytes(`res-${i}`)),
    '0x' + `${i}1`.repeat(65),
  ])
  const signingPayloads = records.map((_r, i) => toUtf8Bytes(`payload-${i}`))
  const recordProbeCounts = records.map(() => 1)
  const data = IFACE.encodeFunctionData('anchorExchangeBatch', [COMMITMENT, records, signingPayloads, recordProbeCounts])

  const decoded = decodeAnchorCalldata(data)
  assert.equal(decoded.probeCommitment, COMMITMENT)
  assert.equal(decoded.records.length, 3)
  decoded.records.forEach((record, i) => {
    assert.equal(record.agentId, BigInt(i + 7))
    assert.equal(record.requestHash, records[i]![1])
    assert.equal(record.responseHash, records[i]![2])
    assert.equal(record.responseAuthSig, records[i]![3])
  })
})

test('decodeAnchorCalldata rejects foreign calldata', () => {
  const data = IFACE.encodeFunctionData('revealProbeSet', [COMMITMENT, toUtf8Bytes('{}'), ''])
  assert.throws(() => decodeAnchorCalldata(data), /not an anchorExchangeBatch/)
})

test('decodeRevealCalldata recovers the probe-set JSON and pack URI', () => {
  const probeSetJson = '{"nonce":"ff","probes":[],"service":"kimi-k2"}'
  const packUri = 'https://packs.example.com/audits/0xabc.json'
  const data = IFACE.encodeFunctionData('revealProbeSet', [COMMITMENT, toUtf8Bytes(probeSetJson), packUri])
  const decoded = decodeRevealCalldata(data)
  assert.equal(decoded.probeCommitment, COMMITMENT)
  assert.equal(decoded.probeSetJson, probeSetJson)
  assert.equal(decoded.packUri, packUri)
})

test('decodeRevealCalldata rejects foreign calldata', () => {
  const data = IFACE.encodeFunctionData('anchorExchangeBatch', [COMMITMENT, [], [], []])
  assert.throws(() => decodeRevealCalldata(data), /not a revealProbeSet/)
})

test('--tx path bounds the reveal scan to the anchor block (never fromBlock 0)', async () => {
  const { provider, getLogsCalls } = stubProvider({
    anchorBlock: 1234,
    onGetLogs: () => [{ transactionHash: REVEAL_TX, blockNumber: 1240, topics: [REVEAL_TOPIC] }],
  })

  const { anchor, reveal } = await fetchAnchorAndReveal(provider, REGISTRY, { txHash: ANCHOR_TX, fromBlock: 0 })

  assert.equal(anchor.blockNumber, 1234)
  assert.equal(anchor.batchRoot, BATCH_ROOT)
  assert.equal(reveal.probeSetJson, PROBE_SET_JSON)
  assert.equal(reveal.packUri, PACK_URI)
  // Exactly one getLogs (the reveal scan) — the anchor comes from the receipt
  // — and it starts at the anchor block, not genesis.
  assert.equal(getLogsCalls.length, 1)
  assert.equal(getLogsCalls[0]!.fromBlock, 1234)
  assert.equal(getLogsCalls[0]!.topics[0], REVEAL_TOPIC)
})

test('--tx path rejects an anchor call sent to a different contract', async () => {
  const { provider } = stubProvider({
    anchorBlock: 1234,
    anchorTo: '0x' + '99'.repeat(20),
    onGetLogs: () => [],
  })

  await assert.rejects(
    fetchAnchorAndReveal(provider, REGISTRY, { txHash: ANCHOR_TX, fromBlock: 0 }),
    /was not sent to registry/,
  )
})

test('--tx path rejects a matching event emitted by a different contract', async () => {
  const { provider } = stubProvider({
    anchorBlock: 1234,
    anchorLogAddress: '0x' + '99'.repeat(20),
    onGetLogs: () => [],
  })

  await assert.rejects(
    fetchAnchorAndReveal(provider, REGISTRY, { txHash: ANCHOR_TX, fromBlock: 0 }),
    /emitted no ExchangeBatchAnchored event/,
  )
})

test('commitment path scans the anchor from --from-block and the reveal from the anchor block', async () => {
  const { provider, getLogsCalls } = stubProvider({
    anchorBlock: 777,
    onGetLogs: (filter) =>
      filter.topics[0] === ANCHOR_TOPIC
        ? [{
            transactionHash: ANCHOR_TX,
            blockNumber: 777,
            topics: [ANCHOR_TOPIC, zeroPadValue(VERIFIER, 32), COMMITMENT, BATCH_ROOT],
          }]
        : [{ transactionHash: REVEAL_TX, blockNumber: 800, topics: [REVEAL_TOPIC] }],
  })

  const { anchor, reveal } = await fetchAnchorAndReveal(provider, REGISTRY, {
    verifier: VERIFIER,
    commitment: COMMITMENT,
    fromBlock: 500,
  })

  assert.equal(anchor.blockNumber, 777)
  assert.equal(reveal.probeSetJson, PROBE_SET_JSON)
  assert.equal(getLogsCalls.length, 2)
  assert.equal(getLogsCalls[0]!.topics[0], ANCHOR_TOPIC)
  assert.equal(getLogsCalls[0]!.fromBlock, 500)
  assert.equal(getLogsCalls[1]!.topics[0], REVEAL_TOPIC)
  assert.equal(getLogsCalls[1]!.fromBlock, 777)
})

test('fetchMatchingAttestations finds the historical audit and tolerates one seller failing', async (t) => {
  t.mock.method(console, 'warn', () => {})
  let inFlight = 0
  let maxInFlight = 0
  const attestationEvent = IFACE.getEvent('AttestationSubmitted')!
  const provider = {
    async getLogs(filter: GetLogsFilter) {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      const agentId = Number(BigInt(filter.topics[1]!))
      if (agentId === 8) throw new Error('rpc boom')
      if (agentId === 9) return []
      const superseded = IFACE.encodeEventLog(attestationEvent, [
        agentId, serviceHash('kimi-k2'), VERIFIER, 1, BATCH_ROOT,
        '0x' + 'ee'.repeat(32), '0x' + 'ff'.repeat(32), 3, 4, true, 1,
      ])
      const historical = IFACE.encodeEventLog(attestationEvent, [
        agentId, serviceHash('kimi-k2'), VERIFIER, 2, BATCH_ROOT,
        COMMITMENT, BATCH_ROOT, 3, 4, true, 1,
      ])
      return [
        { ...historical, blockNumber: 600, transactionHash: ANCHOR_TX },
        { ...superseded, blockNumber: 700, transactionHash: REVEAL_TX },
      ]
    },
  } as unknown as JsonRpcProvider

  const attestations = await fetchMatchingAttestations(
    provider,
    REGISTRY,
    VERIFIER,
    [{ agentId: 7 }, { agentId: 8 }, { agentId: 9 }],
    'kimi-k2',
    COMMITMENT,
    BATCH_ROOT,
    BATCH_ROOT,
    500,
  )

  assert.equal(maxInFlight, 3)
  assert.equal(attestations.size, 1)
  assert.deepEqual(attestations.get(7), {
    verdict: 2,
    probeCommitment: COMMITMENT,
    evidenceHash: BATCH_ROOT,
    batchRoot: BATCH_ROOT,
  })
})

test('validatePackFetchUrl requires explicit public HTTPS destinations', () => {
  assert.equal(validatePackFetchUrl('https://packs.example.com/audit.json').hostname, 'packs.example.com')
  assert.throws(() => validatePackFetchUrl('http://packs.example.com/audit.json'), /HTTPS/)
  assert.throws(() => validatePackFetchUrl('https://localhost/audit.json'), /local hostname/)
  assert.throws(() => validatePackFetchUrl('https://127.0.0.1/audit.json'), /private IP/)
  assert.throws(() => validatePackFetchUrl('https://10.0.0.1/audit.json'), /private IP/)
  assert.throws(() => validatePackFetchUrl('https://[::1]/audit.json'), /private IP/)
  assert.throws(() => validatePackFetchUrl('https://192.0.2.1/audit.json'), /private IP/)
  assert.throws(() => validatePackFetchUrl('https://[2001:db8::1]/audit.json'), /private IP/)
  assert.throws(() => validatePackFetchUrl('https://user:pass@packs.example.com/audit.json'), /credentials/)
})

test('resolvePackFetchTarget rejects DNS answers containing private addresses', async () => {
  await assert.rejects(
    resolvePackFetchTarget('https://packs.example.com/audit.json', async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    /resolves to a private IP/,
  )
})

test('resolvePackFetchTarget pins a public DNS answer', async () => {
  const target = await resolvePackFetchTarget(
    'https://packs.example.com:8443/audit.json?x=1',
    async () => [{ address: '8.8.8.8', family: 4 }],
  )
  assert.equal(target.address, '8.8.8.8')
  assert.equal(target.family, 4)
  assert.equal(target.url.hostname, 'packs.example.com')
  assert.equal(target.url.port, '8443')
})

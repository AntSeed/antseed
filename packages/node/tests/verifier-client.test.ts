import { Interface, Wallet, keccak256, toUtf8Bytes, zeroPadValue, type AbstractSigner, type InterfaceAbi } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VerifierRegistryClient,
  decodeAnchorCalldata,
  decodeRevealCalldata,
  serviceHash,
} from '../src/payments/evm/verifier-client.js';
import { computeBatchRoot } from '../src/verification/exchange-batch.js';
import { buildFixtureRecords } from './helpers/exchange-fixtures.js';

const FAKE_TX_HASH = '0x' + 'ab'.repeat(32);

/**
 * Stubs the tx pipeline but still ABI-encodes every write's calldata — so a
 * mismatch between an ABI fragment and the argument shape a method passes
 * (e.g. the ExchangeRecord tuple mapping) fails here instead of at the first
 * live transaction.
 */
class StubbedRegistryClient extends VerifierRegistryClient {
  readonly writes: Array<{ method: string; calldata: string }> = [];

  protected override async _execWrite(
    _signer: AbstractSigner,
    abi: InterfaceAbi,
    method: string,
    ...args: unknown[]
  ): Promise<string> {
    const calldata = new Interface(abi as string[]).encodeFunctionData(method, args);
    this.writes.push({ method, calldata });
    return FAKE_TX_HASH;
  }
}

function makeClient(): StubbedRegistryClient {
  return new StubbedRegistryClient({
    rpcUrl: 'http://127.0.0.1:1', // never contacted — _execWrite is stubbed
    contractAddress: '0x' + '11'.repeat(20),
  });
}

const signer = new Wallet('0x' + '7'.repeat(64));

/** Distinct per-record signing preimages, aligned with fixture records. */
function fixtureSigningPayloads(n: number): Uint8Array[] {
  return Array.from({ length: n }, (_v, i) => new TextEncoder().encode(`signing-payload-${i}`));
}

describe('VerifierRegistryClient transparent-audit writes', () => {
  it('anchorExchangeBatch encodes record tuples, per-record signing payloads and probe counts, and returns the locally computed root', async () => {
    const client = makeClient();
    const records = buildFixtureRecords(3);
    const signingPayloads = fixtureSigningPayloads(3);
    // 3 signed requests bundling 7 probes — per-record counts sum > recordCount
    // is the normal shape (each record carries up to maxProbesPerRequest probes).
    const recordProbeCounts = [3, 2, 2];
    const probeCommitment = keccak256(toUtf8Bytes('commitment'));

    const { txHash, batchRoot } = await client.anchorExchangeBatch(signer, {
      probeCommitment,
      records,
      signingPayloads,
      recordProbeCounts,
    });

    expect(txHash).toBe(FAKE_TX_HASH);
    expect(batchRoot).toBe(computeBatchRoot(records));
    expect(client.writes).toHaveLength(1);
    expect(client.writes[0].method).toBe('anchorExchangeBatch');
    // The calldata embeds each record's hashes and its signing payload — root ↔
    // data binding is the contract's job, but the fields must reach the wire.
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      expect(client.writes[0].calldata).toContain(record.requestHash.slice(2));
      expect(client.writes[0].calldata).toContain(record.responseHash.slice(2));
      expect(client.writes[0].calldata).toContain(record.responseAuthSig.slice(2));
      expect(client.writes[0].calldata).toContain(
        Buffer.from(signingPayloads[i]!).toString('hex'),
      );
    }
  });

  it('anchorExchangeBatch rejects an empty batch before any tx is attempted', async () => {
    const client = makeClient();
    await expect(client.anchorExchangeBatch(signer, {
      probeCommitment: keccak256(toUtf8Bytes('commitment')),
      records: [],
      signingPayloads: [],
      recordProbeCounts: [],
    })).rejects.toThrow(/empty/i);
    expect(client.writes).toHaveLength(0);
  });

  it('anchorExchangeBatch rejects mismatched array lengths before any tx is attempted', async () => {
    const client = makeClient();
    const records = buildFixtureRecords(3);
    const probeCommitment = keccak256(toUtf8Bytes('commitment'));

    await expect(client.anchorExchangeBatch(signer, {
      probeCommitment,
      records,
      signingPayloads: fixtureSigningPayloads(2), // too few
      recordProbeCounts: [1, 1, 1],
    })).rejects.toThrow(/length mismatch/i);
    await expect(client.anchorExchangeBatch(signer, {
      probeCommitment,
      records,
      signingPayloads: fixtureSigningPayloads(3),
      recordProbeCounts: [1, 1], // too few
    })).rejects.toThrow(/length mismatch/i);
    expect(client.writes).toHaveLength(0);
  });

  it('anchorExchangeBatch rejects a per-record probe count outside 1..3 before any tx is attempted', async () => {
    const client = makeClient();
    const records = buildFixtureRecords(3);
    const signingPayloads = fixtureSigningPayloads(3);
    const probeCommitment = keccak256(toUtf8Bytes('commitment'));

    // Every anchored exchange carries at least one probe — the contract reverts
    // with RecordProbeCountZero, so fail local.
    await expect(client.anchorExchangeBatch(signer, { probeCommitment, records, signingPayloads, recordProbeCounts: [1, 0, 1] }))
      .rejects.toThrow(/recordProbeCounts/);
    await expect(client.anchorExchangeBatch(signer, { probeCommitment, records, signingPayloads, recordProbeCounts: [1, 1, 3.5] }))
      .rejects.toThrow(/recordProbeCounts/);
    await expect(client.anchorExchangeBatch(signer, { probeCommitment, records, signingPayloads, recordProbeCounts: [1, 4, 1] }))
      .rejects.toThrow(/recordProbeCounts/);
    expect(client.writes).toHaveLength(0);

    // Every count == 1 is the accepted lower bound.
    await client.anchorExchangeBatch(signer, { probeCommitment, records, signingPayloads, recordProbeCounts: [1, 1, 1] });
    expect(client.writes).toHaveLength(1);
  });

  it('claimDelegateCredits encodes the (verifier, probeCommitment, buyer, agentId, serviceHash) tuple', async () => {
    const client = makeClient();
    const verifier = '0x' + '22'.repeat(20);
    const buyer = '0x' + '33'.repeat(20);
    const probeCommitment = keccak256(toUtf8Bytes('commitment'));
    const targetServiceHash = keccak256(toUtf8Bytes('kimi-k2'));
    const txHash = await client.claimDelegateCredits(signer, {
      verifier,
      probeCommitment,
      buyer,
      agentId: 44325,
      serviceHash: targetServiceHash,
    });
    expect(txHash).toBe(FAKE_TX_HASH);
    expect(client.writes[0].method).toBe('claimDelegateCredits');
    expect(client.writes[0].calldata).toContain(probeCommitment.slice(2));
    expect(client.writes[0].calldata.toLowerCase()).toContain('22'.repeat(20));
    expect(client.writes[0].calldata.toLowerCase()).toContain('33'.repeat(20));
    expect(client.writes[0].calldata.toLowerCase()).toContain(targetServiceHash.slice(2).toLowerCase());
    expect(client.writes[0].calldata.toLowerCase()).toContain((44325).toString(16));
  });

  it('submitAttestation encodes the batchRoot-bearing 8-arg signature', async () => {
    const client = makeClient();
    const batchRoot = computeBatchRoot(buildFixtureRecords(2));
    const txHash = await client.submitAttestation(signer, {
      agentId: 44325,
      serviceHash: keccak256(toUtf8Bytes('kimi-k2')),
      verdict: 1,
      evidenceHash: keccak256(toUtf8Bytes('evidence')),
      probeCommitment: keccak256(toUtf8Bytes('commitment')),
      batchRoot,
      probeCount: 10,
      cohortSize: 3,
    });
    expect(txHash).toBe(FAKE_TX_HASH);
    expect(client.writes[0].method).toBe('submitAttestation');
    expect(client.writes[0].calldata).toContain(batchRoot.slice(2));
  });

  it('revealProbeSet passes the probe-set JSON as utf8 bytes plus the pack URI', async () => {
    const client = makeClient();
    const probeSetJson = JSON.stringify({ service: 'kimi-k2', probes: [], nonce: 'n-1' });
    const packUri = 'ipfs://bafkreiabc123/pack.json';
    const txHash = await client.revealProbeSet(signer, {
      probeCommitment: keccak256(toUtf8Bytes('commitment')),
      probeSetJson,
      packUri,
    });
    expect(txHash).toBe(FAKE_TX_HASH);
    expect(client.writes[0].method).toBe('revealProbeSet');
    expect(client.writes[0].calldata).toContain(Buffer.from(probeSetJson, 'utf8').toString('hex'));
    expect(client.writes[0].calldata).toContain(Buffer.from(packUri, 'utf8').toString('hex'));
  });

  it('revealProbeSet accepts an empty pack URI', async () => {
    const client = makeClient();
    const txHash = await client.revealProbeSet(signer, {
      probeCommitment: keccak256(toUtf8Bytes('commitment')),
      probeSetJson: '{}',
      packUri: '',
    });
    expect(txHash).toBe(FAKE_TX_HASH);
    expect(client.writes[0].method).toBe('revealProbeSet');
  });
});

describe('VerifierRegistryClient.getBatchAnchor', () => {
  const verifier = '0x' + '22'.repeat(20);
  const batchRoot = computeBatchRoot(buildFixtureRecords(2));

  function makeClientWithAnchor(raw: unknown): VerifierRegistryClient {
    const client = new VerifierRegistryClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: '0x' + '11'.repeat(20),
    });
    const stubContract = { getFunction: () => async () => raw };
    (client as unknown as { _contract: () => unknown })._contract = () => stubContract;
    return client;
  }

  it('decodes the packed anchor struct (named fields)', async () => {
    const client = makeClientWithAnchor({ anchoredAt: 1_700_000_001n, recordCount: 8n, probeCount: 24n });
    expect(await client.getBatchAnchor(verifier, batchRoot)).toEqual({
      anchoredAt: 1_700_000_001,
      recordCount: 8,
      probeCount: 24,
    });
    // batchAnchoredAt stays available as the anchoredAt convenience read.
    expect(await client.batchAnchoredAt(verifier, batchRoot)).toBe(1_700_000_001);
  });

  it('decodes a positional tuple result and reports 0 for a never-anchored root', async () => {
    const client = makeClientWithAnchor([0n, 0n, 0n]);
    expect(await client.getBatchAnchor(verifier, batchRoot)).toEqual({
      anchoredAt: 0,
      recordCount: 0,
      probeCount: 0,
    });
  });
});

describe('VerifierRegistryClient.parseResponseAuthPayload', () => {
  it('decodes the signed exchange timestamps', async () => {
    const client = new VerifierRegistryClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: '0x' + '11'.repeat(20),
    });
    const raw = {
      buyer: '0x' + '22'.repeat(20),
      advertisedServiceHash: '0x' + '33'.repeat(32),
      requestHash: '0x' + '44'.repeat(32),
      responseHash: '0x' + '55'.repeat(32),
      responseStartedAt: 1_752_444_000_000n,
      responseCompletedAt: 1_752_444_001_500n,
    };
    const stubContract = { getFunction: () => async () => raw };
    (client as unknown as { _contract: () => unknown })._contract = () => stubContract;

    await expect(client.parseResponseAuthPayload(new Uint8Array([1]))).resolves.toEqual(raw);
  });
});

describe('VerifierRegistryClient delegate-credit discovery', () => {
  const verifier = '0x' + '22'.repeat(20);
  const buyer = '0x' + '33'.repeat(20);
  const commitment = keccak256(toUtf8Bytes('commitment'));
  const svcHash = keccak256(toUtf8Bytes('kimi-k2'));

  it('queryDelegateCreditsAccrued decodes DelegateCreditsAccrued logs filtered by buyer', async () => {
    const client = new VerifierRegistryClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: '0x' + '11'.repeat(20),
    });
    let filterArgs: unknown[] = [];
    const stubContract = {
      filters: {
        DelegateCreditsAccrued: (...args: unknown[]) => {
          filterArgs = args;
          return { args };
        },
      },
      queryFilter: async () => [
        {
          args: { verifier, probeCommitment: commitment, buyer, agentId: 7n, serviceHash: svcHash, credits: 5n },
          blockNumber: 100,
        },
        { args: [verifier, commitment, buyer, 8n, svcHash, 3n], blockNumber: 101 },
      ],
    };
    (client as unknown as { _contract: () => unknown })._contract = () => stubContract;

    const accruals = await client.queryDelegateCreditsAccrued(buyer, 50);
    // Buyer is the third indexed topic (verifier=null, commitment=null, buyer).
    expect(filterArgs).toEqual([null, null, buyer]);
    expect(accruals).toEqual([
      { verifier, probeCommitment: commitment, buyer, agentId: 7, serviceHash: svcHash, credits: 5, blockNumber: 100 },
      { verifier, probeCommitment: commitment, buyer, agentId: 8, serviceHash: svcHash, credits: 3, blockNumber: 101 },
    ]);
  });

  it('commitmentDelegateAccrued/Claimed decode the uint32 accumulators', async () => {
    const client = new VerifierRegistryClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: '0x' + '11'.repeat(20),
    });
    const stubContract = {
      getFunction: (name: string) => async () => (name === 'commitmentDelegateAccrued' ? 9n : 4n),
    };
    (client as unknown as { _contract: () => unknown })._contract = () => stubContract;
    expect(await client.commitmentDelegateAccrued(verifier, commitment, svcHash, buyer)).toBe(9);
    expect(await client.commitmentDelegateClaimed(verifier, commitment, svcHash, buyer)).toBe(4);
  });
});

describe('VerifierRegistryClient.getMinDistinctDiffVerifiers', () => {
  /** Client whose chain walk is replaced by a controllable stub. */
  function makeClientWithWalk(walk: () => Promise<number | null>): { client: VerifierRegistryClient; walks: () => number } {
    let calls = 0;
    class WalkStubClient extends VerifierRegistryClient {
      protected override async _readMinDistinctDiffVerifiersFromChain(): Promise<number | null> {
        calls += 1;
        return walk();
      }
    }
    const client = new WalkStubClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: '0x' + '11'.repeat(20),
    });
    return { client, walks: () => calls };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the chain-read value and serves repeat calls from the TTL cache', async () => {
    const { client, walks } = makeClientWithWalk(async () => 3);
    expect(await client.getMinDistinctDiffVerifiers()).toBe(3);
    expect(await client.getMinDistinctDiffVerifiers()).toBe(3);
    expect(walks()).toBe(1);
  });

  it('falls back to the offline default (2) on a chain-walk failure — and caches the failure for one TTL', async () => {
    const { client, walks } = makeClientWithWalk(async () => { throw new Error('rpc down'); });
    expect(await client.getMinDistinctDiffVerifiers()).toBe(2);
    expect(await client.getMinDistinctDiffVerifiers()).toBe(2);
    expect(walks()).toBe(1);
  });

  it('falls back to the offline default when a resolution hop is unset (walk yields null)', async () => {
    const { client } = makeClientWithWalk(async () => null);
    expect(await client.getMinDistinctDiffVerifiers()).toBe(2);
  });

  it('re-reads the chain after the TTL elapses, picking up a retuned policy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    let value = 2;
    const { client, walks } = makeClientWithWalk(async () => value);
    expect(await client.getMinDistinctDiffVerifiers()).toBe(2);

    // Owner retunes the policy; within the TTL the cached value still serves.
    value = 4;
    vi.setSystemTime(1_700_000_000_000 + 9 * 60_000);
    expect(await client.getMinDistinctDiffVerifiers()).toBe(2);
    expect(walks()).toBe(1);

    // Past the 10-minute TTL the walk re-runs and the new value lands.
    vi.setSystemTime(1_700_000_000_000 + 10 * 60_000 + 1);
    expect(await client.getMinDistinctDiffVerifiers()).toBe(4);
    expect(walks()).toBe(2);
  });
});

// =========================================================================
// Transparent-audit chain fetchers (moved from the CLI's audit verify)
// =========================================================================

const FETCH_IFACE = new Interface([
  'function anchorExchangeBatch(bytes32 probeCommitment, (uint256 agentId, bytes32 requestHash, bytes32 responseHash, bytes responseAuthSig)[] records, bytes[] signingPayloads, uint32[] recordProbeCounts) returns (bytes32)',
  'function revealProbeSet(bytes32 probeCommitment, bytes probeSetJson, string packUri)',
  'event ExchangeBatchAnchored(address indexed verifier, bytes32 indexed probeCommitment, bytes32 indexed batchRoot, uint32 recordCount, uint32 probeCount)',
]);
const ANCHOR_TOPIC = FETCH_IFACE.getEvent('ExchangeBatchAnchored')!.topicHash;

const COMMITMENT = '0x' + 'ab'.repeat(32);
const BATCH_ROOT = '0x' + 'cd'.repeat(32);
const VERIFIER_ADDR = '0x' + '11'.repeat(20);
const REGISTRY_ADDR = '0x' + '22'.repeat(20);
const ANCHOR_TX = '0x' + '33'.repeat(32);
const REVEAL_TX = '0x' + '44'.repeat(32);
const PROBE_SET_JSON = '{"nonce":"ff","probes":[]}';
const PACK_URI = 'https://packs.example.com/audits/0xabc.json';

describe('decodeAnchorCalldata / decodeRevealCalldata', () => {
  it('decodeAnchorCalldata round-trips the commitment and every record field', () => {
    const records = [0, 1, 2].map((i) => [
      BigInt(i + 7),
      keccak256(toUtf8Bytes(`req-${i}`)),
      keccak256(toUtf8Bytes(`res-${i}`)),
      '0x' + `${i}1`.repeat(65),
    ]);
    const signingPayloads = records.map((_r, i) => toUtf8Bytes(`payload-${i}`));
    const recordProbeCounts = records.map(() => 1);
    const data = FETCH_IFACE.encodeFunctionData('anchorExchangeBatch', [COMMITMENT, records, signingPayloads, recordProbeCounts]);

    const decoded = decodeAnchorCalldata(data);
    expect(decoded.probeCommitment).toBe(COMMITMENT);
    expect(decoded.records).toHaveLength(3);
    decoded.records.forEach((record, i) => {
      expect(record.agentId).toBe(BigInt(i + 7));
      expect(record.requestHash).toBe(records[i]![1]);
      expect(record.responseHash).toBe(records[i]![2]);
      expect(record.responseAuthSig).toBe(records[i]![3]);
    });
  });

  it('decodeAnchorCalldata rejects foreign calldata', () => {
    const data = FETCH_IFACE.encodeFunctionData('revealProbeSet', [COMMITMENT, toUtf8Bytes('{}'), '']);
    expect(() => decodeAnchorCalldata(data)).toThrow(/not an anchorExchangeBatch/);
  });

  it('decodeRevealCalldata recovers the probe-set JSON and pack URI', () => {
    const probeSetJson = '{"nonce":"ff","probes":[],"service":"kimi-k2"}';
    const data = FETCH_IFACE.encodeFunctionData('revealProbeSet', [COMMITMENT, toUtf8Bytes(probeSetJson), PACK_URI]);
    const decoded = decodeRevealCalldata(data);
    expect(decoded.probeCommitment).toBe(COMMITMENT);
    expect(decoded.probeSetJson).toBe(probeSetJson);
    expect(decoded.packUri).toBe(PACK_URI);
  });

  it('decodeRevealCalldata rejects foreign calldata', () => {
    const data = FETCH_IFACE.encodeFunctionData('anchorExchangeBatch', [COMMITMENT, [], [], []]);
    expect(() => decodeRevealCalldata(data)).toThrow(/not a revealProbeSet/);
  });
});

describe('VerifierRegistryClient.fetchAnchorAndReveal', () => {
  interface QueryCall { event: string; fromBlock: number | string }

  /**
   * Client whose provider (txs/receipt) and contract (event scans) are canned.
   * Mirrors the RPC shapes the fetchers consume: getTransaction/-Receipt for
   * the --tx path, filters + queryFilter for the event-scan paths.
   */
  function makeFetchClient(opts: {
    anchorBlock: number
    anchorTo?: string
    anchorLogAddress?: string
    onQuery: (call: QueryCall) => Array<{ transactionHash: string; blockNumber: number; topics: string[] }>
  }): { client: VerifierRegistryClient; queryCalls: QueryCall[] } {
    const anchorData = FETCH_IFACE.encodeFunctionData('anchorExchangeBatch', [COMMITMENT, [], [], []]);
    const revealData = FETCH_IFACE.encodeFunctionData('revealProbeSet', [COMMITMENT, toUtf8Bytes(PROBE_SET_JSON), PACK_URI]);
    const txs: Record<string, { data: string; from: string; to: string }> = {
      [ANCHOR_TX]: { data: anchorData, from: VERIFIER_ADDR, to: opts.anchorTo ?? REGISTRY_ADDR },
      [REVEAL_TX]: { data: revealData, from: VERIFIER_ADDR, to: REGISTRY_ADDR },
    };
    const queryCalls: QueryCall[] = [];
    const stubProvider = {
      async getTransaction(hash: string) {
        return txs[hash] ?? null;
      },
      async getTransactionReceipt(hash: string) {
        if (hash !== ANCHOR_TX) return null;
        return {
          blockNumber: opts.anchorBlock,
          logs: [{
            address: opts.anchorLogAddress ?? REGISTRY_ADDR,
            topics: [ANCHOR_TOPIC, zeroPadValue(VERIFIER_ADDR, 32), COMMITMENT, BATCH_ROOT],
          }],
        };
      },
    };
    const stubContract = {
      filters: {
        ExchangeBatchAnchored: () => ({ event: 'ExchangeBatchAnchored' }),
        ProbeSetRevealed: () => ({ event: 'ProbeSetRevealed' }),
      },
      queryFilter: async (filter: { event: string }, fromBlock: number | string) => {
        const call = { event: filter.event, fromBlock };
        queryCalls.push(call);
        return opts.onQuery(call);
      },
    };
    const client = new VerifierRegistryClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: REGISTRY_ADDR,
    });
    (client as unknown as { _provider: unknown })._provider = stubProvider;
    (client as unknown as { _contract: () => unknown })._contract = () => stubContract;
    return { client, queryCalls };
  }

  it('tx-hash path bounds the reveal scan to the anchor block (never fromBlock 0)', async () => {
    const { client, queryCalls } = makeFetchClient({
      anchorBlock: 1234,
      onQuery: () => [{ transactionHash: REVEAL_TX, blockNumber: 1240, topics: [] }],
    });

    const { anchor, reveal } = await client.fetchAnchorAndReveal({ txHash: ANCHOR_TX, fromBlock: 0 });

    expect(anchor.blockNumber).toBe(1234);
    expect(anchor.batchRoot).toBe(BATCH_ROOT);
    // The verifier comes from the indexed event topic, not tx.from.
    expect(anchor.verifier.toLowerCase()).toBe(VERIFIER_ADDR.toLowerCase());
    expect(reveal.probeSetJson).toBe(PROBE_SET_JSON);
    expect(reveal.packUri).toBe(PACK_URI);
    // Exactly one event scan (the reveal) — the anchor comes from the receipt
    // — and it starts at the anchor block, not genesis.
    expect(queryCalls).toEqual([{ event: 'ProbeSetRevealed', fromBlock: 1234 }]);
  });

  it('tx-hash path rejects an anchor call sent to a different contract', async () => {
    const { client } = makeFetchClient({
      anchorBlock: 1234,
      anchorTo: '0x' + '99'.repeat(20),
      onQuery: () => [],
    });

    await expect(client.fetchAnchorAndReveal({ txHash: ANCHOR_TX, fromBlock: 0 }))
      .rejects.toThrow(/was not sent to registry/);
  });

  it('tx-hash path rejects a matching event emitted by a different contract', async () => {
    const { client } = makeFetchClient({
      anchorBlock: 1234,
      anchorLogAddress: '0x' + '99'.repeat(20),
      onQuery: () => [],
    });

    await expect(client.fetchAnchorAndReveal({ txHash: ANCHOR_TX, fromBlock: 0 }))
      .rejects.toThrow(/emitted no ExchangeBatchAnchored event/);
  });

  it('commitment path scans the anchor from fromBlock and the reveal from the anchor block', async () => {
    const { client, queryCalls } = makeFetchClient({
      anchorBlock: 777,
      onQuery: (call) =>
        call.event === 'ExchangeBatchAnchored'
          ? [{
              transactionHash: ANCHOR_TX,
              blockNumber: 777,
              topics: [ANCHOR_TOPIC, zeroPadValue(VERIFIER_ADDR, 32), COMMITMENT, BATCH_ROOT],
            }]
          : [{ transactionHash: REVEAL_TX, blockNumber: 800, topics: [] }],
    });

    const { anchor, reveal } = await client.fetchAnchorAndReveal({
      verifier: VERIFIER_ADDR,
      commitment: COMMITMENT,
      fromBlock: 500,
    });

    expect(anchor.blockNumber).toBe(777);
    expect(reveal.probeSetJson).toBe(PROBE_SET_JSON);
    expect(queryCalls).toEqual([
      { event: 'ExchangeBatchAnchored', fromBlock: 500 },
      { event: 'ProbeSetRevealed', fromBlock: 777 },
    ]);
  });

  it('commitment path reports a missing anchor with the scan bounds', async () => {
    const { client } = makeFetchClient({ anchorBlock: 0, onQuery: () => [] });
    await expect(client.fetchAnchorAndReveal({ verifier: VERIFIER_ADDR, commitment: COMMITMENT, fromBlock: 500 }))
      .rejects.toThrow(/no ExchangeBatchAnchored event .*\(scanned from block 500\)/);
  });
});

describe('VerifierRegistryClient.fetchMatchingAttestations', () => {
  it('finds the historical audit, scans sellers in parallel, and tolerates one seller failing', async () => {
    const client = new VerifierRegistryClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: REGISTRY_ADDR,
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const filterCalls: Array<[number, string, string]> = [];
    const stubContract = {
      filters: {
        AttestationSubmitted: (agentId: number, svcHash: string, verifier: string) => {
          filterCalls.push([agentId, svcHash, verifier]);
          return { agentId };
        },
      },
      queryFilter: async (filter: { agentId: number }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        if (filter.agentId === 8) throw new Error('rpc boom');
        if (filter.agentId === 9) return [];
        return [
          // Historical (matching) attestation first, superseded one after.
          { args: { verdict: 2n, probeCommitment: COMMITMENT, evidenceHash: BATCH_ROOT, batchRoot: BATCH_ROOT } },
          { args: { verdict: 1n, probeCommitment: '0x' + 'ee'.repeat(32), evidenceHash: BATCH_ROOT, batchRoot: BATCH_ROOT } },
        ];
      },
    };
    (client as unknown as { _contract: () => unknown })._contract = () => stubContract;

    const errors: Array<[number, string]> = [];
    const attestations = await client.fetchMatchingAttestations({
      verifier: VERIFIER_ADDR,
      sellers: [{ agentId: 7 }, { agentId: 8 }, { agentId: 9 }],
      service: 'kimi-k2',
      probeCommitment: COMMITMENT,
      batchRoot: BATCH_ROOT,
      evidenceHash: BATCH_ROOT,
      fromBlock: 500,
    }, (agentId, err) => errors.push([agentId, err.message]));

    expect(maxInFlight).toBe(3);
    expect(errors).toEqual([[8, 'rpc boom']]);
    expect(attestations.size).toBe(1);
    expect(attestations.get(7)).toEqual({
      verdict: 2,
      probeCommitment: COMMITMENT,
      evidenceHash: BATCH_ROOT,
      batchRoot: BATCH_ROOT,
    });
    // The scan is topic-filtered per (agentId, normalized service hash, verifier).
    expect(filterCalls).toContainEqual([7, serviceHash('kimi-k2'), VERIFIER_ADDR]);
  });
});

describe('VerifierRegistryClient.getRevealedPackUri', () => {
  const verifier = '0x' + '22'.repeat(20);
  const commitment = keccak256(toUtf8Bytes('commitment'));
  const packUri = 'ipfs://bafkreiabc123/pack.json';

  function makeClientWithLogs(events: Array<{ packUri: string }>): VerifierRegistryClient {
    const client = new VerifierRegistryClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: '0x' + '11'.repeat(20),
    });
    // Stub the ethers Contract the read helper builds: intercept
    // filters.ProbeSetRevealed + queryFilter with synthetic decoded logs.
    const stubContract = {
      filters: { ProbeSetRevealed: (v: string, c: string) => ({ v, c }) },
      queryFilter: async () => events.map((e) => ({ args: { packUri: e.packUri } })),
    };
    (client as unknown as { _contract: () => unknown })._contract = () => stubContract;
    return client;
  }

  it('returns the pack URI from the latest matching ProbeSetRevealed event', async () => {
    const client = makeClientWithLogs([{ packUri: 'ipfs://old' }, { packUri }]);
    expect(await client.getRevealedPackUri(verifier, commitment, 100)).toBe(packUri);
  });

  it('returns an empty string when the reveal carried no pack URI', async () => {
    const client = makeClientWithLogs([{ packUri: '' }]);
    expect(await client.getRevealedPackUri(verifier, commitment)).toBe('');
  });

  it('returns null when no matching reveal is found', async () => {
    const client = makeClientWithLogs([]);
    expect(await client.getRevealedPackUri(verifier, commitment)).toBeNull();
  });
});

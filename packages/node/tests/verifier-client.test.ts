import { Interface, Wallet, keccak256, toUtf8Bytes, type AbstractSigner, type InterfaceAbi } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerifierRegistryClient } from '../src/payments/evm/verifier-client.js';
import { buildFixtureRecords, computeBatchRoot } from '../src/verification/exchange-batch.js';

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

  it('claimDelegateCredits encodes the (verifier, probeCommitment, buyer) triple', async () => {
    const client = makeClient();
    const verifier = '0x' + '22'.repeat(20);
    const buyer = '0x' + '33'.repeat(20);
    const probeCommitment = keccak256(toUtf8Bytes('commitment'));
    const txHash = await client.claimDelegateCredits(signer, { verifier, probeCommitment, buyer });
    expect(txHash).toBe(FAKE_TX_HASH);
    expect(client.writes[0].method).toBe('claimDelegateCredits');
    expect(client.writes[0].calldata).toContain(probeCommitment.slice(2));
    expect(client.writes[0].calldata.toLowerCase()).toContain('22'.repeat(20));
    expect(client.writes[0].calldata.toLowerCase()).toContain('33'.repeat(20));
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
  const commitment = keccak256(toUtf8Bytes('commitment'));
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
    const client = makeClientWithAnchor({ anchoredAt: 1_700_000_001n, recordCount: 8n, probeCount: 24n, commitment });
    expect(await client.getBatchAnchor(verifier, batchRoot)).toEqual({
      anchoredAt: 1_700_000_001,
      recordCount: 8,
      probeCount: 24,
      commitment,
    });
    // batchAnchoredAt stays available as the anchoredAt convenience read.
    expect(await client.batchAnchoredAt(verifier, batchRoot)).toBe(1_700_000_001);
  });

  it('decodes a positional tuple result and reports 0 for a never-anchored root', async () => {
    const zero = '0x' + '00'.repeat(32);
    const client = makeClientWithAnchor([0n, 0n, 0n, zero]);
    expect(await client.getBatchAnchor(verifier, batchRoot)).toEqual({
      anchoredAt: 0,
      recordCount: 0,
      probeCount: 0,
      commitment: zero,
    });
  });
});

describe('VerifierRegistryClient delegate-credit discovery', () => {
  const verifier = '0x' + '22'.repeat(20);
  const buyer = '0x' + '33'.repeat(20);
  const commitment = keccak256(toUtf8Bytes('commitment'));

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
        { args: { verifier, probeCommitment: commitment, buyer, credits: 5n }, blockNumber: 100 },
        { args: [verifier, commitment, buyer, 3n], blockNumber: 101 },
      ],
    };
    (client as unknown as { _contract: () => unknown })._contract = () => stubContract;

    const accruals = await client.queryDelegateCreditsAccrued(buyer, 50);
    // Buyer is the third indexed topic (verifier=null, commitment=null, buyer).
    expect(filterArgs).toEqual([null, null, buyer]);
    expect(accruals).toEqual([
      { verifier, probeCommitment: commitment, buyer, credits: 5, blockNumber: 100 },
      { verifier, probeCommitment: commitment, buyer, credits: 3, blockNumber: 101 },
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
    expect(await client.commitmentDelegateAccrued(verifier, commitment, buyer)).toBe(9);
    expect(await client.commitmentDelegateClaimed(verifier, commitment, buyer)).toBe(4);
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

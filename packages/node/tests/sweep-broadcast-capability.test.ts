import { describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { ConnectionState } from '../src/types/connection.js';
import {
  CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1,
  type SweepRequestPayload,
} from '../src/types/protocol.js';
import { toPeerId } from '../src/types/peer.js';

function makePayload(): SweepRequestPayload {
  return {
    version: 1,
    evmChainId: 31337,
    relayAddress: '0x' + '8a'.repeat(20),
    from: '0x' + '11'.repeat(20),
    amount: '5000000',
    validAfter: 0,
    validBefore: 2_000_000_000,
    nonce: '0x' + 'aa'.repeat(32),
    sig3009: '0x' + 'ab'.repeat(65),
  };
}

describe('AntseedNode sweep broadcast capabilities', () => {
  it('only sends sweep requests to connected peers that advertise sweep relaying', () => {
    const relayPeer = toPeerId('a'.repeat(40));
    const nonRelayPeer = toPeerId('b'.repeat(40));
    const node = new AntseedNode({ role: 'buyer' });
    const sendSweepRequest = vi.fn();

    const connections = new Map([
      [relayPeer, { state: ConnectionState.Open }],
      [nonRelayPeer, { state: ConnectionState.Open }],
    ]);

    (node as unknown as {
      _connectionManager: { getConnection: (peerId: string) => { state: ConnectionState } | undefined };
      _muxes: Map<string, unknown>;
      _peerCapabilities: Map<string, Set<string>>;
      _getOrCreateSweepMux: () => { sendSweepRequest: typeof sendSweepRequest };
    })._connectionManager = {
      getConnection: (peerId: string) => connections.get(peerId),
    };
    (node as unknown as { _muxes: Map<string, unknown> })._muxes = new Map([
      [relayPeer, {}],
      [nonRelayPeer, {}],
    ]);
    (node as unknown as { _peerCapabilities: Map<string, Set<string>> })._peerCapabilities = new Map([
      [relayPeer, new Set([CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1])],
      [nonRelayPeer, new Set()],
    ]);
    (node as unknown as {
      _getOrCreateSweepMux: () => { sendSweepRequest: typeof sendSweepRequest };
    })._getOrCreateSweepMux = () => ({ sendSweepRequest });

    expect(node.broadcastSweepRequest(makePayload())).toBe(1);
    expect(sendSweepRequest).toHaveBeenCalledTimes(1);
  });
});

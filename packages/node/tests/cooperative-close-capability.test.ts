import { describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { ConnectionState } from '../src/types/connection.js';
import {
  CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1,
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
} from '../src/types/protocol.js';
import { toPeerId } from '../src/types/peer.js';

const SELLER = toPeerId('a'.repeat(40));

/**
 * Wire up just enough of a started buyer node for requestChannelClose:
 * a live connection to SELLER, a negotiator, and a capability set.
 */
function makeNode(capabilities: Set<string> | undefined) {
  const node = new AntseedNode({ role: 'buyer' });
  const requestChannelClose = vi.fn().mockResolvedValue({
    version: 1, channelId: '0x' + 'cd'.repeat(32), status: 'closed', txHash: '0xtx', finalAmount: '1',
  });

  const internals = node as unknown as {
    _connectionManager: unknown;
    _buyerNegotiator: unknown;
    _peerCapabilities: Map<string, Set<string>>;
  };
  internals._connectionManager = {
    getConnection: (peerId: string) =>
      peerId === SELLER ? { state: ConnectionState.Open } : undefined,
  };
  internals._buyerNegotiator = { requestChannelClose };
  internals._peerCapabilities = capabilities ? new Map([[SELLER, capabilities]]) : new Map();

  return { node, requestChannelClose };
}

describe('AntseedNode.requestChannelClose capability gating', () => {
  it('sends the request when the seller advertises cooperative close', async () => {
    const { node, requestChannelClose } = makeNode(new Set([
      CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
      CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1,
    ]));

    await expect(node.requestChannelClose(SELLER)).resolves.toMatchObject({ status: 'closed' });
    expect(requestChannelClose).toHaveBeenCalledOnce();
  });

  it('fails fast instead of waiting out the response timeout on a seller that lacks it', async () => {
    // An older seller still advertises response-auth, so the set is non-empty —
    // positive evidence that it speaks capabilities but not this one.
    const { node, requestChannelClose } = makeNode(new Set([CONNECTION_CAPABILITY_RESPONSE_AUTH_V1]));

    await expect(node.requestChannelClose(SELLER)).rejects.toThrow(/does not support cooperative close/);
    expect(requestChannelClose).not.toHaveBeenCalled();
  });

  it('attempts anyway when capabilities are unknown, rather than blocking a close that would work', async () => {
    // Partial discovery data must not be read as "unsupported" — that would be
    // a false negative on a seller that does support it.
    for (const caps of [undefined, new Set<string>()]) {
      const { node, requestChannelClose } = makeNode(caps);
      await expect(node.requestChannelClose(SELLER)).resolves.toMatchObject({ status: 'closed' });
      expect(requestChannelClose).toHaveBeenCalledOnce();
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { fixedFeeOffering, FIXED_FEE_CAPABILITY } from '@antseed/protocol/fixed-fee';
import type { PeerInfo } from '../src/types/peer.js';

describe('response fees through normal SDK requests', () => {
  const offer = { provider: 'summarizer', service: 'summary', contract: 'summary-v1', priceMicroUsdc: '1000' };
  function setup() {
    const peer = { peerId: 'a'.repeat(40), metadata: { peerId: 'a'.repeat(40), capabilities: [FIXED_FEE_CAPABILITY], offerings: [fixedFeeOffering(offer)] } } as PeerInfo;
    const verifyMetadataSignature = vi.fn(async () => true);
    const sendRequest = vi.fn(async () => ({ statusCode: 200 }));
    const node = { _peerLookup: { verifyMetadataSignature }, _buyerHandler: { sendRequest } } as unknown as AntseedNode;
    const send = (maxFeeMicroUsdc = '1000') => AntseedNode.prototype.sendRequest.call(node, peer, {
      requestId: 'summary-1', method: 'POST', path: '/summary', headers: {}, body: new TextEncoder().encode('{}'),
    }, { fixedFee: offer, maxFeeMicroUsdc, acceptResponse: () => true });
    return { peer, send, verifyMetadataSignature, sendRequest };
  }
  it('verifies the signed offer and forwards its exact fee and contract', async () => {
    const harness = setup();
    await harness.send();
    expect(harness.verifyMetadataSignature).toHaveBeenCalledWith(harness.peer.metadata);
    expect(harness.sendRequest).toHaveBeenCalledWith(harness.peer, expect.objectContaining({
      path: '/summary', method: 'POST',
    }), undefined, expect.objectContaining({ fixedFee: offer }));
  });
  it('rejects missing capability, invalid signature, identity mismatch, and excessive fee before dispatch', async () => {
    const expensive = setup();
    await expect(expensive.send('999')).rejects.toThrow('buyer limit');
    expect(expensive.sendRequest).not.toHaveBeenCalled();
    const unsigned = setup();
    unsigned.verifyMetadataSignature.mockResolvedValue(false);
    await expect(unsigned.send()).rejects.toThrow('Verified');
    expect(unsigned.sendRequest).not.toHaveBeenCalled();
    const legacy = setup();
    legacy.peer.metadata!.capabilities = [];
    await expect(legacy.send()).rejects.toThrow('Verified');
    expect(legacy.sendRequest).not.toHaveBeenCalled();
    const mismatched = setup();
    mismatched.peer.metadata!.peerId = 'b'.repeat(40);
    await expect(mismatched.send()).rejects.toThrow('Verified');
    expect(mismatched.sendRequest).not.toHaveBeenCalled();
  });
});

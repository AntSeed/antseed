import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPeerPayCheckout } from './peer-pay.js';

const ADDRESS = '0x0000000000000000000000000000000000000001';
const INPUT = {
  endpoint: 'https://antseed-checkout.pay.zkp2p.xyz/api/checkout',
  address: ADDRESS,
  amount: '25',
};

describe('Peer Pay checkout', () => {
  it('creates a checkout without exposing a merchant key', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({
        checkoutUrl: 'https://pay.peer.xyz/?order=order_123&token=order_token',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };

    const checkoutUrl = await createPeerPayCheckout(INPUT, fetcher);

    assert.equal(checkoutUrl, 'https://pay.peer.xyz/?order=order_123&token=order_token');
    assert.equal(request?.url, INPUT.endpoint);
    assert.equal(request?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(request?.init?.body)), {
      address: ADDRESS,
      amount: '25',
    });
    assert.equal((request?.init?.headers as Record<string, string>)['X-API-Key'], undefined);
  });

  it('returns the server error without opening a checkout', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      error: {
        code: 'SERVICE_NOT_CONFIGURED',
        message: 'Checkout service is not configured',
      },
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });

    await assert.rejects(
      createPeerPayCheckout(INPUT, fetcher),
      /Checkout service is not configured/,
    );
  });

  it('rejects an insecure API endpoint before sending the request', async () => {
    let fetched = false;

    await assert.rejects(
      createPeerPayCheckout({
        ...INPUT,
        endpoint: 'http://antseed-checkout.pay.zkp2p.xyz/api/checkout',
      }, async () => {
        fetched = true;
        return new Response();
      }),
      /Peer Pay endpoint URL must be https/,
    );
    assert.equal(fetched, false);
  });

  it('rejects an insecure checkout URL', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      checkoutUrl: 'http://pay.peer.xyz/?order=order_123&token=order_token',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });

    await assert.rejects(
      createPeerPayCheckout(INPUT, fetcher),
      /Peer Pay checkout URL must be https/,
    );
  });
});

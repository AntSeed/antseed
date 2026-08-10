import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enrichChannelSellerDisplayNames,
  normalizePaymentChannelSummary,
  requestCooperativeChannelCloseAtPort,
  runInBatches,
} from './buyer-channel-control.js';

function closeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('normalizePaymentChannelSummary defaults missing cooperative-close support to false', () => {
  const unsupported = normalizePaymentChannelSummary({ sessionId: 'channel-1', peerId: 'peer-1' });
  const supported = normalizePaymentChannelSummary({
    sessionId: 'channel-2',
    peerId: 'peer-2',
    cooperativeCloseSupported: true,
  });

  assert.equal(unsupported?.cooperativeCloseSupported, false);
  assert.equal(supported?.cooperativeCloseSupported, true);
});

test('enrichChannelSellerDisplayNames resolves names and preserves null fallbacks', () => {
  const named = normalizePaymentChannelSummary({ sessionId: 'channel-1', peerId: 'peer-1' });
  const unnamed = normalizePaymentChannelSummary({ sessionId: 'channel-2', peerId: 'peer-2' });
  assert.ok(named);
  assert.ok(unnamed);

  const channels = enrichChannelSellerDisplayNames(
    [named, unnamed],
    (peerId) => peerId === 'peer-1' ? '  Seller One  ' : null,
  );

  assert.equal(channels[0]?.sellerDisplayName, 'Seller One');
  assert.equal(channels[1]?.sellerDisplayName, null);
});

test('runInBatches processes active-looking channels beyond the first batch', async () => {
  const processed: number[] = [];
  await runInBatches(Array.from({ length: 14 }, (_, index) => index), 12, async (index) => {
    processed.push(index);
  });

  assert.deepEqual(processed.sort((left, right) => left - right), Array.from({ length: 14 }, (_, index) => index));
});

test('requestCooperativeChannelCloseAtPort returns a closed result', async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { peerId: 'peer-1', includeAuth: true });
    return closeResponse({
      ok: true,
      result: { version: 1, channelId: 'channel-1', status: 'closed', txHash: '0xtx' },
    });
  };

  const result = await requestCooperativeChannelCloseAtPort(8123, 'peer-1', { fetchImpl });
  assert.equal(result.status, 'closed');
  assert.equal(result.txHash, '0xtx');
});

test('requestCooperativeChannelCloseAtPort preserves structured rejection results', async () => {
  const fetchImpl: typeof fetch = async () => closeResponse({
    ok: true,
    result: { version: 1, channelId: 'channel-1', status: 'rejected', code: 'busy' },
  });

  const result = await requestCooperativeChannelCloseAtPort(8123, 'peer-1', { fetchImpl });
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'busy');
});

test('requestCooperativeChannelCloseAtPort reports HTTP errors', async () => {
  const fetchImpl: typeof fetch = async () => closeResponse({ ok: false, error: 'seller offline' }, 502);

  await assert.rejects(
    requestCooperativeChannelCloseAtPort(8123, 'peer-1', { fetchImpl }),
    /seller offline/,
  );
});

test('requestCooperativeChannelCloseAtPort rejects malformed success responses', async () => {
  const fetchImpl: typeof fetch = async () => closeResponse({ ok: true, result: { status: 'closed' } });

  await assert.rejects(
    requestCooperativeChannelCloseAtPort(8123, 'peer-1', { fetchImpl }),
    /invalid cooperative-close response/,
  );
});

test('requestCooperativeChannelCloseAtPort propagates timeouts', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };

  await assert.rejects(
    requestCooperativeChannelCloseAtPort(8123, 'peer-1', { fetchImpl, timeoutMs: 1 }),
    /timeout/i,
  );
});

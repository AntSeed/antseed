import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BASE_DEPOSITS_ADDRESS, BASE_RPC_URL, BASE_USDC_ADDRESS, createBlockscoutClient, DEPOSITED_EVENT_TOPIC } from "./data-sources.mjs";

test("Blockscout retries throttling, attributes depositFor funding, and reuses cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-wash-blockscout-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    assert.match(String(url), /\/api\/v2\/addresses\/0x0f7a3a8f/);
    return Response.json({
      items: [{
        status: "ok",
        hash: tx(1),
        from: { hash: address(9) },
        timestamp: "2026-01-01T00:00:00.000Z",
        decoded_input: {
          method_call: "depositFor(address buyer, uint256 amount)",
          parameters: [
            { name: "buyer", value: address(10) },
            { name: "amount", value: "10000000" },
          ],
        },
      }],
      next_page_params: null,
    });
  };

  try {
    const client = createBlockscoutClient({
      baseUrl: "https://base.blockscout.test",
      cacheDirectory: directory,
      requestTimeoutMs: 1_000,
      maxRetries: 1,
      toTimestamp: Math.floor(Date.now() / 1000) - 1,
    });
    const first = await client.fetchProtocolDeposits();
    assert.equal(first.complete, true);
    assert.equal(first.records.length, 1);
    assert.equal(first.records[0].funder, address(9));
    assert.equal(first.records[0].buyer, address(10));
    const second = await client.fetchProtocolDeposits();
    assert.equal(second.records.length, 1);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("targeted deposit tracing filters logs by buyer and resolves the transaction sender", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-wash-deposit-logs-"));
  const originalFetch = globalThis.fetch;
  const buyer = address(10);
  const funder = address(11);
  const progress = [];
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (String(url).includes("/logs?")) {
      return Response.json({
        items: [{
          block_timestamp: "2026-01-01T00:00:00.000Z",
          transaction_hash: tx(7),
          topics: [DEPOSITED_EVENT_TOPIC],
          decoded: {
            parameters: [
              { name: "buyer", value: buyer },
              { name: "amount", value: "25000000" },
            ],
          },
        }],
        next_page_params: null,
      });
    }
    assert.equal(String(url), BASE_RPC_URL);
    return Response.json([{ id: 1, result: { from: funder } }]);
  };

  try {
    const client = createBlockscoutClient({
      baseUrl: "https://base.blockscout.test",
      cacheDirectory: directory,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      toTimestamp: Math.floor(Date.now() / 1000) - 1,
    });
    const result = await client.fetchProtocolDeposits({
      buyers: [buyer],
      onProgress: (entry) => progress.push(entry),
    });
    assert.equal(result.complete, true);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].funder, funder);
    assert.equal(result.records[0].amountRaw, "25000000");
    assert.equal(calls, 2);
    assert.deepEqual(progress, [
      { stage: "buyer-logs", completed: 1, total: 1 },
      { stage: "transaction-senders", completed: 1, total: 1 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("targeted deposit tracing uses the configured RPC URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-wash-custom-rpc-"));
  const originalFetch = globalThis.fetch;
  const buyer = address(12);
  const funder = address(13);
  const rpcUrl = "https://base-mainnet.example.test/v2/key";
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).includes("/logs?")) {
      return Response.json({
        items: [{
          block_timestamp: "2026-01-01T00:00:00.000Z",
          transaction_hash: tx(8),
          topics: [DEPOSITED_EVENT_TOPIC],
          decoded: {
            parameters: [
              { name: "buyer", value: buyer },
              { name: "amount", value: "5000000" },
            ],
          },
        }],
        next_page_params: null,
      });
    }
    assert.equal(String(url), rpcUrl);
    return Response.json([{ id: 1, result: { from: funder } }]);
  };

  try {
    const client = createBlockscoutClient({
      baseUrl: "https://base.blockscout.test",
      rpcUrl,
      cacheDirectory: directory,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      toTimestamp: Math.floor(Date.now() / 1000) - 1,
    });
    const result = await client.fetchProtocolDeposits({ buyers: [buyer] });
    assert.equal(result.complete, true);
    assert.equal(result.records[0].funder, funder);
    assert.deepEqual(requestedUrls, [
      `https://base.blockscout.test/api/v2/addresses/${BASE_DEPOSITS_ADDRESS}/logs?topic=0x${buyer.slice(2).padStart(64, "0")}`,
      rpcUrl,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC transfer tracing returns raw USDC transfers and native funding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-wash-rpc-trace-"));
  const originalFetch = globalThis.fetch;
  const traced = address(20);
  const inboundFunder = address(21);
  const outboundRecipient = address(22);
  const nativeFunder = address(23);
  const rpcUrl = "https://base-mainnet.example.test/v2/key";
  const requests = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), rpcUrl);
    const request = JSON.parse(init.body);
    requests.push(request);
    const parameters = request.params[0];
    if (parameters.category.includes("external")) {
      assert.equal(parameters.order, "asc");
      assert.equal(parameters.maxCount, "0x1");
      return Response.json({ jsonrpc: "2.0", id: 1, result: { transfers: [{
        from: nativeFunder,
        to: traced,
        hash: tx(12),
        rawContract: { value: "0xde0b6b3a7640000" },
        metadata: { blockTimestamp: "2026-01-01T00:00:00.000Z" },
      }] } });
    }
    const inbound = parameters.toAddress === traced;
    return Response.json({ jsonrpc: "2.0", id: 1, result: { transfers: [{
      from: inbound ? inboundFunder : traced,
      to: inbound ? traced : outboundRecipient,
      hash: inbound ? tx(10) : tx(11),
      rawContract: { value: inbound ? "0x989680" : "0x4c4b40", address: BASE_USDC_ADDRESS },
      metadata: { blockTimestamp: "2026-01-01T00:00:00.000Z" },
      uniqueId: `${inbound ? tx(10) : tx(11)}:log:${inbound ? 5 : 6}`,
    }] } });
  };

  try {
    const client = createBlockscoutClient({
      baseUrl: "https://base.blockscout.test",
      rpcUrl,
      rpcTransferTracing: true,
      cacheDirectory: directory,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      toTimestamp: Math.floor(Date.now() / 1000) - 1,
    });
    const trace = await client.traceAddress(traced, { includeNative: true });
    assert.equal(trace.complete, true);
    assert.deepEqual(trace.inboundUsdc, [{
      from: inboundFunder,
      to: traced,
      amountRaw: "10000000",
      timestamp: 1767225600,
      txHash: tx(10),
      logIndex: "5",
    }]);
    assert.deepEqual(trace.outboundUsdc, [{
      from: traced,
      to: outboundRecipient,
      amountRaw: "5000000",
      timestamp: 1767225600,
      txHash: tx(11),
      logIndex: "6",
    }]);
    assert.deepEqual(trace.firstNativeFunding, {
      from: nativeFunder,
      amountWei: "1000000000000000000",
      timestamp: 1767225600,
      txHash: tx(12),
    });
    assert.equal(requests.length, 3);
    assert.equal(requests.every((request) => request.method === "alchemy_getAssetTransfers"), true);
    assert.equal(trace.query.nativeFundingScope, "first_ever_before_scan_end");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC first-native-funder discovery batches buyers into one request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-wash-rpc-native-batch-"));
  const originalFetch = globalThis.fetch;
  const buyerA = address(24);
  const buyerB = address(25);
  const funderA = address(26);
  const funderB = address(27);
  const rpcUrl = "https://base-mainnet.example.test/v2/key";
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), rpcUrl);
    const batch = JSON.parse(init.body);
    requests += 1;
    assert.equal(Array.isArray(batch), true);
    assert.equal(batch.length, 2);
    assert.deepEqual(batch.map((request) => request.params[0].toAddress), [buyerA, buyerB]);
    assert.equal(batch.every((request) => request.params[0].order === "asc" && request.params[0].maxCount === "0x1"), true);
    return Response.json(batch.map((request, index) => ({
      jsonrpc: "2.0",
      id: request.id,
      result: { transfers: [{
        from: index === 0 ? funderA : funderB,
        to: request.params[0].toAddress,
        hash: tx(30 + index),
        rawContract: { value: "0x38d7ea4c68000" },
        metadata: { blockTimestamp: "2026-01-01T00:00:00.000Z" },
      }] },
    })));
  };

  try {
    const client = createBlockscoutClient({
      baseUrl: "https://base.blockscout.test",
      rpcUrl,
      rpcTransferTracing: true,
      cacheDirectory: directory,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      toTimestamp: Math.floor(Date.now() / 1000) - 1,
    });
    const result = await client.fetchFirstNativeFundings({ buyers: [buyerB, buyerA] });
    assert.equal(requests, 1);
    assert.equal(result.complete, true);
    assert.equal(result.scope, "first_ever_before_scan_end");
    assert.deepEqual(result.records.map((record) => [record.buyer, record.from]), [[buyerA, funderA], [buyerB, funderB]]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC first-native-funder discovery accepts buyers with no native funding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-wash-rpc-native-empty-"));
  const originalFetch = globalThis.fetch;
  const buyer = address(28);
  const rpcUrl = "https://base-mainnet.example.test/v2/key";
  globalThis.fetch = async (_url, init) => {
    const [request] = JSON.parse(init.body);
    return Response.json([{ jsonrpc: "2.0", id: request.id, result: { transfers: [] } }]);
  };

  try {
    const client = createBlockscoutClient({
      baseUrl: "https://base.blockscout.test",
      rpcUrl,
      rpcTransferTracing: true,
      cacheDirectory: directory,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      toTimestamp: Math.floor(Date.now() / 1000) - 1,
    });
    const result = await client.fetchFirstNativeFundings({ buyers: [buyer] });
    assert.equal(result.complete, true);
    assert.deepEqual(result.records, []);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC transfer tracing stops once a page crosses the scan start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-wash-rpc-period-"));
  const originalFetch = globalThis.fetch;
  const traced = address(30);
  const funder = address(31);
  const rpcUrl = "https://base-mainnet.example.test/v2/key";
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    const parameters = request.params[0];
    if (parameters.toAddress) {
      assert.equal(parameters.order, "desc");
      assert.equal(parameters.pageKey, undefined);
      return Response.json({ jsonrpc: "2.0", id: 1, result: {
        transfers: [
          {
            from: funder,
            to: traced,
            hash: tx(20),
            rawContract: { value: "0x989680", address: BASE_USDC_ADDRESS },
            metadata: { blockTimestamp: "2026-01-15T00:00:00.000Z" },
            uniqueId: `${tx(20)}:log:1`,
          },
          {
            from: funder,
            to: traced,
            hash: tx(21),
            rawContract: { value: "0x4c4b40", address: BASE_USDC_ADDRESS },
            metadata: { blockTimestamp: "2025-12-31T23:59:59.000Z" },
            uniqueId: `${tx(21)}:log:2`,
          },
        ],
        pageKey: "must-not-be-requested",
      } });
    }
    return Response.json({ jsonrpc: "2.0", id: 1, result: { transfers: [] } });
  };

  try {
    const client = createBlockscoutClient({
      baseUrl: "https://base.blockscout.test",
      rpcUrl,
      rpcTransferTracing: true,
      cacheDirectory: directory,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      fromTimestamp: 1767225600,
      toTimestamp: 1769904000,
    });
    const trace = await client.traceAddress(traced);
    assert.equal(trace.complete, true);
    assert.equal(trace.inboundUsdc.length, 1);
    assert.equal(trace.inboundUsdc[0].txHash, tx(20));
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC transfer tracing skips high-volume auxiliary addresses without fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-wash-rpc-limit-"));
  const originalFetch = globalThis.fetch;
  const traced = address(40);
  const rpcUrl = "https://base-mainnet.example.test/v2/key";
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.equal(String(url), rpcUrl);
    return Response.json({ jsonrpc: "2.0", id: 1, result: { transfers: [1, 2, 3].map((value) => ({
      from: address(40 + value),
      to: traced,
      hash: tx(30 + value),
      rawContract: { value: "0x1", address: BASE_USDC_ADDRESS },
      metadata: { blockTimestamp: "2026-01-15T00:00:00.000Z" },
      uniqueId: `${tx(30 + value)}:log:${value}`,
    })), pageKey: "must-not-be-requested" } });
  };

  try {
    const client = createBlockscoutClient({
      baseUrl: "https://base.blockscout.test",
      rpcUrl,
      rpcTransferTracing: true,
      cacheDirectory: directory,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      fromTimestamp: 1767225600,
      toTimestamp: 1769904000,
    });
    const trace = await client.traceAddress(traced, { maxTransfers: 2 });
    assert.equal(trace.complete, false);
    assert.deepEqual(trace.inboundUsdc, []);
    assert.deepEqual(trace.outboundUsdc, []);
    assert.deepEqual(trace.skipped, { reason: "high_volume_address", maxTransfers: 2, observedTransfers: 3 });
    assert.match(trace.errors[0], /Skipped high-volume address/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

function address(value) {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function tx(value) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

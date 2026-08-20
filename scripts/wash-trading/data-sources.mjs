import { join } from "node:path";
import {
  appendJsonLine,
  cachePath,
  collectNdjsonItems,
  ensureDirectory,
  iterateNdjson,
  readJson,
  readNdjsonPages,
  stringifyError,
  writeJsonAtomic,
} from "./io.mjs";
import { normalizeAddress, timestampSeconds } from "./core.mjs";

export const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const BASE_DEPOSITS_ADDRESS = "0x0f7a3a8f4da01637d1202bb5443fcf7f88f99fd2";
export const DEPOSITED_EVENT_TOPIC = "0x2da466a7b24304f47e87fa2e1e5a81b9831ce54fec19055ce277ca2f39ba42c4";
export const BASE_RPC_URL = "https://base-rpc.publicnode.com";
export const PROTOCOL_ADDRESSES = new Set([
  BASE_USDC_ADDRESS,
  "0xf33fc901bfa97326379a369401f4490e231b69b0",
  BASE_DEPOSITS_ADDRESS,
  "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
  "0x3652e6b22919bd322a25723b94bb207602e5c8e6",
  "0x15649ff076bfa5e37e24ee3154a00503149954fd",
  "0xf13be52c4a3afc6ae29536f073588d01a0564088",
  "0xa87ee81b2c0bc659307ca2d9ffdc38514dd85263",
  "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
]);

const COLLECTIONS = Object.freeze({
  sellers: {
    type: "seller",
    filterType: "sellerFilter",
    key: (item) => normalizeAddress(item.address),
    fields: "address agentId stakeUsdc earnedUsdc sellerPoints requestCount inputTokens outputTokens uniqueBuyers channelCount firstSeenAt lastSeenAt lastBlockNumber",
  },
  buyerSellerPairs: {
    type: "buyerSellerPair",
    filterType: "buyerSellerPairFilter",
    key: (item) => item.id,
    fields: "id buyer seller volumeUsdc requestCount inputTokens outputTokens rawPoints firstSeenAt lastSeenAt lastBlockNumber",
  },
  channels: {
    type: "channel",
    filterType: "channelFilter",
    key: (item) => item.id,
    fields: "id buyer seller status maxAmountUsdc depositedAmountUsdc settledAmountUsdc refundAmountUsdc settlementCount requestCount inputTokens outputTokens openedAt closedAt lastSettledAt openBlockNumber lastBlockNumber",
  },
  settlementVolumes: {
    type: "settlementVolume",
    filterType: "settlementVolumeFilter",
    key: (item) => item.id,
    fields: "id txHash channelId buyer seller day dayStart epoch deltaUsdc platformFeeUsdc inputTokens outputTokens blockNumber timestamp",
  },
  settlementServices: {
    type: "settlementService",
    filterType: "settlementServiceFilter",
    key: (item) => item.id,
    fields: "id txHash channelId buyer seller serviceId deltaAmountUsdc deltaInputTokens deltaCachedInputTokens deltaOutputTokens deltaRequestCount blockNumber timestamp",
  },
  firstDeposits: {
    type: "firstDeposit",
    filterType: "firstDepositFilter",
    key: (item) => normalizeAddress(item.address),
    fields: "address day dayStart timestamp blockNumber txHash",
  },
  accounts: {
    type: "account",
    filterType: "accountFilter",
    key: (item) => normalizeAddress(item.address),
    fields: "address isBuyer isSeller agentId depositedUsdc withdrawnUsdc balanceDeltaUsdc spentUsdc earnedUsdc stakeUsdc sellerPoints buyerPoints requestCount inputTokens outputTokens firstSeenAt lastSeenAt lastBlockNumber",
  },
});

export function antScanGraphqlUrl(baseUrl) {
  const normalized = baseUrl.replace(/\/$/, "");
  return normalized.endsWith("/graphql") ? normalized : `${normalized}/graphql`;
}

export function createAntscanClient({ baseUrl, requestTimeoutMs, maxRetries, rawDirectory, checkpoint, persistCheckpoint, progress }) {
  const graphqlUrl = antScanGraphqlUrl(baseUrl);

  return {
    graphqlUrl,
    async validateSchema() {
      const names = Object.keys(COLLECTIONS);
      const aliases = Object.values(COLLECTIONS).map((definition, index) => `type${index}:__type(name:"${definition.type}"){fields{name}}`).join(" ");
      const data = await graphqlRequest(graphqlUrl, `query SchemaCheck { __schema { queryType { fields { name } } } ${aliases} }`, {}, { requestTimeoutMs, maxRetries });
      const available = new Set(data.__schema.queryType.fields.map((field) => field.name));
      const missing = names.filter((name) => !available.has(name));
      if (missing.length > 0) throw new Error(`AntScan GraphQL schema is missing required collections: ${missing.join(", ")}`);
      const fieldFailures = [];
      Object.values(COLLECTIONS).forEach((definition, index) => {
        const fields = new Set((data[`type${index}`]?.fields ?? []).map((field) => field.name));
        const required = definition.fields.split(/\s+/).filter(Boolean);
        const missingFields = required.filter((field) => !fields.has(field));
        if (missingFields.length > 0) fieldFailures.push(`${definition.type}: ${missingFields.join(", ")}`);
      });
      if (fieldFailures.length > 0) throw new Error(`AntScan GraphQL schema is missing required fields (${fieldFailures.join("; ")})`);
    },
    async fetchCollection(name, { pageSize = 1000, where = {} } = {}) {
      const definition = COLLECTIONS[name];
      if (!definition) throw new Error(`Unknown AntScan collection ${name}`);
      await ensureDirectory(rawDirectory);
      const path = join(rawDirectory, `${name}.ndjson`);
      const pages = await readNdjsonPages(path);
      let offset = pages.size === 0 ? 0 : Math.max(...[...pages.values()].map((page) => page.offset + page.items.length));
      let totalCount = pages.size === 0 ? null : Math.max(...[...pages.values()].map((page) => page.totalCount ?? 0));
      let complete = totalCount != null && offset >= totalCount;

      while (!complete) {
        const query = `query Page($limit:Int!,$offset:Int!,$where:${definition.filterType}){${name}(limit:$limit,offset:$offset,where:$where,orderBy:"${orderField(name)}",orderDirection:"asc"){totalCount items{${definition.fields}}}}`;
        const data = await graphqlRequest(graphqlUrl, query, { limit: pageSize, offset, where }, { requestTimeoutMs, maxRetries });
        const page = data[name];
        if (!page || !Array.isArray(page.items)) throw new Error(`AntScan ${name} response is malformed`);
        totalCount = Number(page.totalCount ?? page.items.length);
        await appendJsonLine(path, { offset, totalCount, items: page.items });
        offset += page.items.length;
        complete = offset >= totalCount;
        checkpoint.antscan[name] = { offset, totalCount, complete };
        await persistCheckpoint();
        progress?.({ phase: "antscan", label: name, completed: offset, total: totalCount });
        if (page.items.length === 0 && !complete) throw new Error(`AntScan ${name} returned an empty page at ${offset}/${totalCount}`);
      }
      return { path, totalCount };
    },
    async collectCollection(name, path) {
      const definition = COLLECTIONS[name];
      return collectNdjsonItems(path, definition.key);
    },
  };
}

function orderField(name) {
  if (name === "sellers" || name === "accounts" || name === "firstDeposits") return "address";
  return "id";
}

export async function findSettlementEarliest(path) {
  let earliest = null;
  for await (const page of iterateNdjson(path)) {
    for (const settlement of page.items ?? []) {
      const timestamp = timestampSeconds(settlement.timestamp);
      if (timestamp != null && timestamp > 0 && (earliest == null || timestamp < earliest)) earliest = timestamp;
    }
  }
  return earliest;
}

export async function streamSettlementPages(path, onPage) {
  for await (const page of iterateNdjson(path)) await onPage(page.items ?? []);
}

async function graphqlRequest(url, query, variables, options) {
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  }, options);
  const body = await response.json();
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error(`AntScan GraphQL error: ${body.errors.map((error) => error.message).join("; ")}`);
  }
  if (!body.data) throw new Error("AntScan GraphQL response contains no data");
  return body.data;
}

export function createBlockscoutClient({ baseUrl, rpcUrl = BASE_RPC_URL, rpcTransferTracing = false, cacheDirectory, requestTimeoutMs, maxRetries, fromTimestamp = 0, toTimestamp, transactionConcurrency = 4 }) {
  const normalizedBase = baseUrl.replace(/\/$/, "");

  async function getJson(url) {
    const path = cachePath(cacheDirectory, "blockscout-http", url);
    const cached = await readJson(path);
    const immutable = /\/api\/v2\/transactions\/0x[0-9a-f]{64}$/i.test(url);
    if (cached && cached.url === url && (immutable || timestampSeconds(cached.fetchedAt) >= toTimestamp)) return cached.body;
    const response = await fetchWithRetry(url, { headers: { accept: "application/json" } }, { requestTimeoutMs, maxRetries });
    const body = await response.json();
    await writeJsonAtomic(path, { version: 1, url, fetchedAt: new Date().toISOString(), body });
    return body;
  }

  async function paginate(pathname, onPage) {
    let nextUrl = new URL(pathname, normalizedBase).toString();
    const seen = new Set();
    let pages = 0;
    try {
      while (nextUrl) {
        if (seen.has(nextUrl)) throw new Error(`Blockscout pagination loop detected for ${pathname}`);
        seen.add(nextUrl);
        const body = await getJson(nextUrl);
        const items = Array.isArray(body.items) ? body.items : [];
        const shouldContinue = await onPage(items);
        pages += 1;
        if (shouldContinue === false) return { complete: true, pages, error: null };
        nextUrl = nextPageUrl(nextUrl, body.next_page_params);
      }
      return { complete: true, pages, error: null };
    } catch (error) {
      return { complete: false, pages, error: stringifyError(error) };
    }
  }

  async function rpcRequest(method, params) {
    const response = await fetchWithRetry(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }, { requestTimeoutMs, maxRetries });
    const body = await response.json();
    if (body.error) throw new Error(`${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  }

  async function rpcBatchRequest(requests) {
    const response = await fetchWithRetry(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(requests.map((request, index) => ({ jsonrpc: "2.0", id: index + 1, ...request }))),
    }, { requestTimeoutMs, maxRetries });
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error("RPC provider did not return a batch response");
    return body;
  }

  async function paginateAssetTransfers(parameters, onPage) {
    let pageKey = null;
    const seen = new Set();
    let pages = 0;
    try {
      do {
        if (pageKey && seen.has(pageKey)) throw new Error("Alchemy asset-transfer pagination loop detected");
        if (pageKey) seen.add(pageKey);
        const result = await rpcRequest("alchemy_getAssetTransfers", [{
          fromBlock: "0x0",
          toBlock: "latest",
          category: ["erc20"],
          withMetadata: true,
          excludeZeroValue: true,
          maxCount: "0x3e8",
          order: "desc",
          ...parameters,
          ...(pageKey ? { pageKey } : {}),
        }]);
        const shouldContinue = await onPage(Array.isArray(result?.transfers) ? result.transfers : []);
        pages += 1;
        if (shouldContinue === false) return { complete: true, pages, error: null };
        pageKey = result?.pageKey ?? null;
      } while (pageKey);
      return { complete: true, pages, error: null };
    } catch (error) {
      return { complete: false, pages, error: stringifyError(error) };
    }
  }

  return {
    async fetchProtocolDeposits({ buyers = null, onProgress = null } = {}) {
      if (buyers) {
        const buyerSet = new Set(buyers.map(normalizeAddress).filter(Boolean));
        let completedBuyerLogs = 0;
        const logResults = await mapWithConcurrency([...buyerSet], transactionConcurrency, async (buyer) => {
          const references = [];
          const buyerTopic = `0x${buyer.slice(2).padStart(64, "0")}`;
          const result = await paginate(`/api/v2/addresses/${BASE_DEPOSITS_ADDRESS}/logs?topic=${buyerTopic}`, async (items) => {
            for (const item of items) {
              const reference = protocolDepositLogReference(item);
              if (reference && reference.timestamp < toTimestamp && reference.buyer === buyer) references.push(reference);
            }
          });
          completedBuyerLogs += 1;
          onProgress?.({ stage: "buyer-logs", completed: completedBuyerLogs, total: buyerSet.size });
          return { references, result };
        });
        const references = dedupeBy(logResults.flatMap((entry) => entry.references), (record) => `${record.txHash}:${record.buyer}`);
        const senders = await resolveTransactionSenders(references.map((record) => record.txHash), onProgress);
        const records = [];
        const errors = [];
        for (const reference of references) {
          const funder = senders.get(reference.txHash);
          if (funder) records.push({ ...reference, funder, kind: "protocol_deposit" });
          else errors.push(`Transaction ${reference.txHash} has no resolvable sender`);
        }
        const failedLogQueries = logResults.filter((entry) => !entry.result.complete);
        return {
          records,
          complete: failedLogQueries.length === 0 && errors.length === 0,
          pages: logResults.reduce((total, entry) => total + entry.result.pages, 0),
          error: [...failedLogQueries.map((entry) => entry.result.error), ...errors].filter(Boolean).join("; ") || null,
        };
      }
      const records = [];
      const result = await paginate(`/api/v2/addresses/${BASE_DEPOSITS_ADDRESS}/transactions?filter=to`, async (items) => {
        for (const transaction of items) {
          const record = protocolDepositRecord(transaction);
          if (record && record.timestamp < toTimestamp) records.push(record);
        }
      });
      return { records: dedupeBy(records, (record) => `${record.txHash}:${record.buyer}`), ...result };
    },
    async traceAddress(address, { includeNative = false, maxTransfers = Number.POSITIVE_INFINITY } = {}) {
      if (rpcTransferTracing) {
        const rpcTrace = await traceAddressWithRpc(address, { includeNative, maxTransfers });
        if (rpcTrace.complete || rpcTrace.skipped) return rpcTrace;
      }
      return traceAddressWithBlockscout(address, { includeNative, maxTransfers });
    },
    async fetchFirstNativeFundings({ buyers, onProgress = null }) {
      const addresses = [...new Set(buyers.map(normalizeAddress).filter(Boolean))].sort();
      if (rpcTransferTracing) {
        try {
          return await batchFirstNativeFundingsWithRpc(addresses, onProgress);
        } catch {
          const rows = await mapWithConcurrency(addresses, transactionConcurrency, async (address, index) => {
            const result = await traceFirstNativeFundingWithRpc(address);
            onProgress?.({ completed: index + 1, total: addresses.length });
            return { address, ...result };
          });
          return nativeFundingRows(rows);
        }
      }
      const rows = await mapWithConcurrency(addresses, transactionConcurrency, async (address, index) => {
        const result = await traceFirstNativeFundingWithBlockscout(address);
        onProgress?.({ completed: index + 1, total: addresses.length });
        return { address, ...result };
      });
      return nativeFundingRows(rows);
    },
  };

  async function batchFirstNativeFundingsWithRpc(addresses, onProgress) {
    const rows = [];
    const batchSize = 100;
    for (let offset = 0; offset < addresses.length; offset += batchSize) {
      const batch = addresses.slice(offset, offset + batchSize);
      const responses = await rpcBatchRequest(batch.map((address) => ({
        method: "alchemy_getAssetTransfers",
        params: [firstNativeFundingRpcParameters(address)],
      })));
      const byId = new Map(responses.map((response) => [response.id, response]));
      for (let index = 0; index < batch.length; index += 1) {
        const address = batch[index];
        const response = byId.get(index + 1);
        if (response?.error) {
          rows.push({ address, complete: false, firstNativeFunding: null, error: response.error.message ?? JSON.stringify(response.error) });
          continue;
        }
        const item = response?.result?.transfers?.[0];
        const firstNativeFunding = nativeAssetTransferRecord(item);
        rows.push({
          address,
          complete: true,
          firstNativeFunding: firstNativeFunding?.timestamp < toTimestamp ? firstNativeFunding : null,
          error: null,
        });
      }
      onProgress?.({ completed: Math.min(offset + batch.length, addresses.length), total: addresses.length });
    }
    return nativeFundingRows(rows);
  }

  async function traceFirstNativeFundingWithRpc(address) {
    const result = await rpcRequest("alchemy_getAssetTransfers", [firstNativeFundingRpcParameters(address)]);
    const firstNativeFunding = nativeAssetTransferRecord(result?.transfers?.[0]);
    return {
      complete: true,
      firstNativeFunding: firstNativeFunding?.timestamp < toTimestamp ? firstNativeFunding : null,
      error: null,
    };
  }

  async function traceFirstNativeFundingWithBlockscout(address) {
    let firstNativeFunding = null;
    const result = await paginate(`/api/v2/addresses/${address}/transactions?filter=to`, async (items) => {
      for (const item of items) {
        const to = normalizeAddress(item.to?.hash);
        const from = normalizeAddress(item.from?.hash);
        const timestamp = timestampSeconds(item.timestamp);
        if (to !== address || !from || timestamp == null || timestamp >= toTimestamp || BigInt(item.value ?? "0") <= 0n) continue;
        if (!firstNativeFunding || timestamp < firstNativeFunding.timestamp) {
          firstNativeFunding = { from, amountWei: String(item.value), timestamp, txHash: item.hash };
        }
      }
    });
    return { complete: result.complete, firstNativeFunding, error: result.error };
  }

  function firstNativeFundingRpcParameters(address) {
    return {
      fromBlock: "0x0",
      toBlock: "latest",
      toAddress: address,
      category: ["external"],
      withMetadata: true,
      excludeZeroValue: true,
      maxCount: "0x1",
      order: "asc",
    };
  }

  async function traceAddressWithRpc(address, { includeNative, maxTransfers }) {
    const inboundUsdc = [];
    const outboundUsdc = [];
    const errors = [];
    let transferLimitExceeded = false;
    const common = { contractAddresses: [BASE_USDC_ADDRESS], category: ["erc20"] };
    const inbound = await paginateAssetTransfers({ ...common, toAddress: address }, async (items) => {
      for (const item of items) {
        const transfer = assetTransferRecord(item);
        if (transfer && transfer.timestamp >= fromTimestamp && transfer.timestamp < toTimestamp) inboundUsdc.push(transfer);
        if (inboundUsdc.length > maxTransfers) {
          transferLimitExceeded = true;
          return false;
        }
      }
      return !pageCrossesStart(items, fromTimestamp, (item) => item.metadata?.blockTimestamp);
    });
    if (transferLimitExceeded) return highVolumeTrace(address, fromTimestamp, toTimestamp, maxTransfers, inboundUsdc.length);
    if (!inbound.complete) errors.push(inbound.error);
    const outbound = await paginateAssetTransfers({ ...common, fromAddress: address }, async (items) => {
      for (const item of items) {
        const transfer = assetTransferRecord(item);
        if (transfer && transfer.timestamp >= fromTimestamp && transfer.timestamp < toTimestamp) outboundUsdc.push(transfer);
        if (inboundUsdc.length + outboundUsdc.length > maxTransfers) {
          transferLimitExceeded = true;
          return false;
        }
      }
      return !pageCrossesStart(items, fromTimestamp, (item) => item.metadata?.blockTimestamp);
    });
    if (transferLimitExceeded) return highVolumeTrace(address, fromTimestamp, toTimestamp, maxTransfers, inboundUsdc.length + outboundUsdc.length);
    if (!outbound.complete) errors.push(outbound.error);

    let firstNativeFunding = null;
    let nativeComplete = true;
    if (includeNative) {
      const native = await traceFirstNativeFundingWithRpc(address);
      firstNativeFunding = native.firstNativeFunding;
      nativeComplete = native.complete;
      if (!native.complete) errors.push(native.error);
    }

    return {
      address,
      complete: inbound.complete && outbound.complete && nativeComplete,
      inboundUsdc: dedupeBy(inboundUsdc, transferKey),
      outboundUsdc: dedupeBy(outboundUsdc, transferKey),
      firstNativeFunding,
      errors: errors.filter(Boolean),
      query: { token: BASE_USDC_ADDRESS, fromTimestamp, toTimestamp, nativeFundingScope: includeNative ? "first_ever_before_scan_end" : null },
    };
  }

  async function traceAddressWithBlockscout(address, { includeNative, maxTransfers }) {
    const inboundUsdc = [];
    const outboundUsdc = [];
    const errors = [];
    let transferLimitExceeded = false;
    const inbound = await paginate(`/api/v2/addresses/${address}/token-transfers?type=ERC-20&filter=to&token=${BASE_USDC_ADDRESS}`, async (items) => {
      for (const item of items) {
        const transfer = tokenTransferRecord(item);
        if (transfer && transfer.timestamp >= fromTimestamp && transfer.timestamp < toTimestamp) inboundUsdc.push(transfer);
        if (inboundUsdc.length > maxTransfers) {
          transferLimitExceeded = true;
          return false;
        }
      }
      return !pageCrossesStart(items, fromTimestamp, (item) => item.timestamp);
    });
    if (transferLimitExceeded) return highVolumeTrace(address, fromTimestamp, toTimestamp, maxTransfers, inboundUsdc.length);
    if (!inbound.complete) errors.push(inbound.error);
    const outbound = await paginate(`/api/v2/addresses/${address}/token-transfers?type=ERC-20&filter=from&token=${BASE_USDC_ADDRESS}`, async (items) => {
      for (const item of items) {
        const transfer = tokenTransferRecord(item);
        if (transfer && transfer.timestamp >= fromTimestamp && transfer.timestamp < toTimestamp) outboundUsdc.push(transfer);
        if (inboundUsdc.length + outboundUsdc.length > maxTransfers) {
          transferLimitExceeded = true;
          return false;
        }
      }
      return !pageCrossesStart(items, fromTimestamp, (item) => item.timestamp);
    });
    if (transferLimitExceeded) return highVolumeTrace(address, fromTimestamp, toTimestamp, maxTransfers, inboundUsdc.length + outboundUsdc.length);
    if (!outbound.complete) errors.push(outbound.error);

    let firstNativeFunding = null;
    let nativeComplete = true;
    if (includeNative) {
      const native = await traceFirstNativeFundingWithBlockscout(address);
      firstNativeFunding = native.firstNativeFunding;
      nativeComplete = native.complete;
      if (!native.complete) errors.push(native.error);
    }

    return {
      address,
      complete: inbound.complete && outbound.complete && nativeComplete,
      inboundUsdc: dedupeBy(inboundUsdc, transferKey),
      outboundUsdc: dedupeBy(outboundUsdc, transferKey),
      firstNativeFunding,
      errors: errors.filter(Boolean),
      query: { token: BASE_USDC_ADDRESS, fromTimestamp, toTimestamp, nativeFundingScope: includeNative ? "first_ever_before_scan_end" : null },
    };
  }

  async function resolveTransactionSenders(hashes, onProgress = null) {
    const uniqueHashes = [...new Set(hashes)];
    const senders = new Map();
    const missing = [];
    for (const hash of uniqueHashes) {
      const path = cachePath(cacheDirectory, "base-transaction-senders", hash);
      const cached = await readJson(path);
      const sender = normalizeAddress(cached?.sender);
      if (sender) senders.set(hash, sender);
      else missing.push(hash);
    }

    const chunks = [];
    for (let index = 0; index < missing.length; index += 100) chunks.push(missing.slice(index, index + 100));
    const unresolved = [];
    let completedChunks = 0;
    await mapWithConcurrency(chunks, Math.min(transactionConcurrency, 4), async (chunk) => {
      let responses = [];
      try {
        const response = await fetchWithRetry(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(chunk.map((hash, index) => ({ jsonrpc: "2.0", id: index + 1, method: "eth_getTransactionByHash", params: [hash] }))),
        }, { requestTimeoutMs, maxRetries });
        const body = await response.json();
        responses = Array.isArray(body) ? body : [];
      } catch {
        responses = [];
      }
      for (let index = 0; index < chunk.length; index += 1) {
        const hash = chunk[index];
        const sender = normalizeAddress(responses.find((entry) => entry.id === index + 1)?.result?.from);
        if (!sender) {
          unresolved.push(hash);
          continue;
        }
        senders.set(hash, sender);
        await writeJsonAtomic(cachePath(cacheDirectory, "base-transaction-senders", hash), { version: 1, hash, sender });
      }
      completedChunks += 1;
      onProgress?.({ stage: "transaction-senders", completed: completedChunks, total: chunks.length });
    });
    await mapWithConcurrency(unresolved, transactionConcurrency, async (hash) => {
      let sender = null;
      try {
        sender = normalizeAddress((await getJson(`${normalizedBase}/api/v2/transactions/${hash}`)).from?.hash);
      } catch {
        return;
      }
      if (!sender) return;
      senders.set(hash, sender);
      await writeJsonAtomic(cachePath(cacheDirectory, "base-transaction-senders", hash), { version: 1, hash, sender });
    });
    return senders;
  }
}

function protocolDepositRecord(transaction) {
  if (transaction.status !== "ok" && transaction.result !== "success") return null;
  const method = transaction.decoded_input?.method_call ?? transaction.method ?? "";
  if (!String(method).startsWith("deposit(") && !String(method).startsWith("depositFor(")) return null;
  const parameters = transaction.decoded_input?.parameters ?? [];
  const buyer = normalizeAddress(parameters.find((parameter) => parameter.name === "buyer")?.value);
  const funder = normalizeAddress(transaction.from?.hash);
  const amount = parameters.find((parameter) => parameter.name === "amount")?.value;
  const timestamp = timestampSeconds(transaction.timestamp);
  if (!buyer || !funder || timestamp == null || !/^\d+$/.test(String(amount ?? ""))) return null;
  return {
    buyer,
    funder,
    amountRaw: String(amount),
    timestamp,
    txHash: transaction.hash,
    kind: "protocol_deposit",
  };
}

function protocolDepositLogReference(log) {
  if (String(log.topics?.[0] ?? "").toLowerCase() !== DEPOSITED_EVENT_TOPIC) return null;
  const parameters = log.decoded?.parameters ?? [];
  const buyer = normalizeAddress(parameters.find((parameter) => parameter.name === "buyer")?.value);
  const amount = parameters.find((parameter) => parameter.name === "amount")?.value;
  const timestamp = timestampSeconds(log.block_timestamp);
  const txHash = log.transaction_hash;
  if (!buyer || timestamp == null || !/^\d+$/.test(String(amount ?? "")) || !/^0x[0-9a-f]{64}$/i.test(String(txHash ?? ""))) return null;
  return { buyer, amountRaw: String(amount), timestamp, txHash };
}

function tokenTransferRecord(item) {
  const from = normalizeAddress(item.from?.hash ?? item.from);
  const to = normalizeAddress(item.to?.hash ?? item.to);
  const token = normalizeAddress(item.token?.address_hash ?? item.token?.address);
  const timestamp = timestampSeconds(item.timestamp);
  const amountRaw = item.total?.value ?? item.value;
  if (!from || !to || token !== BASE_USDC_ADDRESS || timestamp == null || !/^\d+$/.test(String(amountRaw ?? ""))) return null;
  return {
    from,
    to,
    amountRaw: String(amountRaw),
    timestamp,
    txHash: item.transaction_hash ?? item.tx_hash,
    logIndex: item.log_index ?? null,
  };
}

function assetTransferRecord(item) {
  const from = normalizeAddress(item.from);
  const to = normalizeAddress(item.to);
  const token = normalizeAddress(item.rawContract?.address);
  const timestamp = timestampSeconds(item.metadata?.blockTimestamp);
  const amountRaw = parseRpcQuantity(item.rawContract?.value);
  if (!from || !to || token !== BASE_USDC_ADDRESS || timestamp == null || amountRaw == null) return null;
  return {
    from,
    to,
    amountRaw,
    timestamp,
    txHash: item.hash,
    logIndex: item.uniqueId?.split(":log:")[1] ?? null,
  };
}

function nativeAssetTransferRecord(item) {
  if (!item || typeof item !== "object") return null;
  const from = normalizeAddress(item.from);
  const amountWei = parseRpcQuantity(item.rawContract?.value);
  const timestamp = timestampSeconds(item.metadata?.blockTimestamp);
  if (!from || amountWei == null || amountWei === "0" || timestamp == null) return null;
  return { from, amountWei, timestamp, txHash: item.hash };
}

function nativeFundingRows(rows) {
  return {
    version: 1,
    scope: "first_ever_before_scan_end",
    records: rows.filter((row) => row.firstNativeFunding).map((row) => ({
      buyer: row.address,
      ...row.firstNativeFunding,
    })),
    complete: rows.every((row) => row.complete),
    errors: rows.filter((row) => !row.complete).map((row) => ({ buyer: row.address, error: row.error })),
  };
}

function parseRpcQuantity(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  return BigInt(value).toString();
}

function pageCrossesStart(items, fromTimestamp, timestampForItem) {
  if (fromTimestamp <= 0) return false;
  for (const item of items) {
    const timestamp = timestampSeconds(timestampForItem(item));
    if (timestamp != null && timestamp < fromTimestamp) return true;
  }
  return false;
}

function highVolumeTrace(address, fromTimestamp, toTimestamp, maxTransfers, observedTransfers) {
  return {
    address,
    complete: false,
    inboundUsdc: [],
    outboundUsdc: [],
    firstNativeFunding: null,
    errors: [`Skipped high-volume address after observing more than ${maxTransfers} Base USDC transfers in the scan period`],
    skipped: { reason: "high_volume_address", maxTransfers, observedTransfers },
    query: { token: BASE_USDC_ADDRESS, fromTimestamp, toTimestamp, maxTransfers },
  };
}

export function fundingRecordsFromTraces(traces, buyers) {
  const buyerSet = new Set(buyers);
  const records = [];
  for (const buyer of buyerSet) {
    const trace = traces.get(buyer);
    if (!trace) continue;
    for (const transfer of trace.inboundUsdc) {
      if (transfer.to !== buyer || PROTOCOL_ADDRESSES.has(transfer.from)) continue;
      records.push({
        buyer,
        funder: transfer.from,
        amountRaw: transfer.amountRaw,
        timestamp: transfer.timestamp,
        txHash: transfer.txHash,
        kind: "direct_usdc_transfer",
      });
    }
  }
  return dedupeBy(records, (record) => `${record.kind}:${record.txHash}:${record.buyer}:${record.amountRaw}`);
}

export async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function fetchWithRetry(url, init, { requestTimeoutMs, maxRetries }) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const body = await response.text();
      if (!retryable || attempt === maxRetries) throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
      const retryAfter = retryAfterMs(response.headers.get("retry-after"));
      await delay(retryAfter ?? backoffMs(attempt));
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      await delay(backoffMs(attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error(`Request failed: ${url}`);
}

function nextPageUrl(currentUrl, params) {
  if (!params || typeof params !== "object") return null;
  const next = new URL(currentUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) next.searchParams.set(key, String(value));
  }
  return next.toString();
}

function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function backoffMs(attempt) {
  return Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function dedupeBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function transferKey(transfer) {
  return `${transfer.txHash}:${transfer.logIndex ?? ""}:${transfer.from}:${transfer.to}:${transfer.amountRaw}`;
}

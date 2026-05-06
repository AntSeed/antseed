import Database from 'better-sqlite3';
import type { DecodedMetadataRecorded } from '@antseed/node';

export interface SellerTotals {
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
  firstSettledBlock: number;
  lastSettledBlock: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  uniqueBuyers: number;
  uniqueChannels: number;
  avgRequestsPerChannel: number;
  avgRequestsPerBuyer: number;
  lastUpdatedAt: number;
}

/**
 * Per-seller totals row keyed by agentId — the same shape consumers see in
 * /stats per peer, but enumerated across the whole indexed set so the
 * insights endpoint can build leaderboards without N+1 round trips. Returned
 * by `getAllSellerTotalsWithIds` and consumed by `insights.ts`.
 */
export interface SellerTotalsWithId extends SellerTotals {
  agentId: number;
}

export interface NetworkTotals {
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
  sellerCount: number;
  lastUpdatedAt: number | null;
}

export interface HistorySample {
  ts: number;                    // unix seconds
  activePeers: number;
  sellerCount: number;
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
}

export type HistoryRange = '1d' | '7d' | '30d';

export interface HistoryPoint {
  ts: number;                  // unix seconds, bucket boundary (start of bucket)
  activePeers: number | null;  // last gauge sample in bucket; null when only chain-backfilled rows are present (we have no DHT history for the past)
  requests: number;            // delta of cumulative within the bucket
  settlements: number;         // delta of cumulative within the bucket
  tokens: number;              // delta of cumulative input+output tokens within the bucket
}

export interface HistoryResponse {
  range: HistoryRange;
  bucketSeconds: number;
  points: HistoryPoint[];
}

/**
 * Sentinel written into `network_history.active_peers` by the chain backfill
 * since we genuinely don't know how many peers were online at past timestamps.
 * `bucketHistoryRows` translates -1 into a null on the way out so the chart
 * skips the peers line for those buckets without needing a schema change.
 */
export const ACTIVE_PEERS_UNKNOWN = -1;

export interface PriceSampleInput {
  peerId: string;        // 40 hex chars (no 0x), normalized lowercase
  provider: string;
  service: string;
  ts: number;            // unix seconds
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number | null;
}

const PRICE_SAMPLE_HEARTBEAT_SECONDS = 86_400;

/**
 * Per-(peer, service) pricing volatility rollup over a window. Drives the
 * "most stable / most volatile" insight leaderboards. `changeCount` is the
 * number of distinct price tuples observed in the window; stable peers remain
 * visible because unchanged announcements are persisted as daily heartbeats.
 */
export interface PriceVolatilityRow {
  peerId: string;
  provider: string;
  service: string;
  sampleCount: number;
  changeCount: number;       // distinct (input, output) tuples in the window
  firstTs: number;
  lastTs: number;
  firstInputUsdPerMillion: number;
  firstOutputUsdPerMillion: number;
  latestInputUsdPerMillion: number;
  latestOutputUsdPerMillion: number;
}

export interface SellerActivityRow {
  agentId: number;
  ts: number;
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
}

export interface SellerActivitySnapshotInput {
  agentId: number;
  ts: number;
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
}

/**
 * One decoded log row destined for `chain_events`. `args` is a plain object
 * keyed by the event's input names; bigint values are pre-stringified by the
 * caller so JSON.stringify works without throwing. The store re-stringifies
 * the whole args object on insert and parses it back on read.
 */
export interface ChainEventInsert {
  chainId: string;
  contractAddress: string;          // lowercased by caller
  blockNumber: number;
  blockTimestamp: number | null;
  txHash: string;
  logIndex: number;
  eventName: string;
  args: Record<string, unknown>;     // bigints already → strings
}

/**
 * Read-side shape returned to the HTTP layer. `args` is parsed back into a
 * plain object so the route can pass it straight to JSON.stringify.
 */
export interface ChainEventRow {
  chainId: string;
  contractAddress: string;
  blockNumber: number;
  blockTimestamp: number | null;
  txHash: string;
  logIndex: number;
  eventName: string;
  args: Record<string, unknown>;
}

export interface ChainEventQuery {
  chainId?: string;
  contractAddress?: string;          // lowercased before passing in
  eventName?: string;
  txHash?: string;
  fromBlock?: number;
  toBlock?: number;
  /** Default 50, capped to MAX_CHAIN_EVENT_LIMIT. */
  limit?: number;
  /**
   * Keyset cursor for pagination — return rows with
   * (blockNumber, logIndex) strictly less than this point. Use the last
   * row's coords from a prior page.
   */
  beforeBlockNumber?: number;
  beforeLogIndex?: number;
}

const MAX_CHAIN_EVENT_LIMIT = 500;

/**
 * Per-address ANTS balance row. `balance` is a stringified bigint to keep
 * full precision past 2^53 — supply is up to 52e24 wei (52M × 10^18) which
 * blows past JS Number safety. The HTTP layer stringifies again on the way
 * out so callers never see a bigint at the JSON boundary.
 */
export interface AntsHolderBalance {
  address: string;
  balance: bigint;
  firstSeenBlock: number;
  lastTxBlock: number;
}

export interface AntsSupplySnapshot {
  totalSupply: bigint;
  holderCount: number;
  lastUpdatedBlock: number | null;
}

export interface AntsSupplyHistoryPoint {
  ts: number;
  totalSupply: bigint;
  holderCount: number;
}

/**
 * One Transfer event applied to the rollup. `from` or `to` set to the zero
 * address signals a mint or burn — total supply moves up/down accordingly.
 */
export interface AntsTransferEvent {
  blockNumber: number;
  from: string;        // lowercased; zero address for mints
  to: string;          // lowercased; zero address for burns
  value: bigint;
}

/**
 * Decoded ERC-8004 ReputationRegistry event, in the shape expected by
 * `applyReputationEvents`. The reputation indexer translates raw chain
 * events into these typed records before handing them off to the store.
 *
 * `value` is the buyer-supplied feedback score; `valueDecimals` divides it
 * to a fixed-point representation. We keep `value` as a stringified bigint
 * (int128 fits comfortably) so the API can return either the raw number or
 * a normalized score without re-fetching.
 */
export type ReputationEvent =
  | {
      kind: 'NewFeedback';
      blockNumber: number;
      blockTimestamp: number | null;
      txHash: string;
      agentId: bigint;
      clientAddress: string;     // lowercased
      feedbackIndex: number;     // uint64; safe to narrow to number on Base
      value: bigint;             // int128
      valueDecimals: number;
      tag1: string;
      tag2: string;
      endpoint: string;
      feedbackURI: string;
      feedbackHash: string;      // 0x-prefixed bytes32
    }
  | {
      kind: 'ResponseAppended';
      blockNumber: number;
      agentId: bigint;
      clientAddress: string;
      feedbackIndex: number;
      responder: string;
      responseURI: string;
      responseHash: string;
    }
  | {
      kind: 'FeedbackRevoked';
      blockNumber: number;
      agentId: bigint;
      clientAddress: string;
      feedbackIndex: number;
    };

export interface ReputationFeedbackRow {
  agentId: number;
  clientAddress: string;
  feedbackIndex: number;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
  blockNumber: number;
  blockTimestamp: number | null;
  txHash: string;
  revoked: boolean;
  revokedAtBlock: number | null;
  responseURI: string | null;
  responseHash: string | null;
  responseResponder: string | null;
  responseAtBlock: number | null;
}

export interface ReputationAgentTotals {
  agentId: number;
  feedbackCount: number;
  revokedCount: number;
  responseCount: number;
  uniqueClients: number;
  firstFeedbackBlock: number | null;
  lastFeedbackBlock: number | null;
}

// ── DB row shapes (snake_case mirror of the SQL columns) ───────────────────

interface SellerRow {
  total_input_tokens: string;
  total_output_tokens: string;
  total_request_count: string;
  settlement_count: number;
  first_settled_block: number | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
}

interface AggregateRow {
  total_input_tokens: string;
  total_output_tokens: string;
  total_request_count: string;
  settlement_count: number;
  first_settled_block: number;
}

interface SellerTotalsRow {
  total_request_count: string;
  total_input_tokens: string;
  total_output_tokens: string;
  settlement_count: number;
  first_settled_block: number | null;
  last_settled_block: number | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
  last_updated_at: number;
}

interface HistoryRow {
  ts: number;
  active_peers: number;
  seller_count: number;
  total_requests: string;
  total_input_tokens: string;
  total_output_tokens: string;
  settlement_count: number;
}

interface SellerActivityDbRow {
  agent_id: number;
  ts: number;
  total_requests: string;
  total_input_tokens: string;
  total_output_tokens: string;
  settlement_count: number;
}

interface ChainEventDbRow {
  chain_id: string;
  contract_address: string;
  block_number: number;
  block_timestamp: number | null;
  tx_hash: string;
  log_index: number;
  event_name: string;
  args_json: string;
}

interface AntsHolderRow {
  address: string;
  balance: string;
  first_seen_block: number;
  last_tx_block: number;
}

interface AntsSupplyRow {
  total_supply: string;
  holder_count: number;
  last_updated_block: number | null;
}

interface AntsSupplyHistoryDbRow {
  ts: number;
  total_supply: string;
  holder_count: number;
}

const ZERO_ADDRESS = '0x' + '0'.repeat(40);

interface ReputationFeedbackDbRow {
  agent_id: number;
  client_address: string;
  feedback_index: number;
  value: string;
  value_decimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedback_uri: string;
  feedback_hash: string;
  block_number: number;
  block_timestamp: number | null;
  tx_hash: string;
  revoked: number;
  revoked_at_block: number | null;
  response_uri: string | null;
  response_hash: string | null;
  response_responder: string | null;
  response_at_block: number | null;
}

interface ReputationTotalsDbRow {
  agent_id: number;
  feedback_count: number;
  revoked_count: number;
  response_count: number;
  unique_clients: number;
  first_feedback_block: number | null;
  last_feedback_block: number | null;
}

// ── DDL + prepared statements ──────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS seller_metadata_totals (
    agent_id INTEGER PRIMARY KEY,
    total_input_tokens TEXT NOT NULL DEFAULT '0',
    total_output_tokens TEXT NOT NULL DEFAULT '0',
    total_request_count TEXT NOT NULL DEFAULT '0',
    settlement_count INTEGER NOT NULL DEFAULT 0,
    first_settled_block INTEGER,
    last_settled_block INTEGER,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    last_updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS seller_buyer_totals (
    agent_id INTEGER NOT NULL,
    buyer TEXT NOT NULL,
    total_input_tokens TEXT NOT NULL DEFAULT '0',
    total_output_tokens TEXT NOT NULL DEFAULT '0',
    total_request_count TEXT NOT NULL DEFAULT '0',
    settlement_count INTEGER NOT NULL DEFAULT 0,
    first_settled_block INTEGER NOT NULL,
    last_settled_block INTEGER NOT NULL,
    PRIMARY KEY (agent_id, buyer)
  );

  CREATE TABLE IF NOT EXISTS seller_channel_totals (
    agent_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    buyer TEXT NOT NULL,
    total_input_tokens TEXT NOT NULL DEFAULT '0',
    total_output_tokens TEXT NOT NULL DEFAULT '0',
    total_request_count TEXT NOT NULL DEFAULT '0',
    settlement_count INTEGER NOT NULL DEFAULT 0,
    first_settled_block INTEGER NOT NULL,
    last_settled_block INTEGER NOT NULL,
    PRIMARY KEY (agent_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS indexer_checkpoint (
    chain_id TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    last_block INTEGER NOT NULL,
    last_block_timestamp INTEGER,
    PRIMARY KEY (chain_id, contract_address)
  );

  CREATE TABLE IF NOT EXISTS network_history (
    ts INTEGER PRIMARY KEY,
    active_peers INTEGER NOT NULL,
    seller_count INTEGER NOT NULL,
    total_requests TEXT NOT NULL,
    total_input_tokens TEXT NOT NULL,
    total_output_tokens TEXT NOT NULL,
    settlement_count INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS peer_pricing_history (
    peer_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    service TEXT NOT NULL,
    ts INTEGER NOT NULL,
    input_usd_per_million REAL NOT NULL,
    output_usd_per_million REAL NOT NULL,
    cached_input_usd_per_million REAL,
    PRIMARY KEY (peer_id, provider, service, ts)
  );

  CREATE INDEX IF NOT EXISTS idx_peer_pricing_history_ts
    ON peer_pricing_history (ts);

  CREATE TABLE IF NOT EXISTS seller_activity_history (
    agent_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    total_requests TEXT NOT NULL,
    total_input_tokens TEXT NOT NULL,
    total_output_tokens TEXT NOT NULL,
    settlement_count INTEGER NOT NULL,
    PRIMARY KEY (agent_id, ts)
  );

  CREATE INDEX IF NOT EXISTS idx_seller_activity_history_ts
    ON seller_activity_history (ts);

  -- Generic raw-log table written by every contract indexer in this service.
  -- The typed rollup tables above (seller_*, ants_*, reputation_*) are
  -- materialized views over this; the explorer's "latest activity feed",
  -- per-tx page, and per-contract event history all read from here directly.
  --
  -- args_json holds the decoded event inputs keyed by the ABI input names,
  -- with bigints pre-stringified so JSON.stringify is safe. PK is
  -- (chain_id, contract_address, block_number, log_index) — same uniqueness
  -- the chain itself enforces, which makes inserts idempotent on indexer
  -- replays.
  CREATE TABLE IF NOT EXISTS chain_events (
    chain_id          TEXT NOT NULL,
    contract_address  TEXT NOT NULL,
    block_number      INTEGER NOT NULL,
    block_timestamp   INTEGER,
    tx_hash           TEXT NOT NULL,
    log_index         INTEGER NOT NULL,
    event_name        TEXT NOT NULL,
    args_json         TEXT NOT NULL,
    PRIMARY KEY (chain_id, contract_address, block_number, log_index)
  );

  CREATE INDEX IF NOT EXISTS idx_chain_events_recent
    ON chain_events (block_number DESC, log_index DESC);
  CREATE INDEX IF NOT EXISTS idx_chain_events_tx
    ON chain_events (tx_hash);
  CREATE INDEX IF NOT EXISTS idx_chain_events_contract
    ON chain_events (chain_id, contract_address, block_number DESC, log_index DESC);
  CREATE INDEX IF NOT EXISTS idx_chain_events_event
    ON chain_events (event_name, block_number DESC, log_index DESC);

  -- ANTS token (ERC-20) rollups, derived from chain_events of event_name='Transfer'
  -- on the configured antsTokenAddress.
  -- Per-holder balance. Rows with balance='0' get DELETEd in the rollup so
  -- holder_count is COUNT(*) — no IS NOT NULL filter needed.
  CREATE TABLE IF NOT EXISTS ants_holder_balances (
    address          TEXT PRIMARY KEY,
    balance          TEXT NOT NULL,
    first_seen_block INTEGER NOT NULL,
    last_tx_block    INTEGER NOT NULL
  );

  -- Single-row aggregate. We track total_supply and holder_count incrementally
  -- (cheaper than re-counting on every read; the table can grow to many tens of
  -- thousands of holders for a token with airdrops). PRIMARY KEY=1 enforces
  -- the singleton.
  CREATE TABLE IF NOT EXISTS ants_supply (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    total_supply      TEXT NOT NULL DEFAULT '0',
    holder_count      INTEGER NOT NULL DEFAULT 0,
    last_updated_block INTEGER
  );

  -- Bucketed snapshot for the supply chart. Same idempotency story as
  -- network_history (INSERT OR IGNORE on ts PK).
  CREATE TABLE IF NOT EXISTS ants_supply_history (
    ts            INTEGER PRIMARY KEY,
    total_supply  TEXT NOT NULL,
    holder_count  INTEGER NOT NULL
  );

  -- ERC-8004 ReputationRegistry rollups. Composite PK matches the on-chain
  -- uniqueness contract: a single agent receives one feedback row per
  -- (clientAddress, feedbackIndex). Updates from ResponseAppended /
  -- FeedbackRevoked write back to the same row.
  CREATE TABLE IF NOT EXISTS reputation_feedback (
    agent_id           INTEGER NOT NULL,
    client_address     TEXT    NOT NULL,
    feedback_index     INTEGER NOT NULL,
    value              TEXT    NOT NULL,    -- int128 stringified, may be negative
    value_decimals     INTEGER NOT NULL,
    tag1               TEXT    NOT NULL,
    tag2               TEXT    NOT NULL,
    endpoint           TEXT    NOT NULL,
    feedback_uri       TEXT    NOT NULL,
    feedback_hash      TEXT    NOT NULL,
    block_number       INTEGER NOT NULL,
    block_timestamp    INTEGER,
    tx_hash            TEXT    NOT NULL,
    revoked            INTEGER NOT NULL DEFAULT 0,
    revoked_at_block   INTEGER,
    response_uri       TEXT,
    response_hash      TEXT,
    response_responder TEXT,
    response_at_block  INTEGER,
    PRIMARY KEY (agent_id, client_address, feedback_index)
  );

  CREATE INDEX IF NOT EXISTS idx_reputation_feedback_agent
    ON reputation_feedback (agent_id, block_number DESC);
  CREATE INDEX IF NOT EXISTS idx_reputation_feedback_block
    ON reputation_feedback (block_number DESC);

  -- Per-agent rollup. Counts kept incrementally so /reputation/leaderboard
  -- can rank without scanning the full feedback table.
  CREATE TABLE IF NOT EXISTS reputation_agent_totals (
    agent_id            INTEGER PRIMARY KEY,
    feedback_count      INTEGER NOT NULL DEFAULT 0,
    revoked_count       INTEGER NOT NULL DEFAULT 0,
    response_count      INTEGER NOT NULL DEFAULT 0,
    unique_clients      INTEGER NOT NULL DEFAULT 0,
    first_feedback_block INTEGER,
    last_feedback_block  INTEGER
  );
`;

interface PriceVolatilityDbRow {
  peer_id: string;
  provider: string;
  service: string;
  sample_count: number;
  change_count: number;
  first_ts: number;
  last_ts: number;
  first_input: number;
  first_output: number;
  latest_input: number;
  latest_output: number;
}

interface PriceSampleRow {
  ts: number;
  input_usd_per_million: number;
  output_usd_per_million: number;
  cached_input_usd_per_million: number | null;
}

interface CountByAgent { agent_id: number; c: number }
interface CountResult { c: number }
interface CheckpointRow { last_block: number; last_block_timestamp: number | null }

/**
 * All prepared statements compiled once per store. Lifting them out of the
 * class body keeps the class focused on its public methods and isolates the
 * SQL surface in one place.
 */
interface Statements {
  selectCheckpoint: Database.Statement<[string, string], CheckpointRow>;
  upsertCheckpoint: Database.Statement<[string, string, number, number | null]>;

  selectSeller: Database.Statement<[number], SellerRow>;
  upsertSeller: Database.Statement<[number, string, string, string, number, number, number, number | null, number | null, number]>;
  selectSellerTotals: Database.Statement<[number], SellerTotalsRow>;
  selectAllSellerTotalsWithIds: Database.Statement<[], SellerTotalsRow & { agent_id: number }>;

  selectBuyer: Database.Statement<[number, string], AggregateRow>;
  upsertBuyer: Database.Statement<[number, string, string, string, string, number, number, number]>;
  countBuyersAll: Database.Statement<[], CountByAgent>;
  countBuyers: Database.Statement<[number], CountResult>;

  selectChannel: Database.Statement<[number, string], AggregateRow & { buyer: string }>;
  upsertChannel: Database.Statement<[number, string, string, string, string, string, number, number, number]>;
  countChannelsAll: Database.Statement<[], CountByAgent>;
  countChannels: Database.Statement<[number], CountResult>;

  insertHistory: Database.Statement<[number, number, number, string, string, string, number]>;
  selectHistorySince: Database.Statement<[number], HistoryRow>;
  selectEarliestHistoryTs: Database.Statement<[], { ts: number | null }>;
  selectLatestHistoryAtOrBefore: Database.Statement<
    [number],
    Pick<HistoryRow, 'total_requests' | 'total_input_tokens' | 'total_output_tokens' | 'settlement_count'>
  >;

  selectLatestPriceSample: Database.Statement<[string, string, string], PriceSampleRow>;
  insertPriceSample: Database.Statement<[string, string, string, number, number, number, number | null]>;
  selectPriceVolatility: Database.Statement<[number, number, number], PriceVolatilityDbRow>;

  selectLatestSellerActivity: Database.Statement<[number], Omit<SellerActivityDbRow, 'agent_id'>>;
  selectLatestSellerActivityAtOrBefore: Database.Statement<[number, number], SellerActivityDbRow>;
  insertSellerActivity: Database.Statement<[number, number, string, string, string, number]>;
  selectSellerActivitySince: Database.Statement<[number], SellerActivityDbRow>;

  insertChainEvent: Database.Statement<
    [string, string, number, number | null, string, number, string, string]
  >;

  selectAntsHolder: Database.Statement<[string], AntsHolderRow>;
  upsertAntsHolder: Database.Statement<[string, string, number, number]>;
  deleteAntsHolder: Database.Statement<[string]>;
  selectTopAntsHolders: Database.Statement<[number], AntsHolderRow>;
  countAntsHolders: Database.Statement<[], CountResult>;
  selectAntsSupply: Database.Statement<[], AntsSupplyRow>;
  upsertAntsSupply: Database.Statement<[string, number, number | null]>;
  insertAntsSupplyHistory: Database.Statement<[number, string, number]>;
  selectAntsSupplyHistorySince: Database.Statement<[number], AntsSupplyHistoryDbRow>;
  selectLatestAntsSupplyHistory: Database.Statement<[], AntsSupplyHistoryDbRow>;

  selectReputationFeedback: Database.Statement<[number, string, number], ReputationFeedbackDbRow>;
  insertReputationFeedback: Database.Statement<
    [number, string, number, string, number, string, string, string, string, string,
     number, number | null, string]
  >;
  markReputationFeedbackRevoked: Database.Statement<[number, number, string, number]>;
  appendReputationResponse: Database.Statement<[string, string, string, number, number, string, number]>;
  selectReputationFeedbackByAgent: Database.Statement<[number, number], ReputationFeedbackDbRow>;
  selectReputationFeedbackRecent: Database.Statement<[number], ReputationFeedbackDbRow>;
  selectReputationTotals: Database.Statement<[number], ReputationTotalsDbRow>;
  upsertReputationTotals: Database.Statement<
    [number, number, number, number, number, number | null, number | null]
  >;
  selectReputationLeaderboard: Database.Statement<[number], ReputationTotalsDbRow>;
  countReputationFeedbackForAgentClient: Database.Statement<[number, string], CountResult>;
}

function prepareStatements(db: Database.Database): Statements {
  return {
    selectCheckpoint: db.prepare(
      'SELECT last_block, last_block_timestamp FROM indexer_checkpoint WHERE chain_id = ? AND contract_address = ?',
    ),
    upsertCheckpoint: db.prepare(
      `INSERT INTO indexer_checkpoint (chain_id, contract_address, last_block, last_block_timestamp)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id, contract_address) DO UPDATE SET
         last_block = excluded.last_block,
         last_block_timestamp = excluded.last_block_timestamp`,
    ),

    selectSeller: db.prepare(
      `SELECT total_input_tokens, total_output_tokens, total_request_count, settlement_count,
              first_settled_block, first_seen_at, last_seen_at
         FROM seller_metadata_totals WHERE agent_id = ?`,
    ),
    upsertSeller: db.prepare(
      `INSERT OR REPLACE INTO seller_metadata_totals
         (agent_id, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block,
          first_seen_at, last_seen_at, last_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    selectSellerTotals: db.prepare(
      `SELECT total_request_count, total_input_tokens, total_output_tokens, settlement_count,
              first_settled_block, last_settled_block, first_seen_at, last_seen_at, last_updated_at
         FROM seller_metadata_totals WHERE agent_id = ?`,
    ),
    selectAllSellerTotalsWithIds: db.prepare(
      `SELECT agent_id, total_request_count, total_input_tokens, total_output_tokens, settlement_count,
              first_settled_block, last_settled_block, first_seen_at, last_seen_at, last_updated_at
         FROM seller_metadata_totals`,
    ),

    selectBuyer: db.prepare(
      `SELECT total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block
         FROM seller_buyer_totals WHERE agent_id = ? AND buyer = ?`,
    ),
    upsertBuyer: db.prepare(
      `INSERT OR REPLACE INTO seller_buyer_totals
         (agent_id, buyer, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    countBuyersAll: db.prepare('SELECT agent_id, COUNT(*) AS c FROM seller_buyer_totals GROUP BY agent_id'),
    countBuyers: db.prepare('SELECT COUNT(*) AS c FROM seller_buyer_totals WHERE agent_id = ?'),

    selectChannel: db.prepare(
      `SELECT buyer, total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block
         FROM seller_channel_totals WHERE agent_id = ? AND channel_id = ?`,
    ),
    upsertChannel: db.prepare(
      `INSERT OR REPLACE INTO seller_channel_totals
         (agent_id, channel_id, buyer, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    countChannelsAll: db.prepare('SELECT agent_id, COUNT(*) AS c FROM seller_channel_totals GROUP BY agent_id'),
    countChannels: db.prepare('SELECT COUNT(*) AS c FROM seller_channel_totals WHERE agent_id = ?'),

    insertHistory: db.prepare(
      `INSERT OR IGNORE INTO network_history
         (ts, active_peers, seller_count, total_requests,
          total_input_tokens, total_output_tokens, settlement_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    selectHistorySince: db.prepare(
      `SELECT ts, active_peers, seller_count, total_requests,
              total_input_tokens, total_output_tokens, settlement_count
         FROM network_history WHERE ts >= ? ORDER BY ts ASC`,
    ),
    selectEarliestHistoryTs: db.prepare('SELECT MIN(ts) AS ts FROM network_history'),
    selectLatestHistoryAtOrBefore: db.prepare(
      `SELECT total_requests, total_input_tokens, total_output_tokens, settlement_count
         FROM network_history WHERE ts <= ? ORDER BY ts DESC LIMIT 1`,
    ),

    selectLatestPriceSample: db.prepare(
      `SELECT ts, input_usd_per_million, output_usd_per_million, cached_input_usd_per_million
         FROM peer_pricing_history
        WHERE peer_id = ? AND provider = ? AND service = ?
        ORDER BY ts DESC LIMIT 1`,
    ),
    insertPriceSample: db.prepare(
      `INSERT OR IGNORE INTO peer_pricing_history
         (peer_id, provider, service, ts, input_usd_per_million,
          output_usd_per_million, cached_input_usd_per_million)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    // Per-(peer, provider, service) rollup. `change_count` counts distinct
    // (input, output) tuples — a peer that posted (1,2) (1,2) (3,4) (3,4)
    // has changeCount=2. The four correlated subqueries pick out the first/
    // latest sample inside the window so callers can compute % change.
    selectPriceVolatility: db.prepare(
      `SELECT
         peer_id, provider, service,
         COUNT(*) AS sample_count,
         COUNT(DISTINCT input_usd_per_million || '|' || output_usd_per_million) AS change_count,
         MIN(ts) AS first_ts, MAX(ts) AS last_ts,
         (SELECT input_usd_per_million FROM peer_pricing_history p2
            WHERE p2.peer_id = p1.peer_id AND p2.provider = p1.provider
              AND p2.service = p1.service AND p2.ts >= ?
            ORDER BY ts ASC LIMIT 1) AS first_input,
         (SELECT output_usd_per_million FROM peer_pricing_history p2
            WHERE p2.peer_id = p1.peer_id AND p2.provider = p1.provider
              AND p2.service = p1.service AND p2.ts >= ?
            ORDER BY ts ASC LIMIT 1) AS first_output,
         (SELECT input_usd_per_million FROM peer_pricing_history p2
            WHERE p2.peer_id = p1.peer_id AND p2.provider = p1.provider
              AND p2.service = p1.service
            ORDER BY ts DESC LIMIT 1) AS latest_input,
         (SELECT output_usd_per_million FROM peer_pricing_history p2
            WHERE p2.peer_id = p1.peer_id AND p2.provider = p1.provider
              AND p2.service = p1.service
            ORDER BY ts DESC LIMIT 1) AS latest_output
       FROM peer_pricing_history p1
       WHERE ts >= ?
       GROUP BY peer_id, provider, service`,
    ),

    selectLatestSellerActivity: db.prepare(
      `SELECT ts, total_requests, total_input_tokens, total_output_tokens, settlement_count
         FROM seller_activity_history WHERE agent_id = ? ORDER BY ts DESC LIMIT 1`,
    ),
    selectLatestSellerActivityAtOrBefore: db.prepare(
      `SELECT agent_id, ts, total_requests, total_input_tokens, total_output_tokens, settlement_count
         FROM seller_activity_history WHERE agent_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
    ),
    insertSellerActivity: db.prepare(
      `INSERT OR IGNORE INTO seller_activity_history
         (agent_id, ts, total_requests, total_input_tokens, total_output_tokens, settlement_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    selectSellerActivitySince: db.prepare(
      `SELECT agent_id, ts, total_requests, total_input_tokens, total_output_tokens, settlement_count
         FROM seller_activity_history WHERE ts >= ? ORDER BY agent_id ASC, ts ASC`,
    ),

    insertChainEvent: db.prepare(
      `INSERT OR IGNORE INTO chain_events
         (chain_id, contract_address, block_number, block_timestamp,
          tx_hash, log_index, event_name, args_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),

    selectAntsHolder: db.prepare(
      `SELECT address, balance, first_seen_block, last_tx_block
         FROM ants_holder_balances WHERE address = ?`,
    ),
    upsertAntsHolder: db.prepare(
      `INSERT INTO ants_holder_balances (address, balance, first_seen_block, last_tx_block)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         balance = excluded.balance,
         last_tx_block = excluded.last_tx_block`,
    ),
    deleteAntsHolder: db.prepare(
      `DELETE FROM ants_holder_balances WHERE address = ?`,
    ),
    // Sorting bigint TEXT in SQL would need lexicographic-by-pad-width tricks
    // — instead we read all non-zero rows and sort in JS. Holder count for
    // ANTS is on the order of 10^4 even after airdrops; sort cost is trivial
    // and the read is cached behind the response cache. Worst case: one full
    // table scan per /ants/holders cache miss.
    selectTopAntsHolders: db.prepare(
      `SELECT address, balance, first_seen_block, last_tx_block
         FROM ants_holder_balances
        ORDER BY LENGTH(balance) DESC, balance DESC
        LIMIT ?`,
    ),
    countAntsHolders: db.prepare(
      `SELECT COUNT(*) AS c FROM ants_holder_balances`,
    ),
    selectAntsSupply: db.prepare(
      `SELECT total_supply, holder_count, last_updated_block
         FROM ants_supply WHERE id = 1`,
    ),
    upsertAntsSupply: db.prepare(
      `INSERT INTO ants_supply (id, total_supply, holder_count, last_updated_block)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         total_supply = excluded.total_supply,
         holder_count = excluded.holder_count,
         last_updated_block = excluded.last_updated_block`,
    ),
    insertAntsSupplyHistory: db.prepare(
      `INSERT OR IGNORE INTO ants_supply_history (ts, total_supply, holder_count)
       VALUES (?, ?, ?)`,
    ),
    selectAntsSupplyHistorySince: db.prepare(
      `SELECT ts, total_supply, holder_count
         FROM ants_supply_history WHERE ts >= ? ORDER BY ts ASC`,
    ),
    selectLatestAntsSupplyHistory: db.prepare(
      `SELECT ts, total_supply, holder_count
         FROM ants_supply_history ORDER BY ts DESC LIMIT 1`,
    ),

    selectReputationFeedback: db.prepare(
      `SELECT agent_id, client_address, feedback_index, value, value_decimals,
              tag1, tag2, endpoint, feedback_uri, feedback_hash,
              block_number, block_timestamp, tx_hash,
              revoked, revoked_at_block,
              response_uri, response_hash, response_responder, response_at_block
         FROM reputation_feedback
        WHERE agent_id = ? AND client_address = ? AND feedback_index = ?`,
    ),
    insertReputationFeedback: db.prepare(
      `INSERT OR IGNORE INTO reputation_feedback
         (agent_id, client_address, feedback_index, value, value_decimals,
          tag1, tag2, endpoint, feedback_uri, feedback_hash,
          block_number, block_timestamp, tx_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    markReputationFeedbackRevoked: db.prepare(
      `UPDATE reputation_feedback
          SET revoked = 1, revoked_at_block = ?
        WHERE agent_id = ? AND client_address = ? AND feedback_index = ?`,
    ),
    appendReputationResponse: db.prepare(
      `UPDATE reputation_feedback
          SET response_uri = ?, response_hash = ?, response_responder = ?, response_at_block = ?
        WHERE agent_id = ? AND client_address = ? AND feedback_index = ?`,
    ),
    selectReputationFeedbackByAgent: db.prepare(
      `SELECT agent_id, client_address, feedback_index, value, value_decimals,
              tag1, tag2, endpoint, feedback_uri, feedback_hash,
              block_number, block_timestamp, tx_hash,
              revoked, revoked_at_block,
              response_uri, response_hash, response_responder, response_at_block
         FROM reputation_feedback
        WHERE agent_id = ?
        ORDER BY block_number DESC, feedback_index DESC
        LIMIT ?`,
    ),
    selectReputationFeedbackRecent: db.prepare(
      `SELECT agent_id, client_address, feedback_index, value, value_decimals,
              tag1, tag2, endpoint, feedback_uri, feedback_hash,
              block_number, block_timestamp, tx_hash,
              revoked, revoked_at_block,
              response_uri, response_hash, response_responder, response_at_block
         FROM reputation_feedback
        ORDER BY block_number DESC, feedback_index DESC
        LIMIT ?`,
    ),
    selectReputationTotals: db.prepare(
      `SELECT agent_id, feedback_count, revoked_count, response_count, unique_clients,
              first_feedback_block, last_feedback_block
         FROM reputation_agent_totals WHERE agent_id = ?`,
    ),
    upsertReputationTotals: db.prepare(
      `INSERT INTO reputation_agent_totals
         (agent_id, feedback_count, revoked_count, response_count, unique_clients,
          first_feedback_block, last_feedback_block)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         feedback_count = excluded.feedback_count,
         revoked_count = excluded.revoked_count,
         response_count = excluded.response_count,
         unique_clients = excluded.unique_clients,
         first_feedback_block = excluded.first_feedback_block,
         last_feedback_block = excluded.last_feedback_block`,
    ),
    selectReputationLeaderboard: db.prepare(
      `SELECT agent_id, feedback_count, revoked_count, response_count, unique_clients,
              first_feedback_block, last_feedback_block
         FROM reputation_agent_totals
        ORDER BY (feedback_count - revoked_count) DESC, last_feedback_block DESC
        LIMIT ?`,
    ),
    // Used to detect "first feedback from this client for this agent" so the
    // unique_clients bump is correct. A row count of 0 (other than the one
    // we're about to insert) means this is a new client→agent relationship.
    countReputationFeedbackForAgentClient: db.prepare(
      `SELECT COUNT(*) AS c FROM reputation_feedback WHERE agent_id = ? AND client_address = ?`,
    ),
  };
}

// ── pure row → domain converters ───────────────────────────────────────────

function rowToSellerTotals(
  row: SellerTotalsRow,
  uniqueBuyers: number,
  uniqueChannels: number,
): SellerTotals {
  const totalRequests = BigInt(row.total_request_count);
  return {
    totalRequests,
    totalInputTokens: BigInt(row.total_input_tokens),
    totalOutputTokens: BigInt(row.total_output_tokens),
    settlementCount: row.settlement_count,
    firstSettledBlock: row.first_settled_block ?? 0,
    lastSettledBlock: row.last_settled_block ?? 0,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    uniqueBuyers,
    uniqueChannels,
    avgRequestsPerBuyer: uniqueBuyers === 0 ? 0 : Number(totalRequests / BigInt(uniqueBuyers)),
    avgRequestsPerChannel: uniqueChannels === 0 ? 0 : Number(totalRequests / BigInt(uniqueChannels)),
    lastUpdatedAt: row.last_updated_at,
  };
}

function rowToChainEvent(row: ChainEventDbRow): ChainEventRow {
  // Trust the writer to have produced valid JSON. A malformed row points to a
  // bug or manual tampering — surface it loudly rather than silently skipping.
  const args = JSON.parse(row.args_json) as Record<string, unknown>;
  return {
    chainId: row.chain_id,
    contractAddress: row.contract_address,
    blockNumber: row.block_number,
    blockTimestamp: row.block_timestamp,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    eventName: row.event_name,
    args,
  };
}

function rowToReputationFeedback(row: ReputationFeedbackDbRow): ReputationFeedbackRow {
  return {
    agentId: row.agent_id,
    clientAddress: row.client_address,
    feedbackIndex: row.feedback_index,
    value: BigInt(row.value),
    valueDecimals: row.value_decimals,
    tag1: row.tag1,
    tag2: row.tag2,
    endpoint: row.endpoint,
    feedbackURI: row.feedback_uri,
    feedbackHash: row.feedback_hash,
    blockNumber: row.block_number,
    blockTimestamp: row.block_timestamp,
    txHash: row.tx_hash,
    revoked: row.revoked === 1,
    revokedAtBlock: row.revoked_at_block,
    responseURI: row.response_uri,
    responseHash: row.response_hash,
    responseResponder: row.response_responder,
    responseAtBlock: row.response_at_block,
  };
}

function rowToSellerActivity(row: SellerActivityDbRow): SellerActivityRow {
  return {
    agentId: row.agent_id,
    ts: row.ts,
    totalRequests: BigInt(row.total_requests),
    totalInputTokens: BigInt(row.total_input_tokens),
    totalOutputTokens: BigInt(row.total_output_tokens),
    settlementCount: row.settlement_count,
  };
}

/**
 * Compute the new (input, output, request, settlement, firstBlock) tuple after
 * applying one settlement event to a buyer- or channel-scoped aggregate row.
 * Used inside applyBatch's atomic transaction; pure so it's trivial to reason
 * about under rollback.
 */
function mergeAggregate(
  prev: AggregateRow | undefined,
  ev: DecodedMetadataRecorded,
): {
  inputTokens: bigint;
  outputTokens: bigint;
  requestCount: bigint;
  settlementCount: number;
  firstBlock: number;
} {
  return {
    inputTokens: (prev ? BigInt(prev.total_input_tokens) : 0n) + ev.inputTokens,
    outputTokens: (prev ? BigInt(prev.total_output_tokens) : 0n) + ev.outputTokens,
    requestCount: (prev ? BigInt(prev.total_request_count) : 0n) + ev.requestCount,
    settlementCount: (prev?.settlement_count ?? 0) + 1,
    firstBlock: prev?.first_settled_block ?? ev.blockNumber,
  };
}

export class SqliteStore {
  // The store.test.ts table-listing assertion peeks at this field name via a
  // structural cast; renaming would silently break that test path.
  private db: Database.Database;
  private statements!: Statements;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  /** Creates tables if missing and compiles prepared statements. Idempotent. */
  init(): void {
    this.db.exec(SCHEMA);
    this.statements = prepareStatements(this.db);
  }

  /**
   * Earliest history sample timestamp (unix seconds), or null if the table is
   * empty. Used by the backfill driver to decide whether to re-fetch chain
   * events: if we already have history reaching back further than the cutoff,
   * skip the backfill.
   */
  getEarliestHistoryTs(): number | null {
    return this.statements.selectEarliestHistoryTs.get()?.ts ?? null;
  }

  /** Returns last indexed block for (chainId, contractAddress), or null if no checkpoint. */
  getCheckpoint(chainId: string, contractAddress: string): number | null {
    const row = this.statements.selectCheckpoint.get(chainId, contractAddress.toLowerCase());
    return row ? row.last_block : null;
  }

  /**
   * Atomic transaction:
   *   1. For each event, upsert seller_metadata_totals (add deltas, track first/last block, bump count).
   *   2. Upsert seller_buyer_totals for (agentId, buyer) with the same deltas.
   *   3. Upsert seller_channel_totals for (agentId, channelId) with the same deltas.
   *   4. Advance indexer_checkpoint.last_block = newCheckpoint for this (chainId, contractAddress).
   * If any step throws, the transaction is rolled back — next tick re-fetches the same range.
   *
   * Events MUST be sorted ascending by (blockNumber, logIndex) — StatsClient guarantees this.
   * first_settled_block is set only on first insert and never overwritten; last_settled_block is
   * always set to the current event's block (monotonically non-decreasing given the sort order).
   */
  applyBatch(
    chainId: string,
    contractAddress: string,
    events: DecodedMetadataRecorded[],
    newCheckpoint: number,
    blockTimestamps?: Map<number, number>,
    newCheckpointTimestamp?: number | null,
  ): void {
    const s = this.statements;
    this.db.transaction(() => {
      for (const event of events) {
        // uint256 → number narrowing. agentIds are sequential and small in practice,
        // but the ERC-8004 IdentityRegistry is uint256, so guard against a pathological
        // future value that would silently collide or miss the PK lookup.
        if (event.agentId > BigInt(Number.MAX_SAFE_INTEGER)) {
          console.warn(`[store] agentId ${event.agentId} exceeds MAX_SAFE_INTEGER — skipping event`);
          continue;
        }
        const agentId = Number(event.agentId);
        const buyer = event.buyer.toLowerCase();
        const channelId = event.channelId.toLowerCase();
        const eventTimestamp = blockTimestamps?.get(event.blockNumber) ?? null;
        const now = Math.floor(Date.now() / 1000);

        // ── seller_metadata_totals ───────────────────────────────────
        const prevSeller = s.selectSeller.get(agentId);
        const prevSellerInput = prevSeller ? BigInt(prevSeller.total_input_tokens) : 0n;
        const prevSellerOutput = prevSeller ? BigInt(prevSeller.total_output_tokens) : 0n;
        const prevSellerCount = prevSeller ? BigInt(prevSeller.total_request_count) : 0n;
        // Events arrive sorted by (blockNumber, logIndex), so the current event's
        // block is always >= the stored last_seen_at — no max() needed.
        const firstSeenAt = prevSeller?.first_seen_at ?? eventTimestamp;
        const lastSeenAt = eventTimestamp ?? prevSeller?.last_seen_at ?? null;

        s.upsertSeller.run(
          agentId,
          (prevSellerInput + event.inputTokens).toString(),
          (prevSellerOutput + event.outputTokens).toString(),
          (prevSellerCount + event.requestCount).toString(),
          (prevSeller?.settlement_count ?? 0) + 1,
          prevSeller?.first_settled_block ?? event.blockNumber,
          event.blockNumber,
          firstSeenAt,
          lastSeenAt,
          now,
        );

        // ── seller_buyer_totals ──────────────────────────────────────
        const buyerNext = mergeAggregate(s.selectBuyer.get(agentId, buyer), event);
        s.upsertBuyer.run(
          agentId,
          buyer,
          buyerNext.inputTokens.toString(),
          buyerNext.outputTokens.toString(),
          buyerNext.requestCount.toString(),
          buyerNext.settlementCount,
          buyerNext.firstBlock,
          event.blockNumber,
        );

        // ── seller_channel_totals ────────────────────────────────────
        const channelNext = mergeAggregate(s.selectChannel.get(agentId, channelId), event);
        s.upsertChannel.run(
          agentId,
          channelId,
          buyer,
          channelNext.inputTokens.toString(),
          channelNext.outputTokens.toString(),
          channelNext.requestCount.toString(),
          channelNext.settlementCount,
          channelNext.firstBlock,
          event.blockNumber,
        );

        // ── chain_events (raw decoded log) ───────────────────────────
        // Same row the explorer's activity feed reads from. Lives in the
        // same transaction as the rollups so a rolled-back batch doesn't
        // leak orphaned events into the feed. INSERT OR IGNORE makes
        // indexer replays idempotent — the (chain_id, contract_address,
        // block_number, log_index) PK is enough to dedup.
        s.insertChainEvent.run(
          chainId,
          contractAddress.toLowerCase(),
          event.blockNumber,
          eventTimestamp,
          event.txHash,
          event.logIndex,
          'MetadataRecorded',
          JSON.stringify({
            agentId: event.agentId.toString(),
            buyer,
            channelId,
            metadataHash: event.metadataHash,
            inputTokens: event.inputTokens.toString(),
            outputTokens: event.outputTokens.toString(),
            requestCount: event.requestCount.toString(),
          }),
        );
      }

      s.upsertCheckpoint.run(
        chainId,
        contractAddress.toLowerCase(),
        newCheckpoint,
        newCheckpointTimestamp ?? null,
      );
    })();
  }

  /** Returns last indexed block + block timestamp, or null if no checkpoint. */
  getCheckpointInfo(
    chainId: string,
    contractAddress: string,
  ): { lastBlock: number; lastBlockTimestamp: number | null } | null {
    const row = this.statements.selectCheckpoint.get(chainId, contractAddress.toLowerCase());
    return row ? { lastBlock: row.last_block, lastBlockTimestamp: row.last_block_timestamp } : null;
  }

  /** Returns cumulative totals for a single agentId, or null if never seen. */
  getSellerTotals(agentId: number): SellerTotals | null {
    const row = this.statements.selectSellerTotals.get(agentId);
    if (!row) return null;
    const uniqueBuyers = this.statements.countBuyers.get(agentId)?.c ?? 0;
    const uniqueChannels = this.statements.countChannels.get(agentId)?.c ?? 0;
    return rowToSellerTotals(row, uniqueBuyers, uniqueChannels);
  }

  /**
   * Returns one row per indexed seller, keyed by agentId, with the same
   * derived fields exposed via `getSellerTotals` (uniqueBuyers/Channels and
   * avgRequestsPerBuyer/Channel). Two GROUP BY queries pre-fetch the buyer/
   * channel counts so the per-row work is O(1) lookups instead of N+1 SELECTs.
   *
   * Used by the insights endpoint to build cross-network leaderboards (most
   * active, most settlements, biggest customer base, etc.) in a single pass.
   */
  getAllSellerTotalsWithIds(): SellerTotalsWithId[] {
    const buyerCounts = new Map<number, number>();
    for (const row of this.statements.countBuyersAll.all()) buyerCounts.set(row.agent_id, row.c);
    const channelCounts = new Map<number, number>();
    for (const row of this.statements.countChannelsAll.all()) channelCounts.set(row.agent_id, row.c);

    return this.statements.selectAllSellerTotalsWithIds.all().map((row) => ({
      agentId: row.agent_id,
      ...rowToSellerTotals(row, buyerCounts.get(row.agent_id) ?? 0, channelCounts.get(row.agent_id) ?? 0),
    }));
  }

  /**
   * Raw `network_history` rows from the last `secondsAgo` seconds, ordered
   * ascending by ts. Used by the insights endpoint to compute network velocity
   * (24h / 7d deltas) without re-implementing the bucketing logic.
   */
  getHistorySince(secondsAgo: number, nowSeconds: number = Math.floor(Date.now() / 1000)): HistorySample[] {
    return this.statements.selectHistorySince.all(nowSeconds - secondsAgo).map((row) => ({
      ts: row.ts,
      activePeers: row.active_peers,
      sellerCount: row.seller_count,
      totalRequests: BigInt(row.total_requests),
      totalInputTokens: BigInt(row.total_input_tokens),
      totalOutputTokens: BigInt(row.total_output_tokens),
      settlementCount: row.settlement_count,
    }));
  }

  /**
   * Cumulative totals across all indexed sellers, including those not currently
   * online. Computed by walking every row in JS rather than `SELECT SUM(...)`
   * because the cumulative columns are stored as TEXT bigints — SQLite's SUM
   * would silently overflow at 2^63 on values the test suite explicitly exercises.
   */
  getNetworkTotals(): NetworkTotals {
    let totalRequests = 0n;
    let totalInputTokens = 0n;
    let totalOutputTokens = 0n;
    let settlementCount = 0;
    let sellerCount = 0;
    let lastUpdatedAt: number | null = null;

    for (const row of this.statements.selectAllSellerTotalsWithIds.all()) {
      totalRequests += BigInt(row.total_request_count);
      totalInputTokens += BigInt(row.total_input_tokens);
      totalOutputTokens += BigInt(row.total_output_tokens);
      settlementCount += row.settlement_count;
      sellerCount += 1;
      lastUpdatedAt = Math.max(lastUpdatedAt ?? 0, row.last_updated_at);
    }

    return { totalRequests, totalInputTokens, totalOutputTokens, settlementCount, sellerCount, lastUpdatedAt };
  }

  /**
   * Append one history sample. INSERT OR IGNORE — if two writes land in the
   * same second (poll retry, clock jitter), the first wins and the second is
   * silently dropped. The poller cadence is 15 minutes, so collisions are rare
   * enough that overwrite-vs-keep doesn't change any chart.
   *
   * Monotonicity guard: cumulative totals only ever go up — settlements are
   * append-only on-chain. If a new sample's cum is below the most recent
   * stored row's cum, the writer is reading from a temporarily-behind source
   * (live sampler racing the indexer's catch-up to the backfill). Dropping
   * keeps the table monotonic-by-ts so velocity windows can't compute negative
   * deltas. Returns true if the row was written, false if dropped.
   */
  recordHistorySample(sample: HistorySample): { written: boolean } {
    const prior = this.statements.selectLatestHistoryAtOrBefore.get(sample.ts);
    if (prior && wouldRegress(sample, prior)) return { written: false };

    this.statements.insertHistory.run(
      sample.ts,
      sample.activePeers,
      sample.sellerCount,
      sample.totalRequests.toString(),
      sample.totalInputTokens.toString(),
      sample.totalOutputTokens.toString(),
      sample.settlementCount,
    );
    return { written: true };
  }

  /**
   * Bucketed history for the dashboard chart.
   *
   * - 1d  → 1h buckets
   * - 7d  → 1d buckets
   * - 30d → 1d buckets
   *
   * activePeers is a gauge — we report the LAST sample in each bucket
   * ("what was it at close-of-bucket"). requests/settlements are cumulative
   * counters, so per-bucket values are computed as deltas: the bucket's last
   * cumulative minus the previous bucket's last cumulative. The first bucket
   * uses its own first sample as the baseline (so it shows "growth within
   * the bucket"), which under-counts only the first bucket of the range and
   * is the simplest behavior that doesn't require fetching pre-range data.
   */
  getHistory(range: HistoryRange, nowSeconds: number = Math.floor(Date.now() / 1000)): HistoryResponse {
    const bucketSeconds = range === '1d' ? 3600 : 86400;
    const rangeSeconds = range === '1d' ? 86400 : range === '7d' ? 86400 * 7 : 86400 * 30;
    const rows = this.statements.selectHistorySince.all(nowSeconds - rangeSeconds);
    return { range, bucketSeconds, points: bucketHistoryRows(rows, bucketSeconds) };
  }

  /**
   * Append a price sample for (peer, provider, service) — but only if it
   * differs from the most recent stored sample for the same key, or if the
   * latest identical row is older than the daily heartbeat interval. The point
   * is to keep `peer_pricing_history` mostly event-shaped while still proving
   * that a stable price was observed inside later insight windows.
   *
   * INSERT OR IGNORE handles the rare case that two writes land in the same
   * second — first wins, second is silently dropped via the ts PK component.
   */
  recordPriceSample(input: PriceSampleInput): void {
    const latest = this.statements.selectLatestPriceSample.get(input.peerId, input.provider, input.service);
    if (latest && isPriceSampleDuplicate(latest, input)) return;

    this.statements.insertPriceSample.run(
      input.peerId,
      input.provider,
      input.service,
      input.ts,
      input.inputUsdPerMillion,
      input.outputUsdPerMillion,
      input.cachedInputUsdPerMillion ?? null,
    );
  }

  /**
   * Append a per-seller activity snapshot — but only if cumulative totals
   * differ from the most recent stored sample for the agent. Idle sellers
   * therefore never inflate the table; active sellers get a row whenever a
   * new settlement lands. Trending derivations diff snapshots across windows.
   */
  recordSellerActivitySample(input: SellerActivitySnapshotInput): void {
    const latest = this.statements.selectLatestSellerActivity.get(input.agentId);
    if (latest && isSellerActivityDuplicate(latest, input)) return;

    this.statements.insertSellerActivity.run(
      input.agentId,
      input.ts,
      input.totalRequests.toString(),
      input.totalInputTokens.toString(),
      input.totalOutputTokens.toString(),
      input.settlementCount,
    );
  }

  /**
   * One row per (peer, provider, service) summarising pricing volatility over
   * `[since, now]`. `changeCount` counts distinct (input, output) tuples;
   * `firstInput/Output` is the earliest sample inside the window (so % change
   * vs window-start is computable client-side); `latestInput/Output` is the
   * most recent sample, which may be older than the window — that's the
   * point: stable pricing should still surface in the rollup.
   */
  getPriceVolatility(sinceSec: number): PriceVolatilityRow[] {
    return this.statements.selectPriceVolatility.all(sinceSec, sinceSec, sinceSec).map((row) => ({
      peerId: row.peer_id,
      provider: row.provider,
      service: row.service,
      sampleCount: row.sample_count,
      changeCount: row.change_count,
      firstTs: row.first_ts,
      lastTs: row.last_ts,
      firstInputUsdPerMillion: row.first_input,
      firstOutputUsdPerMillion: row.first_output,
      latestInputUsdPerMillion: row.latest_input,
      latestOutputUsdPerMillion: row.latest_output,
    }));
  }

  /**
   * All seller activity snapshots since `sinceSec`, sorted by (agentId, ts)
   * ascending — the shape the trending computation wants. Callers group by
   * agentId in JS to avoid building a window function per agent in SQL.
   */
  getSellerActivitySince(sinceSec: number): SellerActivityRow[] {
    return this.statements.selectSellerActivitySince.all(sinceSec).map(rowToSellerActivity);
  }

  /**
   * Activity rows for trend windows: all rows inside the current 8d window,
   * plus the latest pre-window baseline per agent. `computeTrending` needs
   * "at or before 8d ago"; a plain `WHERE ts >= cutoff` almost never includes
   * an exact boundary sample, so trending boards would otherwise be empty.
   */
  getSellerActivityForTrending(cutoffSec: number): SellerActivityRow[] {
    const recent = this.statements.selectSellerActivitySince.all(cutoffSec);
    const byKey = new Map<string, SellerActivityDbRow>();
    for (const row of recent) byKey.set(`${row.agent_id}:${row.ts}`, row);

    for (const agentId of new Set(recent.map((row) => row.agent_id))) {
      const baseline = this.statements.selectLatestSellerActivityAtOrBefore.get(agentId, cutoffSec);
      if (baseline) byKey.set(`${baseline.agent_id}:${baseline.ts}`, baseline);
    }

    return [...byKey.values()]
      .sort((a, b) => a.agent_id - b.agent_id || a.ts - b.ts)
      .map(rowToSellerActivity);
  }

  /**
   * Insert one decoded event into `chain_events`. Designed for `EventIndexer`
   * to call inside its tick transaction alongside the consumer-specific
   * rollup. INSERT OR IGNORE — a replay that re-fetches the same range is a
   * no-op rather than a constraint violation.
   */
  insertChainEvent(row: ChainEventInsert): void {
    this.statements.insertChainEvent.run(
      row.chainId,
      row.contractAddress.toLowerCase(),
      row.blockNumber,
      row.blockTimestamp,
      row.txHash,
      row.logIndex,
      row.eventName,
      JSON.stringify(row.args),
    );
  }

  /**
   * Atomic helper: insert many `chain_events` and run a consumer-specific
   * rollup callback inside one transaction. The callback is responsible for
   * applying its own rollup writes and returning the new checkpoint block;
   * the store handles row insertion + checkpoint advance. Used by
   * EventIndexer so its tick is one DB transaction.
   *
   * The `apply` callback gets called BEFORE the chain_events insert so it
   * can throw and abort the whole tx — including the rows it would have
   * shadowed in chain_events — without partial state ever landing.
   */
  applyChainEventBatch(opts: {
    chainId: string;
    contractAddress: string;
    rows: readonly ChainEventInsert[];
    newCheckpoint: number;
    newCheckpointTimestamp: number | null;
    apply?: () => void;
  }): void {
    const { chainId, contractAddress, rows, newCheckpoint, newCheckpointTimestamp, apply } = opts;
    const contract = contractAddress.toLowerCase();
    this.db.transaction(() => {
      apply?.();
      for (const row of rows) {
        this.statements.insertChainEvent.run(
          row.chainId,
          row.contractAddress.toLowerCase(),
          row.blockNumber,
          row.blockTimestamp,
          row.txHash,
          row.logIndex,
          row.eventName,
          JSON.stringify(row.args),
        );
      }
      this.statements.upsertCheckpoint.run(chainId, contract, newCheckpoint, newCheckpointTimestamp);
    })();
  }

  /**
   * Filter + paginate over `chain_events`. Returns rows newest-first by
   * (block_number, log_index) — the order the explorer's activity feed
   * wants. `beforeBlockNumber/beforeLogIndex` is a keyset cursor (use the
   * last row's coords from the prior page).
   *
   * Built ad-hoc rather than as a single prepared statement because the
   * filter set is sparse — every combination of `{chainId, contract, event,
   * tx, range}` would need its own statement, which gains nothing over
   * letting SQLite plan from `args`.
   */
  getChainEvents(query: ChainEventQuery): ChainEventRow[] {
    const limit = Math.min(query.limit ?? 50, MAX_CHAIN_EVENT_LIMIT);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.chainId !== undefined) {
      where.push('chain_id = ?');
      params.push(query.chainId);
    }
    if (query.contractAddress !== undefined) {
      where.push('contract_address = ?');
      params.push(query.contractAddress.toLowerCase());
    }
    if (query.eventName !== undefined) {
      where.push('event_name = ?');
      params.push(query.eventName);
    }
    if (query.txHash !== undefined) {
      where.push('tx_hash = ?');
      params.push(query.txHash.toLowerCase());
    }
    if (query.fromBlock !== undefined) {
      where.push('block_number >= ?');
      params.push(query.fromBlock);
    }
    if (query.toBlock !== undefined) {
      where.push('block_number <= ?');
      params.push(query.toBlock);
    }
    if (query.beforeBlockNumber !== undefined && query.beforeLogIndex !== undefined) {
      // Strict keyset: rows whose (block, logIndex) tuple is below the cursor.
      where.push('(block_number < ? OR (block_number = ? AND log_index < ?))');
      params.push(query.beforeBlockNumber, query.beforeBlockNumber, query.beforeLogIndex);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT chain_id, contract_address, block_number, block_timestamp,
             tx_hash, log_index, event_name, args_json
        FROM chain_events
        ${whereClause}
       ORDER BY block_number DESC, log_index DESC
       LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params, limit) as ChainEventDbRow[];
    return rows.map(rowToChainEvent);
  }

  /** Latest N rows across all contracts/events — the explorer homepage feed. */
  getRecentChainEvents(limit = 25): ChainEventRow[] {
    return this.getChainEvents({ limit });
  }

  /**
   * Apply a batch of ANTS Transfer events to `ants_holder_balances` and
   * `ants_supply`. Designed to be called from inside an outer transaction
   * (i.e. EventIndexer's `apply` callback) so the rollup, the chain_events
   * insert, and the checkpoint advance are one atomic unit.
   *
   * Mints (`from = 0x0`) and burns (`to = 0x0`) move total_supply; everyday
   * transfers don't. Holders that drop to balance=0 are deleted so the
   * `ants_supply.holder_count` stays a clean COUNT(*) without an
   * `IS NOT NULL`.
   */
  applyAntsTransfers(events: readonly AntsTransferEvent[]): void {
    if (events.length === 0) return;
    const s = this.statements;
    const supplyRow = s.selectAntsSupply.get();
    let totalSupply = supplyRow ? BigInt(supplyRow.total_supply) : 0n;
    let holderCount = supplyRow?.holder_count ?? 0;
    let lastUpdatedBlock = supplyRow?.last_updated_block ?? null;

    const applyDelta = (address: string, delta: bigint, block: number): void => {
      if (address === ZERO_ADDRESS) return;     // mint/burn handled at supply level
      const existing = s.selectAntsHolder.get(address);
      const prevBalance = existing ? BigInt(existing.balance) : 0n;
      const nextBalance = prevBalance + delta;
      // Negative balances mean the indexer drifted from chain reality (an
      // event was missed or applied twice). Surface loudly — the rest of
      // the rollup is now untrustworthy and a re-sync from a clean state
      // is the only safe recovery.
      if (nextBalance < 0n) {
        throw new Error(
          `[ants] negative balance for ${address}: ${prevBalance} + ${delta} = ${nextBalance}`,
        );
      }
      if (nextBalance === 0n) {
        if (existing) {
          s.deleteAntsHolder.run(address);
          holderCount -= 1;
        }
        return;
      }
      const firstSeen = existing?.first_seen_block ?? block;
      s.upsertAntsHolder.run(address, nextBalance.toString(), firstSeen, block);
      if (!existing) holderCount += 1;
    };

    for (const ev of events) {
      if (ev.from === ZERO_ADDRESS) totalSupply += ev.value;
      else applyDelta(ev.from, -ev.value, ev.blockNumber);

      if (ev.to === ZERO_ADDRESS) totalSupply -= ev.value;
      else applyDelta(ev.to, ev.value, ev.blockNumber);

      lastUpdatedBlock = ev.blockNumber;
    }

    s.upsertAntsSupply.run(totalSupply.toString(), holderCount, lastUpdatedBlock);
  }

  getAntsSupply(): AntsSupplySnapshot {
    const row = this.statements.selectAntsSupply.get();
    if (!row) return { totalSupply: 0n, holderCount: 0, lastUpdatedBlock: null };
    return {
      totalSupply: BigInt(row.total_supply),
      holderCount: row.holder_count,
      lastUpdatedBlock: row.last_updated_block,
    };
  }

  getTopAntsHolders(limit = 25): AntsHolderBalance[] {
    return this.statements.selectTopAntsHolders.all(Math.min(limit, 1000)).map((row) => ({
      address: row.address,
      balance: BigInt(row.balance),
      firstSeenBlock: row.first_seen_block,
      lastTxBlock: row.last_tx_block,
    }));
  }

  /**
   * Append a supply snapshot to `ants_supply_history`. Idempotent on `ts`
   * (INSERT OR IGNORE). Returns whether a row was actually inserted so the
   * caller can decide whether to bump the cache.
   */
  recordAntsSupplySample(ts: number, snapshot: AntsSupplySnapshot): { written: boolean } {
    const latest = this.statements.selectLatestAntsSupplyHistory.get();
    // Skip if the snapshot is byte-identical to the latest stored row — the
    // sampler runs every minute even when supply hasn't moved, and writing
    // duplicate rows pollutes the chart's "interesting" buckets.
    if (
      latest
      && latest.total_supply === snapshot.totalSupply.toString()
      && latest.holder_count === snapshot.holderCount
    ) {
      return { written: false };
    }
    this.statements.insertAntsSupplyHistory.run(
      ts,
      snapshot.totalSupply.toString(),
      snapshot.holderCount,
    );
    return { written: true };
  }

  getAntsSupplyHistory(secondsAgo: number, nowSeconds: number = Math.floor(Date.now() / 1000)): AntsSupplyHistoryPoint[] {
    return this.statements.selectAntsSupplyHistorySince.all(nowSeconds - secondsAgo).map((row) => ({
      ts: row.ts,
      totalSupply: BigInt(row.total_supply),
      holderCount: row.holder_count,
    }));
  }

  /**
   * Apply a batch of reputation events (NewFeedback / ResponseAppended /
   * FeedbackRevoked) to the rollup tables. Same atomicity story as
   * applyAntsTransfers — designed to run inside the EventIndexer's outer
   * transaction so all rollup writes commit/roll back as one unit.
   *
   * Events are applied in order. NewFeedback inserts the row; the response
   * + revoke events update it in place. If a response/revoke arrives before
   * its corresponding NewFeedback (impossible on chain, but defensive against
   * mid-tick re-ordering bugs), the update silently no-ops.
   */
  applyReputationEvents(events: readonly ReputationEvent[]): void {
    if (events.length === 0) return;
    const s = this.statements;

    // Track per-agent total deltas so we only do one read+upsert per agent
    // per batch instead of one per event. Map keyed by agentId; values are
    // partial counters that get applied to the persisted row at the end.
    interface PendingTotals {
      feedbackDelta: number;
      revokedDelta: number;
      responseDelta: number;
      uniqueClientsDelta: number;
      newFirstBlock: number | null;
      newLastBlock: number | null;
    }
    const pending = new Map<number, PendingTotals>();
    const ensure = (agentId: number): PendingTotals => {
      let p = pending.get(agentId);
      if (!p) {
        p = {
          feedbackDelta: 0,
          revokedDelta: 0,
          responseDelta: 0,
          uniqueClientsDelta: 0,
          newFirstBlock: null,
          newLastBlock: null,
        };
        pending.set(agentId, p);
      }
      return p;
    };

    for (const ev of events) {
      // BigInt → number narrowing — agentIds in ERC-8004 are sequential and
      // small; mirror MetadataIndexer's same guard.
      if (ev.agentId > BigInt(Number.MAX_SAFE_INTEGER)) {
        console.warn(`[reputation] agentId ${ev.agentId} exceeds MAX_SAFE_INTEGER — skipping`);
        continue;
      }
      const agentId = Number(ev.agentId);
      const client = ev.clientAddress.toLowerCase();
      const totals = ensure(agentId);

      switch (ev.kind) {
        case 'NewFeedback': {
          // Detect first-time client for this agent BEFORE the insert so the
          // count is right whether or not the insert short-circuits via
          // INSERT OR IGNORE on a re-applied batch.
          const priorCount = s.countReputationFeedbackForAgentClient.get(agentId, client)?.c ?? 0;
          s.insertReputationFeedback.run(
            agentId,
            client,
            ev.feedbackIndex,
            ev.value.toString(),
            ev.valueDecimals,
            ev.tag1,
            ev.tag2,
            ev.endpoint,
            ev.feedbackURI,
            ev.feedbackHash,
            ev.blockNumber,
            ev.blockTimestamp,
            ev.txHash,
          );
          totals.feedbackDelta += 1;
          if (priorCount === 0) totals.uniqueClientsDelta += 1;
          if (totals.newFirstBlock === null) totals.newFirstBlock = ev.blockNumber;
          totals.newLastBlock = ev.blockNumber;
          break;
        }
        case 'ResponseAppended': {
          s.appendReputationResponse.run(
            ev.responseURI,
            ev.responseHash,
            ev.responder.toLowerCase(),
            ev.blockNumber,
            agentId,
            client,
            ev.feedbackIndex,
          );
          totals.responseDelta += 1;
          totals.newLastBlock = ev.blockNumber;
          break;
        }
        case 'FeedbackRevoked': {
          s.markReputationFeedbackRevoked.run(
            ev.blockNumber,
            agentId,
            client,
            ev.feedbackIndex,
          );
          totals.revokedDelta += 1;
          totals.newLastBlock = ev.blockNumber;
          break;
        }
      }
    }

    for (const [agentId, p] of pending) {
      const existing = s.selectReputationTotals.get(agentId);
      const feedbackCount = (existing?.feedback_count ?? 0) + p.feedbackDelta;
      const revokedCount = (existing?.revoked_count ?? 0) + p.revokedDelta;
      const responseCount = (existing?.response_count ?? 0) + p.responseDelta;
      const uniqueClients = (existing?.unique_clients ?? 0) + p.uniqueClientsDelta;
      const firstBlock = existing?.first_feedback_block ?? p.newFirstBlock;
      const lastBlock =
        p.newLastBlock !== null
          ? Math.max(existing?.last_feedback_block ?? 0, p.newLastBlock)
          : existing?.last_feedback_block ?? null;
      s.upsertReputationTotals.run(
        agentId,
        feedbackCount,
        revokedCount,
        responseCount,
        uniqueClients,
        firstBlock,
        lastBlock,
      );
    }
  }

  getReputationTotals(agentId: number): ReputationAgentTotals | null {
    const row = this.statements.selectReputationTotals.get(agentId);
    if (!row) return null;
    return {
      agentId: row.agent_id,
      feedbackCount: row.feedback_count,
      revokedCount: row.revoked_count,
      responseCount: row.response_count,
      uniqueClients: row.unique_clients,
      firstFeedbackBlock: row.first_feedback_block,
      lastFeedbackBlock: row.last_feedback_block,
    };
  }

  getReputationFeedbackForAgent(agentId: number, limit = 50): ReputationFeedbackRow[] {
    return this.statements.selectReputationFeedbackByAgent
      .all(agentId, Math.min(limit, 500))
      .map(rowToReputationFeedback);
  }

  getRecentReputationFeedback(limit = 25): ReputationFeedbackRow[] {
    return this.statements.selectReputationFeedbackRecent
      .all(Math.min(limit, 500))
      .map(rowToReputationFeedback);
  }

  getReputationLeaderboard(limit = 25): ReputationAgentTotals[] {
    return this.statements.selectReputationLeaderboard.all(Math.min(limit, 500)).map((row) => ({
      agentId: row.agent_id,
      feedbackCount: row.feedback_count,
      revokedCount: row.revoked_count,
      responseCount: row.response_count,
      uniqueClients: row.unique_clients,
      firstFeedbackBlock: row.first_feedback_block,
      lastFeedbackBlock: row.last_feedback_block,
    }));
  }

  /** Closes the underlying DB handle. */
  close(): void {
    this.db.close();
  }
}

// ── private helpers (file-scope, pure) ─────────────────────────────────────

function wouldRegress(
  sample: HistorySample,
  prior: Pick<HistoryRow, 'total_requests' | 'total_input_tokens' | 'total_output_tokens' | 'settlement_count'>,
): boolean {
  return (
    sample.totalRequests < BigInt(prior.total_requests)
    || sample.totalInputTokens < BigInt(prior.total_input_tokens)
    || sample.totalOutputTokens < BigInt(prior.total_output_tokens)
    || sample.settlementCount < prior.settlement_count
  );
}

function isPriceSampleDuplicate(latest: PriceSampleRow, input: PriceSampleInput): boolean {
  const sameInput = latest.input_usd_per_million === input.inputUsdPerMillion;
  const sameOutput = latest.output_usd_per_million === input.outputUsdPerMillion;
  const sameCached = (latest.cached_input_usd_per_million ?? null) === (input.cachedInputUsdPerMillion ?? null);
  return sameInput && sameOutput && sameCached && input.ts - latest.ts < PRICE_SAMPLE_HEARTBEAT_SECONDS;
}

function isSellerActivityDuplicate(
  latest: Omit<SellerActivityDbRow, 'agent_id'>,
  input: SellerActivitySnapshotInput,
): boolean {
  return (
    latest.total_requests === input.totalRequests.toString()
    && latest.total_input_tokens === input.totalInputTokens.toString()
    && latest.total_output_tokens === input.totalOutputTokens.toString()
    && latest.settlement_count === input.settlementCount
  );
}

/**
 * Pure bucketing — exported for unit tests. Groups rows by floor(ts/bucket),
 * then for each bucket emits:
 *   - activePeers: last sample's gauge value (sentinel → null)
 *   - requests:    last cumulative − previous bucket's last cumulative
 *   - settlements: same, for settlement_count
 *   - tokens:      same, for input + output tokens
 *
 * For the very first bucket there's no previous bucket; we use the bucket's
 * own first sample as the baseline.
 */
export function bucketHistoryRows(rows: HistoryRow[], bucketSeconds: number): HistoryPoint[] {
  if (rows.length === 0) return [];

  // Two-pass: collect first/last samples per bucket, then diff across buckets.
  interface Bucket {
    bucketTs: number;
    firstRequests: bigint;
    firstSettlements: number;
    firstTokens: bigint;
    lastRequests: bigint;
    lastSettlements: number;
    lastTokens: bigint;
    lastActivePeers: number;
  }

  const buckets: Bucket[] = [];
  for (const row of rows) {
    const bucketTs = Math.floor(row.ts / bucketSeconds) * bucketSeconds;
    const tokens = BigInt(row.total_input_tokens) + BigInt(row.total_output_tokens);
    const requests = BigInt(row.total_requests);
    const tail = buckets[buckets.length - 1];
    if (tail && tail.bucketTs === bucketTs) {
      tail.lastRequests = requests;
      tail.lastSettlements = row.settlement_count;
      tail.lastTokens = tokens;
      tail.lastActivePeers = row.active_peers;
    } else {
      buckets.push({
        bucketTs,
        firstRequests: requests,
        firstSettlements: row.settlement_count,
        firstTokens: tokens,
        lastRequests: requests,
        lastSettlements: row.settlement_count,
        lastTokens: tokens,
        lastActivePeers: row.active_peers,
      });
    }
  }

  return buckets.map((cur, i) => {
    const prev = i === 0 ? null : buckets[i - 1]!;
    const baseRequests = prev ? prev.lastRequests : cur.firstRequests;
    const baseSettlements = prev ? prev.lastSettlements : cur.firstSettlements;
    const baseTokens = prev ? prev.lastTokens : cur.firstTokens;

    // Cumulative counters are monotonic; clamp to guard against pathological
    // cases (DB reset, manual edit). Sentinel -1 → null so the chart skips
    // drawing the peers line for backfilled buckets.
    return {
      ts: cur.bucketTs,
      activePeers: cur.lastActivePeers === ACTIVE_PEERS_UNKNOWN ? null : cur.lastActivePeers,
      requests: clampNonNegBigint(cur.lastRequests - baseRequests),
      settlements: Math.max(0, cur.lastSettlements - baseSettlements),
      tokens: clampNonNegBigint(cur.lastTokens - baseTokens),
    };
  });
}

function clampNonNegBigint(d: bigint): number {
  return Number(d < 0n ? 0n : d);
}

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import {
  AntseedNode,
  type PeerInfo,
} from '@antseed/node';
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery';
import { parsePersistedPeers } from '../../../proxy/buyer-proxy.js';
import { buildPaymentsConfig } from './chain-config-helper.js';

type PeerSortKey = 'volume' | 'sessions' | 'price' | 'recent';

interface BrowseOptions {
  service?: string;
  json?: boolean;
  services?: boolean;
  sort?: string;
  top?: string;
}

interface BrowseSnapshot {
  peers: PeerInfo[];
  onChainStatsRefreshedAt: number | null;
  sourceLabel: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a snapshot from a live buyer daemon. Returns `null` unless the daemon is
 * connected, its PID is alive, and the persisted peer list is non-empty.
 */
async function loadSnapshotFromBuyerState(dataDir: string): Promise<BrowseSnapshot | null> {
  try {
    const raw = await readFile(join(dataDir, 'buyer.state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      state?: unknown;
      pid?: unknown;
      onChainStatsRefreshedAt?: unknown;
    };
    if (parsed.state !== 'connected') return null;
    if (typeof parsed.pid !== 'number' || !isProcessAlive(parsed.pid)) return null;
    const peers = parsePersistedPeers(parsed);
    if (peers.length === 0) return null;
    const refreshedAt = typeof parsed.onChainStatsRefreshedAt === 'number'
      && Number.isFinite(parsed.onChainStatsRefreshedAt)
      ? parsed.onChainStatsRefreshedAt
      : null;
    return {
      peers,
      onChainStatsRefreshedAt: refreshedAt,
      sourceLabel: `buyer daemon (pid ${parsed.pid})`,
    };
  } catch {
    return null;
  }
}

/**
 * A pricing entry counts as "free" when both input and output prices are
 * finite and zero. We intentionally don't treat undefined/negative values as
 * free — those are "unknown" and handled separately by the formatter.
 */
function isFreePricing(pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number }): boolean {
  return (
    Number.isFinite(pricing.inputUsdPerMillion)
    && Number.isFinite(pricing.outputUsdPerMillion)
    && pricing.inputUsdPerMillion === 0
    && pricing.outputUsdPerMillion === 0
  );
}

/**
 * Derive the set of service names this peer offers, flattened across all its
 * providers, in stable (sorted) order.
 */
function collectServiceNames(peer: PeerInfo): string[] {
  const names = new Set<string>();
  const pricing = peer.providerPricing;
  if (pricing) {
    for (const entry of Object.values(pricing)) {
      const services = entry.services;
      if (services) {
        for (const name of Object.keys(services)) {
          const trimmed = name.trim();
          if (trimmed.length > 0) names.add(trimmed);
        }
      }
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * Collect the names of free (both input and output = $0/1M) services a peer
 * offers. Used to populate the optional "Free" column.
 */
function collectFreeServiceNames(peer: PeerInfo): string[] {
  const names = new Set<string>();
  const pricing = peer.providerPricing;
  if (pricing) {
    for (const entry of Object.values(pricing)) {
      if (entry.services) {
        for (const [serviceName, servicePricing] of Object.entries(entry.services)) {
          if (isFreePricing(servicePricing)) names.add(serviceName);
        }
      }
      // If the provider's defaults are free and no per-service override lifts
      // them, consider "(default)" a free offering worth surfacing.
      if (entry.defaults && isFreePricing(entry.defaults) && (!entry.services || Object.keys(entry.services).length === 0)) {
        names.add('(default)');
      }
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * Check whether the peer matches a `--service` filter. Matches on provider
 * name OR any announced service name (case-insensitive).
 */
function peerMatchesServiceFilter(peer: PeerInfo, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (peer.providers.some((p) => p.toLowerCase() === needle)) return true;
  return collectServiceNames(peer).some((name) => name.toLowerCase() === needle);
}

/**
 * Determine the cheapest *paid* input/output price pair across all services.
 * Free services (input=output=0) are deliberately excluded from these
 * columns — they are surfaced in a dedicated "Free" column when present —
 * so the In/Out $/1M columns always reflect the cheapest paid option a peer
 * offers. If every candidate is free or unknown, the result is `null`.
 *
 * CAVEAT: the returned input and output are picked independently across
 * services. A peer with serviceA=$1/$2 and serviceB=$2/$1 is rendered as
 * $1/$1 — a lower-bound approximation, not a real single-service offer.
 * Use `antseed network browse --services` or `antseed network peer <id>`
 * for per-service pricing when exact comparison matters.
 */
function resolveBestPaidPricing(peer: PeerInfo): { input: number | null; output: number | null } {
  let bestInput: number | null = null;
  let bestOutput: number | null = null;
  const pricing = peer.providerPricing;
  if (pricing) {
    for (const entry of Object.values(pricing)) {
      const candidates: Array<{ inputUsdPerMillion: number; outputUsdPerMillion: number }> = [];
      if (entry.defaults) candidates.push(entry.defaults);
      if (entry.services) candidates.push(...Object.values(entry.services));
      for (const c of candidates) {
        if (isFreePricing(c)) continue;
        if (Number.isFinite(c.inputUsdPerMillion) && c.inputUsdPerMillion > 0) {
          if (bestInput === null || c.inputUsdPerMillion < bestInput) bestInput = c.inputUsdPerMillion;
        }
        if (Number.isFinite(c.outputUsdPerMillion) && c.outputUsdPerMillion > 0) {
          if (bestOutput === null || c.outputUsdPerMillion < bestOutput) bestOutput = c.outputUsdPerMillion;
        }
      }
    }
  }
  // Top-level defaults are only used when we have nothing else — and only if
  // they are positive (non-free).
  if (bestInput === null && Number.isFinite(peer.defaultInputUsdPerMillion) && (peer.defaultInputUsdPerMillion ?? 0) > 0) {
    bestInput = peer.defaultInputUsdPerMillion ?? null;
  }
  if (bestOutput === null && Number.isFinite(peer.defaultOutputUsdPerMillion) && (peer.defaultOutputUsdPerMillion ?? 0) > 0) {
    bestOutput = peer.defaultOutputUsdPerMillion ?? null;
  }
  return { input: bestInput, output: bestOutput };
}

function formatUsdPerMillion(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return chalk.dim('—');
  return `$${value.toFixed(2)}`;
}

function formatUsdcVolume(micros: number | undefined | null): string {
  if (typeof micros !== 'number' || !Number.isFinite(micros) || micros < 0) {
    return chalk.dim('—');
  }
  const usd = micros / 1_000_000;
  if (usd >= 1000) return chalk.green(`$${usd.toFixed(0)}`);
  if (usd >= 1) return chalk.green(`$${usd.toFixed(2)}`);
  if (usd > 0) return `$${usd.toFixed(4)}`;
  return chalk.dim('$0');
}

function formatAge(sec: number | undefined | null): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) {
    return chalk.dim('never');
  }
  const nowMs = Date.now();
  const ageMs = nowMs - sec * 1000;
  if (ageMs < 0) return chalk.dim('just now');
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatHumanAgeMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Mark a peer as "vouched" when it has positive on-chain channel count and no
 * ghosts. Rendered as a ✓ next to its peer id in the table.
 */
function isPeerVouched(peer: PeerInfo): boolean {
  const channels = peer.onChainChannelCount ?? 0;
  const ghosts = peer.onChainGhostCount ?? 0;
  return channels > 0 && ghosts === 0;
}

function sortPeers(peers: PeerInfo[], sortKey: PeerSortKey): PeerInfo[] {
  const copy = [...peers];
  copy.sort((a, b) => {
    switch (sortKey) {
      case 'volume': {
        const va = a.onChainTotalVolumeUsdcMicros ?? -1;
        const vb = b.onChainTotalVolumeUsdcMicros ?? -1;
        if (va !== vb) return vb - va;
        return (b.onChainChannelCount ?? 0) - (a.onChainChannelCount ?? 0);
      }
      case 'sessions': {
        const ca = a.onChainChannelCount ?? -1;
        const cb = b.onChainChannelCount ?? -1;
        if (ca !== cb) return cb - ca;
        return (b.onChainTotalVolumeUsdcMicros ?? 0) - (a.onChainTotalVolumeUsdcMicros ?? 0);
      }
      case 'price': {
        const pa = resolveBestPaidPricing(a).input ?? Number.POSITIVE_INFINITY;
        const pb = resolveBestPaidPricing(b).input ?? Number.POSITIVE_INFINITY;
        if (pa !== pb) return pa - pb;
        return (b.onChainTotalVolumeUsdcMicros ?? 0) - (a.onChainTotalVolumeUsdcMicros ?? 0);
      }
      case 'recent': {
        const ra = a.onChainLastSettledAtSec ?? 0;
        const rb = b.onChainLastSettledAtSec ?? 0;
        if (ra !== rb) return rb - ra;
        return (b.onChainTotalVolumeUsdcMicros ?? 0) - (a.onChainTotalVolumeUsdcMicros ?? 0);
      }
    }
  });
  return copy;
}

function parseSortKey(raw: string | undefined): PeerSortKey {
  const normalized = (raw ?? 'volume').trim().toLowerCase();
  if (normalized === 'sessions' || normalized === 'price' || normalized === 'recent' || normalized === 'volume') {
    return normalized;
  }
  return 'volume';
}

function parseTopLimit(raw: string | undefined): number {
  const parsed = raw === undefined ? 20 : parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 500);
}

/**
 * Render the default compact table: one row per peer with aggregate metrics.
 * Full peer ids are printed so the output is directly copy-pasteable into
 * `antseed buyer connection set --peer <id>` without any truncation.
 * The "Free" column is only emitted when at least one displayed peer has
 * free services; otherwise it's omitted so the common-case table stays
 * compact.
 */
function renderCompactTable(peers: PeerInfo[], hasChainData: boolean): void {
  const freeNamesByPeer = new Map(
    peers.map((peer) => [peer.peerId, collectFreeServiceNames(peer)] as const),
  );
  const anyFreeService = Array.from(freeNamesByPeer.values()).some((names) => names.length > 0);

  const head: string[] = [
    chalk.bold('Peer'),
    chalk.bold('Name'),
    chalk.bold('Providers'),
    chalk.bold('Services'),
    chalk.bold('Min In $/1M'),
    chalk.bold('Min Out $/1M'),
  ];
  if (anyFreeService) head.push(chalk.bold('Free'));
  head.push(
    chalk.bold('Sessions'),
    chalk.bold('Ghosts'),
    chalk.bold('Volume'),
    chalk.bold('Last settled'),
    chalk.bold('Load'),
  );

  const table = new Table({ head, wordWrap: true });

  for (const peer of peers) {
    const services = collectServiceNames(peer);
    const servicesCell = services.length === 0
      ? chalk.dim('—')
      : services.length <= 2
        ? services.join(', ')
        : `${services.slice(0, 2).join(', ')} ${chalk.dim(`+${services.length - 2}`)}`;
    const pricing = resolveBestPaidPricing(peer);

    const ghostCount = peer.onChainGhostCount;
    const ghostCell = typeof ghostCount === 'number'
      ? (ghostCount === 0 ? chalk.dim('0') : chalk.red(String(ghostCount)))
      : chalk.dim('—');

    const sessionsCell = typeof peer.onChainChannelCount === 'number'
      ? (peer.onChainChannelCount > 0 ? chalk.cyan(String(peer.onChainChannelCount)) : chalk.dim('0'))
      : chalk.dim('—');

    const load = peer.currentLoad !== undefined && peer.maxConcurrency !== undefined
      ? `${peer.currentLoad}/${peer.maxConcurrency}`
      : chalk.dim('—');

    const badge = isPeerVouched(peer) ? chalk.green(' ✓') : '';
    const peerCell = peer.peerId + badge;

    const freeNames = freeNamesByPeer.get(peer.peerId) ?? [];
    const freeCell = freeNames.length === 0
      ? chalk.dim('—')
      : freeNames.length <= 2
        ? chalk.green(freeNames.join(', '))
        : chalk.green(`${freeNames.slice(0, 2).join(', ')}`) + chalk.dim(` +${freeNames.length - 2}`);

    const row: string[] = [
      peerCell,
      peer.displayName ?? chalk.dim('—'),
      peer.providers.join(', ') || chalk.dim('—'),
      servicesCell,
      formatUsdPerMillion(pricing.input),
      formatUsdPerMillion(pricing.output),
    ];
    if (anyFreeService) row.push(freeCell);
    row.push(
      sessionsCell,
      ghostCell,
      formatUsdcVolume(peer.onChainTotalVolumeUsdcMicros ?? null),
      formatAge(peer.onChainLastSettledAtSec ?? null),
      load,
    );

    table.push(row);
  }

  console.log('');
  console.log(table.toString());
  if (!hasChainData) {
    console.log(chalk.dim('  Sessions / Ghosts / Volume / Last settled are dim — configure chain RPC to enable on-chain verification.'));
  }
  if (anyFreeService) {
    console.log(chalk.dim('  Free column lists services a peer offers at $0 in/out. "Min In/Out $/1M" always reflects the cheapest PAID option.'));
  }
  console.log('');
}

/**
 * Render the expanded "one row per (peer, provider, service)" table.
 */
function renderExpandedTable(peers: PeerInfo[]): void {
  const table = new Table({
    head: [
      chalk.bold('Peer'),
      chalk.bold('Provider'),
      chalk.bold('Service'),
      chalk.bold('In $/1M'),
      chalk.bold('Out $/1M'),
      chalk.bold('Sessions'),
      chalk.bold('Volume'),
    ],
    wordWrap: true,
  });

  for (const peer of peers) {
    const pricing = peer.providerPricing;
    if (!pricing || Object.keys(pricing).length === 0) {
      // Fall back to provider list without services.
      for (const provider of peer.providers) {
        table.push([
          peer.peerId,
          provider,
          chalk.dim('—'),
          formatUsdPerMillion(peer.defaultInputUsdPerMillion ?? null),
          formatUsdPerMillion(peer.defaultOutputUsdPerMillion ?? null),
          typeof peer.onChainChannelCount === 'number' ? String(peer.onChainChannelCount) : chalk.dim('—'),
          formatUsdcVolume(peer.onChainTotalVolumeUsdcMicros ?? null),
        ]);
      }
      continue;
    }
    for (const [providerName, providerEntry] of Object.entries(pricing)) {
      const services = providerEntry.services ?? {};
      const serviceEntries = Object.entries(services);
      if (serviceEntries.length === 0) {
        table.push([
          peer.peerId,
          providerName,
          chalk.dim('(default)'),
          formatUsdPerMillion(providerEntry.defaults?.inputUsdPerMillion ?? null),
          formatUsdPerMillion(providerEntry.defaults?.outputUsdPerMillion ?? null),
          typeof peer.onChainChannelCount === 'number' ? String(peer.onChainChannelCount) : chalk.dim('—'),
          formatUsdcVolume(peer.onChainTotalVolumeUsdcMicros ?? null),
        ]);
        continue;
      }
      for (const [serviceName, servicePricing] of serviceEntries.sort(([a], [b]) => a.localeCompare(b))) {
        table.push([
          peer.peerId,
          providerName,
          serviceName,
          formatUsdPerMillion(servicePricing.inputUsdPerMillion),
          formatUsdPerMillion(servicePricing.outputUsdPerMillion),
          typeof peer.onChainChannelCount === 'number' ? String(peer.onChainChannelCount) : chalk.dim('—'),
          formatUsdcVolume(peer.onChainTotalVolumeUsdcMicros ?? null),
        ]);
      }
    }
  }

  console.log('');
  console.log(table.toString());
  console.log('');
}

/**
 * Register the `antseed network browse` command.
 */
export function registerNetworkBrowseCommand(networkCmd: Command): void {
  networkCmd
    .command('browse')
    .description('Browse peers on the network — prices, services, and on-chain settlements')
    .option('-s, --service <service>', 'filter by service or provider name')
    .option('--services', 'expand to one row per (peer, provider, service) with per-service pricing', false)
    .option('--sort <key>', 'sort by volume | sessions | price | recent (default: volume)')
    .option('--top <n>', 'show only the top N peers (default: 20)')
    .option('--json', 'output as JSON', false)
    .action(async (rawOptions: BrowseOptions) => {
      const globalOpts = getGlobalOptions(networkCmd);
      const config = await loadConfig(globalOpts.config);
      const serviceFilter = rawOptions.service?.trim();
      const sortKey = parseSortKey(rawOptions.sort);
      const topLimit = parseTopLimit(rawOptions.top);

      let snapshot = await loadSnapshotFromBuyerState(globalOpts.dataDir);

      if (!snapshot) {
        const bootstrapNodes = config.network.bootstrapNodes.length > 0
          ? toBootstrapConfig(parseBootstrapList(config.network.bootstrapNodes))
          : undefined;

        const spinner = ora('Discovering peers on the network...').start();
        const paymentsConfig = buildPaymentsConfig(config.payments?.crypto);

        const node = new AntseedNode({
          role: 'buyer',
          ...(bootstrapNodes ? { bootstrapNodes } : {}),
          dhtOperationTimeoutMs: 30_000,
          ...(paymentsConfig ? { payments: paymentsConfig } : {}),
        });

        try {
          await node.start();
        } catch (err) {
          spinner.fail(chalk.red(`Failed to connect to network: ${(err as Error).message}`));
          process.exit(1);
        }

        try {
          const peers = await node.discoverPeers(serviceFilter);
          spinner.succeed(chalk.green(`Found ${peers.length} peer(s)`));
          // Only stamp `onChainStatsRefreshedAt` when the enrichment loop
          // could actually have run — otherwise we'd display a misleading
          // "On-chain stats as of just now" header on top of a table that
          // has "—" in every on-chain column. Derive it from the per-peer
          // timestamps so we reflect only real RPC reads.
          const latestChainStamp = peers
            .map((p) => p.onChainStatsFetchedAt ?? 0)
            .reduce((max, v) => (v > max ? v : max), 0);
          snapshot = {
            peers,
            onChainStatsRefreshedAt: latestChainStamp > 0 ? latestChainStamp : null,
            sourceLabel: 'live DHT discovery',
          };
        } catch (err) {
          spinner.fail(chalk.red(`Discovery failed: ${(err as Error).message}`));
          await node.stop();
          return;
        }

        await node.stop();
      }

      let peers = snapshot.peers;
      if (serviceFilter) {
        peers = peers.filter((peer) => peerMatchesServiceFilter(peer, serviceFilter));
      }

      if (peers.length === 0) {
        console.log(chalk.dim('No peers found. Try again later or adjust --service.'));
        return;
      }

      peers = sortPeers(peers, sortKey);
      const truncated = peers.length > topLimit;
      const displayed = truncated ? peers.slice(0, topLimit) : peers;

      if (rawOptions.json) {
        console.log(JSON.stringify({
          source: snapshot.sourceLabel,
          onChainStatsRefreshedAt: snapshot.onChainStatsRefreshedAt,
          sort: sortKey,
          total: peers.length,
          peers: displayed,
        }, null, 2));
        return;
      }

      console.log(chalk.dim(`Source: ${snapshot.sourceLabel} • ${peers.length} peer(s)${truncated ? ` (showing top ${topLimit})` : ''} • sort: ${sortKey}`));
      if (snapshot.onChainStatsRefreshedAt) {
        const ageMs = Date.now() - snapshot.onChainStatsRefreshedAt;
        console.log(chalk.dim(`On-chain stats as of ${formatHumanAgeMs(ageMs)}`));
      }

      const hasChainData = displayed.some((peer) => typeof peer.onChainChannelCount === 'number');

      if (rawOptions.services) {
        renderExpandedTable(displayed);
      } else {
        renderCompactTable(displayed, hasChainData);
      }

      const topPeer = displayed[0];
      if (topPeer) {
        console.log(chalk.bold('Pin a peer:'));
        console.log(`  antseed buyer connection set --peer ${topPeer.peerId}`);
        console.log(chalk.dim(`  or per-request:   curl -H "x-antseed-pin-peer: ${topPeer.peerId}" ...`));
        console.log(chalk.dim(`  full details:     antseed network peer ${topPeer.peerId}`));
        console.log('');
      }
    });
}

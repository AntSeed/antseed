import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import {
  AntseedNode,
  resolveChainConfig,
  type NodePaymentsConfig,
  type PeerInfo,
} from '@antseed/node';
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery';
import { parsePersistedPeers } from '../../../proxy/buyer-proxy.js';

interface PeerOptions {
  json?: boolean;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function loadPeersFromBuyerDaemon(dataDir: string): Promise<PeerInfo[] | null> {
  try {
    const raw = await readFile(join(dataDir, 'buyer.state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { state?: unknown; pid?: unknown };
    if (parsed.state !== 'connected') return null;
    if (typeof parsed.pid !== 'number' || !isProcessAlive(parsed.pid)) return null;
    const peers = parsePersistedPeers(parsed);
    return peers.length > 0 ? peers : null;
  } catch {
    return null;
  }
}

function buildPaymentsConfig(
  cryptoOverrides: {
    chainId?: 'base-local' | 'base-sepolia' | 'base-mainnet';
    rpcUrl?: string;
    depositsContractAddress?: string;
    channelsContractAddress?: string;
    usdcContractAddress?: string;
    stakingContractAddress?: string;
    identityRegistryAddress?: string;
  } | undefined,
): NodePaymentsConfig | undefined {
  try {
    const resolved = resolveChainConfig({
      chainId: cryptoOverrides?.chainId,
      rpcUrl: cryptoOverrides?.rpcUrl,
      depositsContractAddress: cryptoOverrides?.depositsContractAddress,
      channelsContractAddress: cryptoOverrides?.channelsContractAddress,
      usdcContractAddress: cryptoOverrides?.usdcContractAddress,
    });
    const paymentsConfig: NodePaymentsConfig = {
      enabled: true,
      rpcUrl: resolved.rpcUrl,
      ...(resolved.fallbackRpcUrls ? { fallbackRpcUrls: resolved.fallbackRpcUrls } : {}),
      depositsAddress: resolved.depositsContractAddress,
      channelsAddress: resolved.channelsContractAddress,
      usdcAddress: resolved.usdcContractAddress,
      chainId: resolved.evmChainId,
      ...(resolved.stakingContractAddress ? { stakingAddress: resolved.stakingContractAddress } : {}),
      ...(resolved.identityRegistryAddress ? { identityRegistryAddress: resolved.identityRegistryAddress } : {}),
    };
    return paymentsConfig;
  } catch {
    return undefined;
  }
}

function normalizePeerId(raw: string): string | null {
  const cleaned = raw.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(cleaned)) return null;
  return cleaned;
}

function formatUsdPerMillion(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return chalk.dim('—');
  return `$${value.toFixed(4)}/1M`;
}

function formatUsdcVolume(micros: number | undefined): string {
  if (typeof micros !== 'number' || !Number.isFinite(micros) || micros < 0) {
    return chalk.dim('—');
  }
  const usd = micros / 1_000_000;
  if (usd >= 1) return chalk.green(`$${usd.toFixed(2)} USDC`);
  if (usd > 0) return `$${usd.toFixed(6)} USDC`;
  return chalk.dim('$0 USDC');
}

function formatTimestampSec(sec: number | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) {
    return chalk.dim('never');
  }
  const date = new Date(sec * 1000);
  const ageMs = Date.now() - sec * 1000;
  const ageMins = Math.max(0, Math.floor(ageMs / 60_000));
  const ageLabel =
    ageMins < 1 ? 'just now'
    : ageMins < 60 ? `${ageMins}m ago`
    : ageMins < 1440 ? `${Math.floor(ageMins / 60)}h ago`
    : `${Math.floor(ageMins / 1440)}d ago`;
  return `${date.toISOString()}  ${chalk.dim(`(${ageLabel})`)}`;
}

function printPeerDetail(peer: PeerInfo): void {
  console.log('');
  console.log(chalk.bold('Peer'));
  console.log(`  ID:              ${peer.peerId}`);
  console.log(`  Display name:    ${peer.displayName ?? chalk.dim('—')}`);
  console.log(`  Public address:  ${peer.publicAddress ?? chalk.dim('—')}`);
  if (typeof peer.lastSeen === 'number' && peer.lastSeen > 0) {
    const age = Date.now() - peer.lastSeen;
    console.log(`  Last seen:       ${new Date(peer.lastSeen).toISOString()} ${chalk.dim(`(${Math.max(0, Math.floor(age / 1000))}s ago)`)}`);
  }
  if (typeof peer.lastReachedAt === 'number' && peer.lastReachedAt > 0) {
    const age = Date.now() - peer.lastReachedAt;
    console.log(`  Last reached:    ${new Date(peer.lastReachedAt).toISOString()} ${chalk.dim(`(${Math.max(0, Math.floor(age / 1000))}s ago)`)}`);
  }

  console.log('');
  console.log(chalk.bold('Capacity'));
  const maxC = peer.maxConcurrency ?? null;
  const curL = peer.currentLoad ?? null;
  if (maxC !== null || curL !== null) {
    console.log(`  Load:            ${curL ?? '?'} / ${maxC ?? '?'}`);
  } else {
    console.log(`  Load:            ${chalk.dim('—')}`);
  }

  console.log('');
  console.log(chalk.bold('On-chain (AntseedChannels.getAgentStats)'));
  const channels = peer.onChainChannelCount;
  const ghosts = peer.onChainGhostCount;
  const vouchedBadge = (typeof channels === 'number' && channels > 0 && (ghosts ?? 0) === 0)
    ? chalk.green('  ✓ vouched')
    : '';
  console.log(`  Sessions:        ${typeof channels === 'number' ? chalk.cyan(String(channels)) : chalk.dim('—')}${vouchedBadge}`);
  console.log(`  Ghosts:          ${typeof ghosts === 'number' ? (ghosts === 0 ? chalk.dim('0') : chalk.red(String(ghosts))) : chalk.dim('—')}`);
  console.log(`  Volume:          ${formatUsdcVolume(peer.onChainTotalVolumeUsdcMicros)}`);
  console.log(`  Last settled:    ${formatTimestampSec(peer.onChainLastSettledAtSec)}`);
  if (typeof peer.onChainStatsFetchedAt === 'number' && peer.onChainStatsFetchedAt > 0) {
    const age = Date.now() - peer.onChainStatsFetchedAt;
    console.log(`  ${chalk.dim(`Verified ${Math.max(0, Math.floor(age / 1000))}s ago by reading contract directly`)}`);
  } else {
    console.log(chalk.dim('  (on-chain stats unavailable — configure chain RPC to enable)'));
  }

  console.log('');
  console.log(chalk.bold('Providers & services'));
  if (peer.providers.length === 0) {
    console.log(chalk.dim('  (none announced)'));
  } else {
    for (const providerName of peer.providers) {
      console.log(`  ${chalk.cyan(providerName)}`);
      const pricingEntry = peer.providerPricing?.[providerName];
      const protocolsEntry = peer.providerServiceApiProtocols?.[providerName];
      const categoriesEntry = peer.providerServiceCategories?.[providerName];

      if (pricingEntry?.defaults) {
        const d = pricingEntry.defaults;
        console.log(`    defaults:        in ${formatUsdPerMillion(d.inputUsdPerMillion)}  out ${formatUsdPerMillion(d.outputUsdPerMillion)}`
          + (d.cachedInputUsdPerMillion != null ? `  cached-in ${formatUsdPerMillion(d.cachedInputUsdPerMillion)}` : ''));
      }

      const services = pricingEntry?.services ? Object.keys(pricingEntry.services).sort() : [];
      if (services.length === 0) {
        console.log(chalk.dim('    (no services announced for this provider)'));
        continue;
      }
      for (const serviceName of services) {
        const s = pricingEntry!.services![serviceName]!;
        const protocols = protocolsEntry?.services?.[serviceName] ?? [];
        const categories = categoriesEntry?.services?.[serviceName] ?? [];
        const parts: string[] = [
          `in ${formatUsdPerMillion(s.inputUsdPerMillion)}`,
          `out ${formatUsdPerMillion(s.outputUsdPerMillion)}`,
        ];
        if (s.cachedInputUsdPerMillion != null) {
          parts.push(`cached-in ${formatUsdPerMillion(s.cachedInputUsdPerMillion)}`);
        }
        if (protocols.length > 0) parts.push(chalk.dim(`protocols: ${protocols.join(', ')}`));
        if (categories.length > 0) parts.push(chalk.dim(`tags: ${categories.join(', ')}`));
        console.log(`    ${serviceName.padEnd(28)} ${parts.join('  ')}`);
      }
    }
  }

  console.log('');
  console.log(chalk.bold('Pin this peer'));
  console.log(`  antseed buyer connection set --peer ${peer.peerId}`);
  console.log(chalk.dim(`  or per-request:   curl -H "x-antseed-pin-peer: ${peer.peerId}" ...`));
  console.log('');
}

/**
 * Register the `antseed network peer <peerId>` command.
 */
export function registerNetworkPeerCommand(networkCmd: Command): void {
  networkCmd
    .command('peer <peerId>')
    .description('Show full details for a single peer (providers, services, on-chain stats)')
    .option('--json', 'output as JSON', false)
    .action(async (peerIdArg: string, options: PeerOptions) => {
      const normalized = normalizePeerId(peerIdArg);
      if (!normalized) {
        console.error(chalk.red('Error: peerId must be a 40-char hex EVM address (with or without 0x prefix).'));
        process.exit(1);
      }

      const globalOpts = getGlobalOptions(networkCmd);
      const config = await loadConfig(globalOpts.config);

      let peers = await loadPeersFromBuyerDaemon(globalOpts.dataDir);
      let sourceLabel = 'buyer daemon cache';

      if (!peers) {
        const bootstrapNodes = config.network.bootstrapNodes.length > 0
          ? toBootstrapConfig(parseBootstrapList(config.network.bootstrapNodes))
          : undefined;
        const paymentsConfig = buildPaymentsConfig(config.payments?.crypto);
        const spinner = ora(`Discovering peer ${normalized.slice(0, 12)}...`).start();
        const node = new AntseedNode({
          role: 'buyer',
          ...(bootstrapNodes ? { bootstrapNodes } : {}),
          dhtOperationTimeoutMs: 30_000,
          ...(paymentsConfig ? { payments: paymentsConfig } : {}),
        });
        try {
          await node.start();
          peers = await node.discoverPeers();
          spinner.succeed(chalk.green(`Found ${peers.length} peer(s)`));
          sourceLabel = 'live DHT discovery';
        } catch (err) {
          spinner.fail(chalk.red(`Discovery failed: ${(err as Error).message}`));
          try { await node.stop(); } catch { /* ignore */ }
          process.exit(1);
        }
        try { await node.stop(); } catch { /* ignore */ }
      }

      const match = peers!.find((p) => p.peerId.toLowerCase() === normalized) ?? null;
      if (!match) {
        console.error(chalk.red(`Peer ${normalized} not found (source: ${sourceLabel}).`));
        console.error(chalk.dim('Run `antseed network browse` to see all peers currently visible on the network.'));
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify({ source: sourceLabel, peer: match }, null, 2));
        return;
      }

      console.log(chalk.dim(`Source: ${sourceLabel}`));
      printPeerDetail(match);
    });
}

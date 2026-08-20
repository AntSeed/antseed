import type { Command } from 'commander';
import chalk from 'chalk';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import { assessSellerPublicAddress, probeTcpEndpoint } from './reachability.js';
import { access, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { VideoJobStore } from '@antseed/node';
import { resolvePluginPackage } from '../../../plugins/registry.js';

export function registerSellerDoctorCommand(sellerCmd: Command): void {
  sellerCmd
    .command('doctor')
    .description('Diagnose the announced seller endpoint')
    .option('--json', 'output as JSON', false)
    .option('--timeout-ms <milliseconds>', 'TCP probe timeout', '3000')
    .option('--video-live', 'validate configured video API keys and model access', false)
    .action(async (options) => {
      try {
        const timeoutMs = Number(options.timeoutMs);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
          throw new Error('--timeout-ms must be an integer >= 1');
        }

        const globalOpts = getGlobalOptions(sellerCmd);
        const config = await loadConfig(globalOpts.config);
        const assessment = assessSellerPublicAddress(config.seller.publicAddress);
        const probe = assessment.endpoint
          ? await probeTcpEndpoint(assessment.endpoint, timeoutMs)
          : null;
        const video = await diagnoseVideoProviders(config, globalOpts.dataDir, options.videoLive === true, timeoutMs);
        const healthy = assessment.publiclyRoutable && probe?.reachable === true && video.healthy;
        const result = {
          configuredAddress: assessment.address || null,
          classification: assessment.classification,
          publiclyRoutable: assessment.publiclyRoutable,
          localTcpProbe: probe,
          externalReachabilityVerified: false,
          video,
          healthy,
        };

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.bold('Seller Reachability'));
          console.log(`  Announced endpoint: ${assessment.address || chalk.red('not configured')}`);
          console.log(`  Address check: ${assessment.publiclyRoutable ? chalk.green('potentially public') : chalk.red(assessment.classification)}`);
          console.log(`  ${assessment.message}`);

          if (probe?.reachable) {
            console.log(chalk.green(`  Local TCP probe: connected in ${probe.durationMs}ms`));
          } else if (probe) {
            console.log(chalk.red(`  Local TCP probe: failed (${probe.error ?? 'unknown error'})`));
          } else {
            console.log(chalk.yellow('  Local TCP probe: skipped — configure a host:port endpoint first'));
          }

          console.log('');
          console.log(chalk.yellow('A successful local probe does not prove inbound NAT reachability.'));
          console.log('Verify the endpoint from another network, and configure port forwarding/firewall rules if needed.');
          console.log('Guide: https://antseed.com/docs/transport/');
          if (video.providers.length > 0) {
            console.log('');
            console.log(chalk.bold('Video Providers'));
            for (const provider of video.providers) {
              const icon = provider.healthy ? chalk.green('✓') : chalk.red('✗');
              console.log(`  ${icon} ${provider.name}: ${provider.message}`);
            }
            console.log(`  Disk free: ${formatBytes(video.disk.freeBytes)}; cached artifacts: ${formatBytes(video.jobs?.artifactBytes ?? 0)}`);
            if ((video.jobs?.reconciliationRequired.length ?? 0) > 0) {
              console.log(chalk.red(`  Reconciliation required: ${video.jobs!.reconciliationRequired.map((job) => job.id).join(', ')}`));
            }
          }
        }

        if (!healthy) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}

async function diagnoseVideoProviders(
  config: Awaited<ReturnType<typeof loadConfig>>,
  dataDir: string,
  live: boolean,
  timeoutMs: number,
): Promise<{
  healthy: boolean;
  providers: Array<{ name: string; healthy: boolean; message: string; live: 'passed' | 'failed' | 'skipped' }>;
  disk: { freeBytes: number; totalBytes: number };
  jobs: ReturnType<VideoJobStore['diagnostics']> | null;
}> {
  const providers = [];
  for (const [name, provider] of Object.entries(config.seller.providers)) {
    const packageName = resolvePluginPackage(provider.plugin);
    if (packageName !== '@antseed/provider-runway' && packageName !== '@antseed/provider-veo') continue;
    const kind = packageName.endsWith('runway') ? 'runway' : 'veo';
    const defaultKeyEnv = kind === 'runway' ? 'RUNWAY_API_KEY' : 'GEMINI_API_KEY';
    const keyEnv = provider.apiKeyEnv ?? defaultKeyEnv;
    const apiKey = process.env[keyEnv];
    const services = Object.entries(provider.services);
    const pricingMissing = services.filter(([, service]) => !service.unitBillingModels?.['antseed-video-jobs-v1']).map(([service]) => service);
    const capabilitiesMissing = services.filter(([, service]) => !service.capabilities?.video).map(([service]) => service);
    let healthy = Boolean(apiKey) && services.length > 0 && pricingMissing.length === 0 && capabilitiesMissing.length === 0;
    let message = !apiKey
      ? `missing API key in ${keyEnv}`
      : services.length === 0
        ? 'no video models configured'
        : pricingMissing.length > 0
          ? `missing video pricing for ${pricingMissing.join(', ')}`
          : capabilitiesMissing.length > 0
            ? `missing video capabilities for ${capabilitiesMissing.join(', ')}`
            : `${services.length} tested model preset(s), ${((provider.videoPayment?.upfrontBps ?? 5000) / 100).toFixed(0)}% upfront`;
    let liveStatus: 'passed' | 'failed' | 'skipped' = 'skipped';
    if (healthy && live && apiKey) {
      try {
        await liveVideoProbe(kind, provider.baseUrl, apiKey, services[0]![0], timeoutMs);
        liveStatus = 'passed';
        message += '; live model access passed';
      } catch (error) {
        healthy = false;
        liveStatus = 'failed';
        message += `; live probe failed: ${error instanceof Error ? error.message : error}`;
      }
    }
    providers.push({ name, healthy, message, live: liveStatus });
  }
  const diskStats = await statfs(dataDir);
  const dbPath = join(dataDir, 'video', 'video-jobs.db');
  let jobs: ReturnType<VideoJobStore['diagnostics']> | null = null;
  try {
    await access(dbPath);
    const store = new VideoJobStore(dbPath);
    try { jobs = store.diagnostics(); } finally { store.close(); }
  } catch {}
  const jobsHealthy = !jobs || (jobs.reconciliationRequired.length === 0 && jobs.missingUpstreamJobIds.length === 0);
  return {
    healthy: providers.every((provider) => provider.healthy) && jobsHealthy,
    providers,
    disk: { freeBytes: diskStats.bavail * diskStats.bsize, totalBytes: diskStats.blocks * diskStats.bsize },
    jobs,
  };
}

async function liveVideoProbe(kind: 'runway' | 'veo', baseUrl: string | undefined, apiKey: string, model: string, timeoutMs: number): Promise<void> {
  const response = kind === 'runway'
    ? await fetch(new URL('/v1/tasks/00000000-0000-4000-8000-000000000000', baseUrl ?? 'https://api.dev.runwayml.com'), {
        headers: { authorization: `Bearer ${apiKey}`, 'x-runway-version': '2024-11-06' }, signal: AbortSignal.timeout(timeoutMs),
      })
    : await fetch(new URL(`/v1beta/models/${encodeURIComponent(model)}?key=${encodeURIComponent(apiKey)}`, baseUrl ?? 'https://generativelanguage.googleapis.com'), {
        signal: AbortSignal.timeout(timeoutMs),
      });
  if (kind === 'runway' ? response.status !== 404 && !response.ok : !response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

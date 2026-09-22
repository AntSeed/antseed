import { resolveChainConfig } from '@antseed/node/payments/browser';
import type { AntsChainConfig } from '../../../src/service/context';

/** Public gateways that answer the CLI but reject browser (CORS) requests; each attempt would only cool the rotation down. */
const BROWSER_BLOCKED_HOSTS = new Set(['base-public.nodies.app']);
const browserReachable = (url: string) => !BROWSER_BLOCKED_HOSTS.has(new URL(url).hostname);

export function hostedConfig(env: Record<string, string | boolean | undefined>): { chain: AntsChainConfig; projectId: string } {
  const test = env.MODE === 'hosted-test';
  const chainId = test ? String(env.VITE_ANTS_CHAIN ?? 'base-sepolia') : 'base-mainnet';
  if (!['base-mainnet', 'base-sepolia', 'base-local'].includes(chainId)) throw new Error('Unsupported hosted chain.');
  const base = resolveChainConfig({ chainId: chainId as 'base-mainnet' | 'base-sepolia' | 'base-local' });
  const overrides = test && env.VITE_ANTS_TEST_CONFIG ? JSON.parse(String(env.VITE_ANTS_TEST_CONFIG)) as Partial<AntsChainConfig> : {};
  const rpcUrl = String(env.VITE_ANTS_RPC_URL || overrides.rpcUrl || base.rpcUrl);
  const fallbackRpcUrls = env.VITE_ANTS_RPC_FALLBACKS !== undefined
    ? String(env.VITE_ANTS_RPC_FALLBACKS).split(',').map(value => value.trim()).filter(Boolean)
    : (overrides.fallbackRpcUrls ?? base.fallbackRpcUrls ?? []).filter(browserReachable);
  const explorerApiUrl = String(env.VITE_ANTS_EXPLORER_URL ?? overrides.explorerApiUrl ?? base.explorerApiUrl ?? '');
  if (!test) for (const endpoint of [rpcUrl, ...(fallbackRpcUrls ?? []), explorerApiUrl].filter(Boolean)) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Hosted production endpoints must use public HTTPS URLs.');
  }
  return { chain: { ...base, ...overrides, rpcUrl, fallbackRpcUrls, explorerApiUrl }, projectId: String(env.VITE_ANTS_WALLETCONNECT_PROJECT_ID || '9a1851410cb5589bc351a6dabf17140e') };
}

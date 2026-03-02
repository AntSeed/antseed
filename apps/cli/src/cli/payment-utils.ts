import { BaseEscrowClient } from '@antseed/node';
import type { PaymentsCLIConfig } from '../config/types.js';

export const CHAIN_ID_MAP: Record<string, number> = {
  'base-mainnet': 8453,
  'base-sepolia': 84532,
  'base-local':   31337,
};

export function chainNameToId(chainId: string): number {
  return CHAIN_ID_MAP[chainId] ?? 8453;
}

export function createEscrowClient(crypto: NonNullable<PaymentsCLIConfig['crypto']>): BaseEscrowClient {
  return new BaseEscrowClient({
    rpcUrl:          crypto.rpcUrl,
    contractAddress: crypto.escrowContractAddress,
    usdcAddress:     crypto.usdcContractAddress,
    chainId:         chainNameToId(crypto.chainId),
  });
}

export function parseUsdcToBaseUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

export function parseOptionalBoolEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

export async function isRpcReachable(rpcUrl: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal,
    });

    if (!response.ok) return false;

    const payload = await response.json() as { result?: unknown };
    return typeof payload.result === 'string' && payload.result.startsWith('0x');
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

import type { BalanceData, PaymentConfig } from './types';

const BASE = '';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getBalance(): Promise<BalanceData> {
  return fetchJson('/api/balance');
}

export async function getConfig(): Promise<PaymentConfig> {
  return fetchJson('/api/config');
}

export async function requestWithdrawal(amount: string): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  return fetchJson('/api/withdraw/request', {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
}

export async function executeWithdrawal(): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  return fetchJson('/api/withdraw/execute', { method: 'POST' });
}

export async function cancelWithdrawal(): Promise<{ ok: boolean; error?: string }> {
  return fetchJson('/api/withdraw/cancel', { method: 'POST' });
}

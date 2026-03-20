import type { BalanceData, PaymentConfig } from './types';

const BASE = '';

// Read bearer token from URL param (injected by the desktop app when opening the portal)
function getBearerToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('token');
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getBearerToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token && options?.method === 'POST') {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE}${url}`, {
    headers,
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

import type { BalanceData, PaymentConfig } from './types';

const BASE = '';

// Read bearer token from URL param (injected by the desktop app when opening the portal)
// Cached after first read — URL doesn't change during the session.
let _cachedToken: string | null | undefined;
function getBearerToken(): string | null {
  if (_cachedToken !== undefined) return _cachedToken;
  _cachedToken = new URLSearchParams(window.location.search).get('token');
  return _cachedToken;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getBearerToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
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

export async function withdraw(amount: string): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  return fetchJson('/api/withdraw', {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
}

export interface ChannelData {
  channelId: string;
  seller: string;
  deposit: string;
  settled: string;
  deadline: number;
  closeRequestedAt: number;
  status: number;
}

export interface OperatorData {
  operator: string;
  nonce: number;
}

export async function getChannels(): Promise<{ channels: ChannelData[] }> {
  return fetchJson('/api/channels');
}

export async function getOperatorInfo(): Promise<OperatorData> {
  return fetchJson('/api/operator');
}

export async function signOperatorAuth(operator: string): Promise<{ ok: boolean; signature: string; nonce: number; buyer: string }> {
  return fetchJson('/api/operator/sign', {
    method: 'POST',
    body: JSON.stringify({ operator }),
  });
}

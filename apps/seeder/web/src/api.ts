const BASE = '';

let _cachedToken: string | null | undefined;
function getBearerToken(): string | null {
  if (_cachedToken !== undefined) return _cachedToken;
  _cachedToken = new URLSearchParams(window.location.search).get('token');
  return _cachedToken;
}

export async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
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

import type { TokenProvider, TokenProviderState } from '@antseed/node';

export type { TokenProvider, TokenProviderState };

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_OAUTH_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';

function getRefreshTimeoutMs(): number {
  const raw = process.env['ANTSEED_OAUTH_REFRESH_TIMEOUT_MS'];
  if (!raw) {
    return DEFAULT_REFRESH_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REFRESH_TIMEOUT_MS;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// StaticTokenProvider
// ---------------------------------------------------------------------------

/** Wraps a static API key. No refresh logic. */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
  stop(): void {}
  getState(): TokenProviderState {
    return { accessToken: this.token };
  }
}

// ---------------------------------------------------------------------------
// OAuthTokenProvider
// ---------------------------------------------------------------------------

interface OAuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

type RefreshRequestEncoding = 'form' | 'json';

/**
 * Manages an OAuth access/refresh token pair.
 * Transparently refreshes the access token when it nears expiry.
 */
export class OAuthTokenProvider implements TokenProvider {
  private state: OAuthState;
  private refreshPromise: Promise<string> | null = null;
  private readonly tokenEndpoint: string;
  private readonly requestEncoding: RefreshRequestEncoding;
  private readonly clientId: string | undefined;

  constructor(opts: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    tokenEndpoint?: string;
    requestEncoding?: RefreshRequestEncoding;
    clientId?: string;
  }) {
    this.state = {
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      expiresAt: opts.expiresAt,
    };
    this.tokenEndpoint = opts.tokenEndpoint ?? DEFAULT_OAUTH_TOKEN_ENDPOINT;
    this.requestEncoding = opts.requestEncoding ?? 'form';
    this.clientId = opts.clientId;
  }

  async getToken(): Promise<string> {
    if (!this.isExpiringSoon()) {
      return this.state.accessToken;
    }
    // Deduplicate concurrent refresh calls
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async forceRefresh(): Promise<string> {
    // Deduplicate with any in-flight refresh
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  stop(): void {}

  /** Expose current state for persistence. */
  getState(): TokenProviderState {
    return { ...this.state };
  }

  private isExpiringSoon(): boolean {
    return Date.now() >= this.state.expiresAt - REFRESH_BUFFER_MS;
  }

  private async refresh(): Promise<string> {
    const payload: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: this.state.refreshToken,
    };
    if (this.clientId) {
      payload['client_id'] = this.clientId;
    }

    const headers =
      this.requestEncoding === 'json'
        ? { 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/x-www-form-urlencoded' };
    const body =
      this.requestEncoding === 'json'
        ? JSON.stringify(payload)
        : new URLSearchParams(payload).toString();

    const timeoutMs = getRefreshTimeoutMs();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.tokenEndpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `OAuth refresh timed out after ${timeoutMs}ms while reaching ${this.tokenEndpoint}. ` +
            'Check network/proxy/firewall access or use apikey auth.'
        );
      }
      throw new Error(`OAuth refresh request failed: ${message}`);
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OAuth refresh failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      access_token?: string;
      accessToken?: string;
      refresh_token?: string;
      refreshToken?: string;
      expires_in?: number;
      expires_at?: number;
      expiresAt?: number;
    };

    const newAccess = data.access_token ?? data.accessToken;
    if (!newAccess) {
      throw new Error('OAuth refresh response missing access token');
    }

    this.state.accessToken = newAccess;
    if (data.refresh_token ?? data.refreshToken) {
      this.state.refreshToken = (data.refresh_token ?? data.refreshToken)!;
    }
    if (data.expires_at ?? data.expiresAt) {
      this.state.expiresAt = (data.expires_at ?? data.expiresAt)!;
    } else if (data.expires_in) {
      this.state.expiresAt = Date.now() + data.expires_in * 1000;
    }

    return this.state.accessToken;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type AuthType = 'apikey' | 'oauth';

/**
 * Create the appropriate TokenProvider from config values.
 */
export function createTokenProvider(opts: {
  authType?: AuthType;
  authValue: string;
  refreshToken?: string;
  expiresAt?: number;
}): TokenProvider {
  const authType = opts.authType ?? 'apikey';

  switch (authType) {
    case 'oauth':
      if (!opts.refreshToken) {
        // No refresh token — treat as static (works until expiry)
        return new StaticTokenProvider(opts.authValue);
      }
      return new OAuthTokenProvider({
        accessToken: opts.authValue,
        refreshToken: opts.refreshToken,
        expiresAt: opts.expiresAt ?? Date.now() + 3600_000,
      });

    default:
      return new StaticTokenProvider(opts.authValue);
  }
}

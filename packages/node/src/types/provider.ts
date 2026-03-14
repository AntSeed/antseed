/** @deprecated Each plugin manages its own upstream. Use plugin configSchema instead. */
export enum KnownProvider {
  OpenAI = "openai",
  Anthropic = "anthropic",
  Google = "google",
  Mistral = "mistral",
  Cohere = "cohere",
  Moonshot = "moonshot",
}

export interface TokenProviderState {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * Resolves auth tokens dynamically (e.g. OAuth refresh, keychain read).
 */
export interface TokenProvider {
  /** Get a valid access token. May refresh if expired. */
  getToken(): Promise<string>;
  /** Force-refresh the token regardless of expiry (e.g. after a 401 response). */
  forceRefresh?(): Promise<string>;
  /** Clean up resources. */
  stop(): void;
  /** Current provider state for persistence (if available). */
  getState?(): TokenProviderState | null;
}

export interface ProviderConfig {
  provider: KnownProvider;
  baseUrl: string;
  authHeaderName: string;
  authHeaderValue: string;
  allowedServices: string[];
  maxConcurrency: number;
  /** Optional dynamic token provider (OAuth, keychain, etc.). */
  tokenProvider?: TokenProvider;
  /** Extra headers injected into upstream requests (e.g. OAuth beta flags). */
  extraHeaders?: Record<string, string>;
}

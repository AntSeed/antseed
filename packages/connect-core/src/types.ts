// Types for the AntSeed Connect protocol (spec 07-connect.md).

export const CONNECT_VERSION = 1 as const;

export type ScopeId = 'address' | 'auto-deposit';

/** Auto-deposit status the seed app reports to a connecting web app. */
export interface AutoDepositState {
  /** User has turned auto-deposit on in the seed app (consent). Only the seed app knows this. */
  enabled: boolean;
  /** Wallet carries the EIP-7702 delegation that lets it deposit gaslessly. */
  delegated: boolean;
}

export interface ConnectRequest {
  version: typeof CONNECT_VERSION;
  redirect: string;
  /** Comes from the redirect URL, never a separate param. The only thing we trust. */
  origin: string;
  /** Order matters: it sets the order of the value lines in the signed message. */
  scopes: ScopeId[];
  challenge: string;
}

export interface ConnectResponse {
  version: typeof CONNECT_VERSION;
  kind: 'antseed.connect.response';
  challenge: string;
  values: Record<string, string>;
  signatureScheme: 'eip191-personal-sign';
  /** Lowercase 65-byte secp256k1 hex, no 0x prefix. */
  signature: string;
}

export interface ConnectManifest {
  version: typeof CONNECT_VERSION;
  kind: 'antseed.connect.manifest';
  name: string;
  homepage: string;
  icon?: string;
}

/** Read-only account view a scope reads its value from. */
export interface ScopeAccount {
  readonly address: string;
  /** Present only when the request asks for the auto-deposit scope. */
  readonly autoDeposit?: AutoDepositState;
}

export interface ConnectSigner extends ScopeAccount {
  signMessage(message: string): Promise<string>;
}

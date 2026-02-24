/**
 * Provider capability types — what a peer can offer beyond inference.
 */
export type ProviderCapability =
  | 'inference'
  | 'agent'
  | 'skill'
  | 'tool'
  | 'embedding'
  | 'image-gen'
  | 'tts'
  | 'stt';

/**
 * Pricing tier for an offering.
 */
export interface PricingTier {
  unit: 'token' | 'request' | 'minute' | 'task';
  pricePerUnit: number;
  currency: 'USD';
}

/**
 * A discrete offering that a peer advertises.
 */
export interface PeerOffering {
  capability: ProviderCapability;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  models?: string[];
  pricing: PricingTier;
}

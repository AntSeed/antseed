/**
 * Shared verifier interface and dispatch registry by `kind`.
 */

import type { AuditResultFragment, FingerprintReference, SellerObservation } from './types.js';
// kbf/index.ts only imports types from this module, so this import cycle is
// type-only and erased at runtime.
import { KbfVerifier } from './verifiers/kbf/index.js';

export interface VerifyOptions {
  /** Below this parsed-fraction, the verdict is UNDETERMINED. Default 0.5. */
  minCoverage?: number;
  /** Clopper-Pearson confidence for the self-error upper bound. Default 0.99. */
  cpConfidence?: number;
  /** One-sided binomial threshold for DIFF. Default 0.05. */
  alpha?: number;
}

export interface FingerprintVerifier {
  readonly kind: string;
  verify(
    reference: FingerprintReference,
    observation: SellerObservation,
    options?: VerifyOptions,
  ): AuditResultFragment;
}

export interface VerifierRegistry {
  register(verifier: FingerprintVerifier): void;
  get(kind: string): FingerprintVerifier | undefined;
  list(): string[];
}

/** Create a verifier registry with the KBF verifier pre-registered. */
export function createVerifierRegistry(): VerifierRegistry {
  const verifiers = new Map<string, FingerprintVerifier>();
  const registry: VerifierRegistry = {
    register(verifier: FingerprintVerifier): void {
      if (!verifier.kind) {
        throw new Error('VerifierRegistry.register: verifier kind must be non-empty');
      }
      verifiers.set(verifier.kind, verifier);
    },
    get(kind: string): FingerprintVerifier | undefined {
      return verifiers.get(kind);
    },
    list(): string[] {
      return [...verifiers.keys()];
    },
  };
  registry.register(new KbfVerifier());
  return registry;
}

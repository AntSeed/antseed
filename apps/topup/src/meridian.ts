import type { X402PaymentPayload, X402PaymentRequirements } from './x402.js';

export interface MeridianSettleResult {
  success: boolean;
  transaction: string;
  network?: string;
  errorReason?: string;
}

export interface MeridianClient {
  /**
   * Settle an x402 payment. Resolves with a definite outcome; throws when the
   * outcome is unknown (network error, timeout, facilitator 5xx) — in that
   * case funds may or may not have moved and the caller must reconcile via
   * the on-chain EIP-3009 authorization state.
   */
  settle(
    paymentPayload: X402PaymentPayload,
    paymentRequirements: X402PaymentRequirements,
  ): Promise<MeridianSettleResult>;
}

export interface MeridianClientOptions {
  apiBase: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createMeridianClient(options: MeridianClientOptions): MeridianClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    async settle(paymentPayload, paymentRequirements): Promise<MeridianSettleResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(`${options.apiBase}/settle`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ paymentPayload, paymentRequirements }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new Error(
          `Meridian settle outcome unknown: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timeout);
      }

      const body = (await response.json().catch(() => null)) as
        | { success?: boolean; transaction?: string; network?: string; errorReason?: string; error?: string }
        | null;

      // 5xx means the facilitator errored mid-settlement — the on-chain
      // transfer may still have landed, so surface it as unknown.
      if (response.status >= 500) {
        throw new Error(`Meridian settle outcome unknown: HTTP ${response.status} ${body?.errorReason ?? ''}`.trim());
      }
      if (!response.ok || !body?.success) {
        return {
          success: false,
          transaction: body?.transaction ?? '',
          network: body?.network,
          errorReason: body?.errorReason ?? body?.error ?? `HTTP ${response.status}`,
        };
      }
      if (typeof body.transaction !== 'string' || body.transaction.length === 0) {
        throw new Error('Meridian settle outcome unknown: success response without a transaction hash');
      }
      return {
        success: true,
        transaction: body.transaction,
        network: body.network,
      };
    },
  };
}

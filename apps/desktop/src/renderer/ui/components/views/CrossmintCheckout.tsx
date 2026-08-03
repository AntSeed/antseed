import { useCallback, useEffect, useMemo, useState } from 'react';
import { CrossmintProvider, CrossmintEmbeddedCheckout } from '@crossmint/client-sdk-react-ui';
import styles from './CrossmintCheckout.module.scss';

/**
 * In-app Crossmint Stablecoin Onramp: buy USDC on Base with a card and have it
 * delivered to the buyer hot wallet. The purchased USDC lands at `recipient`
 * on Base, where the existing deposit watcher (VprDepositView) sweeps it into
 * the Deposits contract — same crediting path as a QR transfer.
 *
 * We create the order client-side with the public client key (the `orders.create`
 * scope is available on client keys), then hand the returned orderId +
 * clientSecret to the embedded checkout, which runs KYC + card payment inline.
 */

type CrossmintConfig = { clientKey: string; apiBase: string };

type CreatedOrder = { orderId: string; clientSecret: string };

type Props = {
  /** Destination wallet for the purchased USDC (the buyer hot wallet). */
  recipient: string;
  /** Crossmint chain id: 'base' (mainnet) or 'base-sepolia' (testnet). */
  chain: string;
  /** USDC contract address on that chain. */
  tokenAddress: string;
  /** USD spend, e.g. "10". */
  amount: string;
  onError?: (message: string) => void;
};

/** Map an EVM chain id to Crossmint's chain string. */
export function crossmintChain(chainId: number | undefined): string | null {
  if (chainId === 8453) return 'base';
  if (chainId === 84532) return 'base-sepolia';
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function createOnrampOrder(
  cfg: CrossmintConfig,
  params: { recipient: string; chain: string; tokenAddress: string; amount: string; email: string },
): Promise<CreatedOrder> {
  const response = await fetch(`${cfg.apiBase}/api/2022-06-09/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.clientKey },
    body: JSON.stringify({
      lineItems: [{
        tokenLocator: `${params.chain}:${params.tokenAddress}`,
        executionParameters: { mode: 'exact-in', amount: params.amount },
      }],
      payment: { method: 'card', receiptEmail: params.email },
      recipient: { walletAddress: params.recipient },
    }),
  });
  const data = await response.json().catch(() => null) as
    | { clientSecret?: string; order?: { orderId?: string }; orderId?: string; message?: string; error?: string }
    | null;
  if (!response.ok || !data) {
    throw new Error(data?.message || data?.error || `Crossmint order failed (${response.status})`);
  }
  const orderId = data.order?.orderId ?? data.orderId;
  const clientSecret = data.clientSecret;
  if (!orderId || !clientSecret) {
    throw new Error('Crossmint did not return an order to pay.');
  }
  return { orderId, clientSecret };
}

export function CrossmintCheckout({ recipient, chain, tokenAddress, amount, onError }: Props) {
  const [config, setConfig] = useState<CrossmintConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [order, setOrder] = useState<CreatedOrder | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.antseedDesktop?.paymentsCrossmintConfig?.().then((result) => {
      if (cancelled) return;
      if (result.ok && result.data) setConfig(result.data);
      else setConfigError(result.error ?? 'Card payments are not configured.');
    }).catch((err: unknown) => {
      if (!cancelled) setConfigError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, []);

  // A change to amount/recipient invalidates a created order — the user starts
  // the checkout again for the new figures.
  useEffect(() => { setOrder(null); }, [amount, recipient, chain]);

  const emailValid = useMemo(() => EMAIL_RE.test(email.trim()), [email]);

  const startCheckout = useCallback(async () => {
    if (!config || !emailValid) return;
    setCreating(true);
    onError?.('');
    try {
      setOrder(await createOnrampOrder(config, { recipient, chain, tokenAddress, amount, email: email.trim() }));
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [config, emailValid, recipient, chain, tokenAddress, amount, email, onError]);

  if (configError) {
    return <div className={styles.notice} role="alert">{configError}</div>;
  }
  if (!config) {
    return <div className={styles.notice}>Loading secure checkout…</div>;
  }

  if (order) {
    return (
      <div className={styles.embed}>
        <CrossmintProvider apiKey={config.clientKey}>
          <CrossmintEmbeddedCheckout
            orderId={order.orderId}
            clientSecret={order.clientSecret}
            payment={{
              receiptEmail: email.trim(),
              crypto: { enabled: false },
              fiat: { enabled: true },
              defaultMethod: 'fiat',
            }}
          />
        </CrossmintProvider>
      </div>
    );
  }

  return (
    <form
      className={styles.form}
      onSubmit={(event) => { event.preventDefault(); void startCheckout(); }}
    >
      <label className={styles.field}>
        <span>Email for your receipt</span>
        <input
          type="email"
          value={email}
          placeholder="you@example.com"
          autoComplete="email"
          spellCheck={false}
          onChange={(event) => setEmail(event.currentTarget.value)}
          disabled={creating}
        />
      </label>
      <button type="submit" className={styles.startButton} disabled={!emailValid || creating || Number(amount) <= 0}>
        {creating ? 'Preparing…' : `Continue to pay $${Number(amount) > 0 ? amount : ''}`}
      </button>
      <p className={styles.hint}>
        Card details never touch AntSeed — payment runs on Crossmint's secure checkout.
        The USDC you buy is delivered on Base and deposited to your credits automatically.
      </p>
    </form>
  );
}

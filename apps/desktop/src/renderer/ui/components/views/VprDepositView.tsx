import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Copy01Icon,
  CreditCardIcon,
  SquareLock01Icon,
  Tick02Icon,
  Wallet01Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { formatCredits, shortAddress } from '../../../core/format';
import { VprBackTitle, VprCard } from '../vpr/VprKit';
import { takeDepositIntent, type DepositMethod } from '../../lib/depositIntent';
import type { DepositWatchStatus } from '../../../types/bridge';
import styles from './VprDepositView.module.scss';

const AMOUNT_PRESETS = ['5', '10', '25'];

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };
type Stage = 'choose' | DepositMethod;

// The chooser sits "before" both method screens on the slide axis, so
// entering a method slides forward and going back slides back — same
// mechanics as ViewHost, reusing the global .view-pane animations.
const STAGE_INDEX: Record<Stage, number> = { choose: 0, crypto: 1, card: 1 };
// Must match the .view-pane-in/-out animation duration (--motion-duration).
const STAGE_SLIDE_MS = 300;

type StageSlide = { stage: Stage; previous: Stage | null; direction: 'forward' | 'back' };

type DepositWatchInfo = {
  address: string;
  usdcAddress: string;
  chainId: number;
};

function amountToBaseUnits(amount: string): bigint | null {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  return BigInt(Math.round(value * 1e6));
}

function baseUnitsToUsd(baseUnits: string | undefined): string {
  if (!baseUnits) return '0';
  const value = Number(baseUnits) / 1e6;
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** EIP-681 payment request: opens a prefilled USDC transfer in mobile wallets. */
function buildPaymentUri(info: DepositWatchInfo, amount: string): string {
  const baseUnits = amountToBaseUnits(amount);
  const base = `ethereum:${info.usdcAddress}@${info.chainId}/transfer?address=${info.address}`;
  return baseUnits ? `${base}&uint256=${baseUnits.toString()}` : base;
}

function explorerTxUrl(chainId: number | undefined, txHash: string): string | null {
  if (chainId === 8453) return `https://basescan.org/tx/${txHash}`;
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${txHash}`;
  return null;
}

const TRUST_POINTS: Array<{ icon: IconSvgElement; text: string }> = [
  { icon: SquareLock01Icon, text: 'Non-custodial — your credits sit in AntSeed’s on-chain escrow contract, and your in-app signer never holds funds itself.' },
  { icon: Wallet01Icon, text: 'Withdraw unused credits back to your own wallet at any time.' },
  { icon: Tick02Icon, text: 'Pay per request — no subscriptions, no lock-in.' },
];

/**
 * Deposit flow: a method chooser first (two full-width CTAs), then a
 * per-method screen — Crypto shows the scan-to-pay QR watched by the
 * main-process sweeper; Credit Card hands off to the Coinbase Onramp page.
 * Only pages that need an external wallet signature leave the app.
 */
export function VprDepositView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    available: state.creditsAvailableUsdc,
    total: state.creditsTotalUsdc,
  }), shallowEqual);

  const [slide, setSlide] = useState<StageSlide>(() => ({
    stage: takeDepositIntent() ?? 'choose',
    previous: null,
    direction: 'forward',
  }));
  const stage = slide.stage;
  const [amount, setAmount] = useState('10');
  const [watchInfo, setWatchInfo] = useState<DepositWatchInfo | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [watchStatus, setWatchStatus] = useState<DepositWatchStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [onrampNotice, setOnrampNotice] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);

  const goToStage = useCallback((next: Stage) => {
    setSlide((current) => current.stage === next ? current : {
      stage: next,
      previous: current.stage,
      direction: STAGE_INDEX[next] >= STAGE_INDEX[current.stage] ? 'forward' : 'back',
    });
  }, []);

  useEffect(() => {
    if (!slide.previous) return undefined;
    const timer = window.setTimeout(() => {
      setSlide((current) => (current.previous ? { ...current, previous: null } : current));
    }, STAGE_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [slide]);

  // The main process watches the hot wallet for incoming USDC and sweeps it
  // into the Deposits contract while this view is mounted. Both methods use
  // the watcher: QR transfers and Coinbase Onramp deliveries land in the
  // same wallet.
  useEffect(() => {
    const bridge = window.antseedDesktop;
    let cancelled = false;
    void bridge?.depositsWatchStart?.().then((result) => {
      if (cancelled) return;
      if (result.ok && result.data) {
        setWatchInfo({ address: result.data.address, usdcAddress: result.data.usdcAddress, chainId: result.data.chainId });
      } else {
        setWatchError(result.error ?? 'Deposit watcher unavailable');
      }
    }).catch((err: unknown) => {
      if (!cancelled) setWatchError(err instanceof Error ? err.message : String(err));
    });
    const unsubscribe = bridge?.onDepositsWatchStatus?.((status) => {
      setWatchStatus(status);
      if (status.phase === 'credited') actions.refreshCredits();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
      void bridge?.depositsWatchStop?.();
    };
  }, [actions]);

  // QR follows the entered amount so a scanning wallet prefills the transfer.
  useEffect(() => {
    if (stage !== 'crypto' || !watchInfo) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(buildPaymentUri(watchInfo, amount), {
      margin: 1,
      width: 360,
      errorCorrectionLevel: 'M',
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    }).catch(() => {
      if (!cancelled) setQrDataUrl(null);
    });
    return () => { cancelled = true; };
  }, [stage, watchInfo, amount]);

  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
  }, []);

  const copyAddress = useCallback(() => {
    if (!watchInfo) return;
    void navigator.clipboard.writeText(watchInfo.address).then(() => {
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, [watchInfo]);

  const [payPageNotice, setPayPageNotice] = useState<string | null>(null);

  const openBrowserWallet = useCallback(() => {
    setPayPageNotice(null);
    const call = window.antseedDesktop?.paymentsOpenPayPage?.({ kind: 'deposit', amountUsdc: amount });
    if (!call) {
      setPayPageNotice('Payment page unavailable in this build.');
      return;
    }
    void call.then((result) => {
      if (!result.ok) setPayPageNotice(result.error ?? 'Could not open the payment window.');
    }).catch((err: unknown) => {
      setPayPageNotice(err instanceof Error ? err.message : String(err));
    });
  }, [amount]);

  const openOnramp = useCallback(() => {
    setOnrampNotice(null);
    void window.antseedDesktop?.paymentsOpenOnramp?.({ amountUsdc: amount }).then((result) => {
      if (!result.ok) {
        setOnrampNotice(result.error === 'onramp-not-configured'
          ? 'Card payments are not available yet on this install. You can deposit with a crypto wallet instead.'
          : result.error ?? 'Could not open the payment page.');
      }
    });
  }, [amount]);

  const statusLine = (() => {
    if (watchError) return { tone: 'error' as const, text: watchError };
    if (!watchStatus) return { tone: 'idle' as const, text: 'Waiting for USDC on Base…' };
    switch (watchStatus.phase) {
      case 'received':
        return { tone: 'busy' as const, text: `Received $${baseUnitsToUsd(watchStatus.amountBaseUnits)} — preparing deposit…` };
      case 'sweeping':
        return { tone: 'busy' as const, text: `Depositing $${baseUnitsToUsd(watchStatus.amountBaseUnits)} to your credits…` };
      case 'credited':
        return { tone: 'done' as const, text: `$${baseUnitsToUsd(watchStatus.amountBaseUnits)} added to your balance` };
      case 'error':
        return { tone: 'error' as const, text: watchStatus.error ?? 'Deposit failed' };
    }
  })();

  const creditedTxUrl = watchStatus?.phase === 'credited' && watchStatus.txHash
    ? explorerTxUrl(watchInfo?.chainId, watchStatus.txHash)
    : null;

  const watchStatusRow = (
    <div className={`${styles.watchStatus} ${styles[`watchStatus_${statusLine.tone}`] ?? ''}`} role="status">
      {(statusLine.tone === 'idle' || statusLine.tone === 'busy') && <span className={styles.watchPulse} aria-hidden="true" />}
      {statusLine.text}
    </div>
  );

  const amountForm = (
    <VprCard className={styles.amountCard}>
      <span className={styles.amountLabel}>Amount to add</span>
      <div className={styles.amountRow}>
        {AMOUNT_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`${styles.amountPreset}${amount === preset ? ` ${styles.amountPresetActive}` : ''}`}
            onClick={() => setAmount(preset)}
          >
            ${preset}
          </button>
        ))}
        <div className={styles.amountInputWrap}>
          <span>$</span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            aria-label="Deposit amount in USD"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          />
        </div>
      </div>
      <span className={styles.amountHint}>
        1 credit = 1 USDC{Number(snap.total) === 0 ? ' · Minimum first deposit is $1' : ''}
      </span>
    </VprCard>
  );

  function renderStage(current: Stage): JSX.Element {
    if (current === 'choose') {
      return (
        <div className={styles.stack}>
          <VprBackTitle title="Add credits" onBack={() => onSelectView?.('credits')} />

          <VprCard className={styles.balanceCard}>
            <span className={styles.balanceLabel}>Available balance</span>
            <span className={styles.balanceValue}>${formatCredits(snap.available)}</span>
            <span className={styles.balanceHint}>
              Credits are USDC held for you in AntSeed's on-chain escrow. You only pay for
              what you use, and unused credits can be withdrawn anytime.
            </span>
          </VprCard>

          <span className={styles.chooseLabel}>How would you like to pay?</span>

          <button type="button" className={styles.methodCta} onClick={() => goToStage('crypto')}>
            <span className={styles.methodCtaIcon}>
              <HugeiconsIcon icon={Wallet01Icon} size={20} strokeWidth={1.8} />
            </span>
            <span className={styles.methodCtaText}>
              <span className={styles.methodCtaTitle}>Crypto</span>
              <span className={styles.methodCtaCaption}>Send USDC on Base from any wallet or exchange</span>
            </span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={18} strokeWidth={2} className={styles.methodCtaArrow} />
          </button>

          <button type="button" className={styles.methodCta} onClick={() => goToStage('card')}>
            <span className={styles.methodCtaIcon}>
              <HugeiconsIcon icon={CreditCardIcon} size={20} strokeWidth={1.8} />
            </span>
            <span className={styles.methodCtaText}>
              <span className={styles.methodCtaTitle}>Credit Card</span>
              <span className={styles.methodCtaCaption}>Visa, Mastercard or Apple Pay via Coinbase</span>
            </span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={18} strokeWidth={2} className={styles.methodCtaArrow} />
          </button>

          <VprCard className={styles.trustCard}>
            {TRUST_POINTS.map(({ icon, text }) => (
              <div key={text} className={styles.trustRow}>
                <HugeiconsIcon icon={icon} size={14} strokeWidth={2} />
                <span>{text}</span>
              </div>
            ))}
          </VprCard>
        </div>
      );
    }

    if (current === 'crypto') {
      return (
        <div className={styles.stack}>
          <VprBackTitle title="Pay with crypto" onBack={() => goToStage('choose')} />

          {amountForm}

          <VprCard className={styles.payCard}>
            {qrDataUrl ? (
              <img className={styles.qr} src={qrDataUrl} alt="Scan to send USDC on Base" />
            ) : (
              <div className={styles.qrPlaceholder} aria-hidden="true" />
            )}
            <div className={styles.methodHint}>
              Scan to send <strong>USDC on Base</strong>, or copy the address below.
              Credits update automatically within seconds of the transfer landing.
            </div>
            {watchInfo && (
              <button type="button" className={styles.addressRow} onClick={copyAddress} title={watchInfo.address}>
                <code>{shortAddress(watchInfo.address)}</code>
                <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={14} strokeWidth={2} />
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            )}
            {watchStatusRow}
            {creditedTxUrl && (
              <button
                type="button"
                className={styles.txLink}
                onClick={() => void window.antseedDesktop?.openExternalUrl?.(creditedTxUrl)}
              >
                <span>View transaction</span>
                <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />
              </button>
            )}
            <div className={styles.networkWarn}>
              Only send USDC on the <strong>Base</strong> network — assets sent on other
              networks can't be recovered.
            </div>
          </VprCard>

          <button type="button" className={styles.browserWalletLink} onClick={openBrowserWallet}>
            <span>No wallet on your phone? Pay from a connected wallet instead</span>
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />
          </button>
          {payPageNotice && <div className={styles.cardNotice} role="alert">{payPageNotice}</div>}
        </div>
      );
    }

    return (
      <div className={styles.stack}>
        <VprBackTitle title="Pay with card" onBack={() => goToStage('choose')} />

        {amountForm}

        <VprCard className={styles.payCard}>
          <button type="button" className={styles.onrampButton} onClick={openOnramp}>
            <span>Pay ${Number(amount) > 0 ? amount : ''} with Coinbase</span>
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} />
          </button>
          <div className={styles.methodHint}>
            You'll finish the payment on Coinbase's secure checkout page — card details
            never touch AntSeed. The USDC you buy is delivered on Base and deposited to
            your credits automatically.
          </div>
          {onrampNotice && <div className={styles.cardNotice} role="alert">{onrampNotice}</div>}
          {watchStatus && statusLine.tone !== 'idle' && watchStatusRow}
          {creditedTxUrl && (
            <button
              type="button"
              className={styles.txLink}
              onClick={() => void window.antseedDesktop?.openExternalUrl?.(creditedTxUrl)}
            >
              <span>View transaction</span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />
            </button>
          )}
        </VprCard>

        <div className={styles.secureNote}>
          <HugeiconsIcon icon={SquareLock01Icon} size={12} strokeWidth={2} />
          <span>Encrypted &amp; secure checkout</span>
        </div>
      </div>
    );
  }

  const sliding = slide.previous !== null;

  return (
    <section
      className={`view-host view-vpr-deposit${sliding ? ` view-host-sliding view-host-${slide.direction}` : ''}`}
      role="tabpanel"
    >
      {slide.previous && (
        <div key={`out-${slide.previous}`} className="view-pane view-pane-out" aria-hidden="true">
          <div className={`view ${styles.view}`}>{renderStage(slide.previous)}</div>
        </div>
      )}
      <div key={stage} className={`view-pane${sliding ? ' view-pane-in' : ''}`}>
        <div className={`view ${styles.view}`}>{renderStage(stage)}</div>
      </div>
    </section>
  );
}

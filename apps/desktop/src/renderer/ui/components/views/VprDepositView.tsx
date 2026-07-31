import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Copy01Icon,
  CreditCardIcon,
  QrCodeIcon,
  SquareLock01Icon,
  Tick02Icon,
  Wallet01Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { formatCredits, shortAddress } from '../../../core/format';
import { VprCard, VprPage } from '../vpr/VprKit';
import { takeDepositIntent, type DepositMethod } from '../../lib/depositIntent';
import type { DepositWatchStatus } from '../../../types/bridge';
import { CrossmintCheckout, crossmintChain } from './CrossmintCheckout';
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

// ─── Styled QR (round dots, rounded finders, Base badge) ───

/** Official Base mark (24×24): blue disc with the white horizontal slot. */
const BASE_LOGO_PATH =
  'M12 24C18.6274 24 24 18.6274 24 12C24 5.37258 18.6274 0 12 0C5.72532 0 ' +
  '0.578514 4.81465 0.0491943 10.9512H15.8916V13.0488H0.0491943C0.578514 ' +
  '19.1853 5.72532 24 12 24Z';

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x + r},${y} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} ` +
    `a${r},${r} 0 0 1 ${-r},${r} h${-(w - 2 * r)} a${r},${r} 0 0 1 ${-r},${-r} ` +
    `v${-(h - 2 * r)} a${r},${r} 0 0 1 ${r},${-r} z`;
}

/** One finder eye: outer rounded ring (even-odd hole) + solid rounded pupil. */
function finderPaths(x: number, y: number): [string, string] {
  return [
    roundedRectPath(x, y, 7, 7, 2.2) + ' ' + roundedRectPath(x + 1, y + 1, 5, 5, 1.6),
    roundedRectPath(x + 2, y + 2, 3, 3, 1.05),
  ];
}

/**
 * Renders the payment QR as themed SVG: round data dots, rounded finder
 * eyes, and the Base logo in a punched-out center badge. Error correction is
 * 'Q' (25%) so the ~4% of modules hidden by the badge stay well within the
 * recovery budget.
 */
function StyledQr({ text, label }: { text: string; label: string }) {
  const matrix = useMemo(() => {
    try {
      const qr = QRCode.create(text, { errorCorrectionLevel: 'Q' });
      return { size: qr.modules.size, data: qr.modules.data as Uint8Array };
    } catch {
      return null;
    }
  }, [text]);

  if (!matrix) return <div className={styles.qrPlaceholder} aria-hidden="true" />;
  const { size, data } = matrix;
  const center = size / 2;
  const badgeR = size * 0.11; // badge diameter ≈ 22% of QR width
  const clearR = badgeR + 0.6; // dot clearance around the badge
  const logoR = badgeR * 0.82;

  const inFinder = (row: number, col: number): boolean =>
    (row < 7 && col < 7) || (row < 7 && col >= size - 7) || (row >= size - 7 && col < 7);
  const underBadge = (row: number, col: number): boolean =>
    Math.hypot(row + 0.5 - center, col + 0.5 - center) < clearR;

  const dots: JSX.Element[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!data[row * size + col]) continue;
      if (inFinder(row, col) || underBadge(row, col)) continue;
      dots.push(<circle key={`${row}-${col}`} cx={col + 0.5} cy={row + 0.5} r={0.34} />);
    }
  }

  return (
    <svg className={styles.qr} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <g fill="currentColor">
        {dots}
        {[[0, 0], [size - 7, 0], [0, size - 7]].map(([x, y]) => {
          const [ring, pupil] = finderPaths(x!, y!);
          return (
            <g key={`${x}-${y}`}>
              <path d={ring} fillRule="evenodd" />
              <path d={pupil} />
            </g>
          );
        })}
      </g>
      <circle cx={center} cy={center} r={badgeR} className={styles.qrBadgeBg} />
      <circle cx={center} cy={center} r={logoR} fill="#fff" />
      <path
        d={BASE_LOGO_PATH}
        fill="#0052FF"
        transform={`translate(${center - logoR}, ${center - logoR}) scale(${(logoR * 2) / 24})`}
      />
    </svg>
  );
}

// ─── Payment brand marks ───
// Hand-authored, recognizable-but-generic geometric marks (same idiom as
// BrandIcon) — small trust cues on the deposit option rows.

const USDC_BLUE = '#2775CA';

function UsdcMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill={USDC_BLUE} />
      <text x="12" y="16.6" textAnchor="middle" fontSize="13.5" fontWeight="700" fill="#fff">$</text>
    </svg>
  );
}

function BaseMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#0052FF" />
      <rect x="1" y="10.95" width="15.85" height="2.1" fill="#fff" />
    </svg>
  );
}

function MastercardMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="12" r="7.5" fill="#EB001B" />
      <circle cx="15" cy="12" r="7.5" fill="#F79E1B" fillOpacity="0.9" />
    </svg>
  );
}

function VisaMark({ size = 18 }: { size?: number }) {
  const width = Math.round(size * (34 / 24));
  return (
    <svg width={width} height={size} viewBox="0 0 34 24" aria-hidden="true">
      <rect width="34" height="24" rx="5" fill="#1434CB" />
      <text x="17" y="15.8" textAnchor="middle" fontSize="9" fontWeight="800" fontStyle="italic" fill="#fff">VISA</text>
    </svg>
  );
}

/** Official Meridian (mrdn.finance) mark — the green pinwheel favicon. */
function MeridianMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 542.25 542.25" fill="#34D399" aria-hidden="true">
      <path d="M493.18,424.48l-106.09,106.09c-7.48,7.48-17.63,11.69-28.21,11.69h-192.03l250.27-250.27,76.06,76.06c15.58,15.58,15.58,40.85,0,56.43Z" />
      <path d="M375.41,0L125.14,250.27l-76.06-76.06c-15.58-15.58-15.58-40.85,0-56.43L155.16,11.69c7.48-7.48,17.63-11.69,28.21-11.69h192.03Z" />
      <path d="M542.25,375.41l-250.27-250.27,76.06-76.06c15.58-15.58,40.85-15.58,56.43,0l106.09,106.09c7.48,7.48,11.69,17.63,11.69,28.21v192.03Z" />
      <path d="M250.27,417.12l-76.06,76.06c-15.58,15.58-40.85,15.58-56.43,0L11.69,387.09c-7.48-7.48-11.69-17.63-11.69-28.21v-192.03l250.27,250.27Z" />
    </svg>
  );
}

/** Official fun.xyz mark — the flag glyph from their favicon. */
function FunMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={Math.round(size * (15 / 20))} height={size} viewBox="0 0 15 20" fill="currentColor" aria-hidden="true">
      <path d="M6.44189 1.38892L14.1668 5.5V14.4999L6.44189 18.611V1.38892Z" />
      <path d="M7.27555 2.775L13.3339 6V13.9972L7.27555 17.2222V2.775ZM5.60889 0V20L15.0006 15V5L5.60889 0Z" />
      <path d="M2.80615 0V20L4.20893 19.2528V0.747222L2.80615 0Z" />
      <path d="M0 0V20L1.40278 19.2528V0.747222L0 0Z" />
    </svg>
  );
}

function EthMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#627EEA" />
      <path d="M12 4l4.5 8.1L12 14.9 7.5 12.1 12 4z" fill="#fff" fillOpacity="0.9" />
      <path d="M12 16.1l4.5-2.9L12 20l-4.5-6.8 4.5 2.9z" fill="#fff" fillOpacity="0.75" />
    </svg>
  );
}

/** The AntSeed seed mark (from assets/antseed-mark.svg, core shapes only). */
function AntSeedMark({ size = 22, color = '#1FD87A' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" aria-hidden="true">
      <ellipse cx="40" cy="22" rx="5" ry="5.5" fill={color} opacity="0.9" />
      <ellipse cx="40" cy="36" rx="7" ry="8" fill={color} />
      <ellipse cx="40" cy="55" rx="9" ry="12" fill={color} opacity="0.9" />
      <line x1="37" y1="17" x2="28" y2="6" stroke={color} strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <line x1="43" y1="17" x2="52" y2="6" stroke={color} strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <circle cx="28" cy="6" r="2.5" fill={color} opacity="0.6" />
      <circle cx="52" cy="6" r="2.5" fill={color} opacity="0.6" />
    </svg>
  );
}

function explorerTxUrl(chainId: number | undefined, txHash: string): string | null {
  if (chainId === 8453) return `https://basescan.org/tx/${txHash}`;
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${txHash}`;
  return null;
}

/** A selectable card option: hosted URL providers (Coinbase, etc.) plus the
    in-app Crossmint embedded checkout. */
type CardProvider = { id: string; label: string };
type CardOption = { id: string; label: string; kind: 'url' | 'crossmint' };

const CARD_NOT_CONFIGURED_NOTICE =
  'Card payments are not available yet on this install. You can deposit USDC on Base instead.';

const TRUST_POINTS: Array<{ icon: IconSvgElement; text: string }> = [
  { icon: SquareLock01Icon, text: 'Non-custodial — your credits sit in AntSeed’s on-chain escrow contract, and your in-app signer never holds funds itself.' },
  { icon: Wallet01Icon, text: 'Withdraw unused credits back to your own wallet at any time.' },
  { icon: Tick02Icon, text: 'Pay per request — no subscriptions, no lock-in.' },
];

/**
 * Deposit flow: a method chooser first (two full-width CTAs), then a
 * per-method screen — Crypto shows the scan-to-pay QR watched by the
 * main-process sweeper; Credit Card hands off to a configured card-payment
 * provider's hosted checkout page.
 * Only pages that need an external wallet signature leave the app.
 */
export function VprDepositView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    spendable: state.creditsSpendableUsdc,
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
  const [copied, setCopied] = useState(false);
  const [cardNotice, setCardNotice] = useState<string | null>(null);
  // null = not fetched yet; [] = fetched, none configured.
  const [cardProviders, setCardProviders] = useState<CardProvider[] | null>(null);
  const [crossmintAvailable, setCrossmintAvailable] = useState(false);
  // Which card option is being paid in-app; null shows the option chooser.
  // Only Crossmint renders in-app; URL providers open an external page.
  const [cardMethod, setCardMethod] = useState<'crossmint' | null>(null);
  // "More options" expander on the chooser — the Fun CTA leads, everything
  // else (QR transfer, hosted card pages, Crossmint) sits behind this link.
  const [moreOpen, setMoreOpen] = useState(false);
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
  // the watcher: QR transfers and card-purchase deliveries land in the
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

  // Fetch card options (hosted URL providers + whether Crossmint is
  // configured) once on first entry to the card stage.
  useEffect(() => {
    if (stage !== 'card' || cardProviders !== null) return undefined;
    let cancelled = false;
    const bridge = window.antseedDesktop;
    void Promise.all([
      bridge?.paymentsCardProviders?.() ?? Promise.resolve(null),
      bridge?.paymentsCrossmintConfig?.() ?? Promise.resolve(null),
    ]).then(([providers, crossmint]) => {
      if (cancelled) return;
      setCardProviders(providers?.ok && providers.data ? providers.data : []);
      setCrossmintAvailable(Boolean(crossmint?.ok && crossmint.data?.clientKey));
    }).catch(() => {
      if (!cancelled) { setCardProviders([]); setCrossmintAvailable(false); }
    });
    return () => { cancelled = true; };
  }, [stage, cardProviders]);

  // Re-entering the card stage always starts at the option chooser.
  useEffect(() => {
    if (stage !== 'card') setCardMethod(null);
  }, [stage]);

  const openCardProvider = useCallback((providerId: string) => {
    setCardNotice(null);
    void window.antseedDesktop?.paymentsOpenCardProvider?.({ providerId, amountUsdc: amount }).then((result) => {
      if (!result.ok) {
        setCardNotice(result.error === 'card-not-configured'
          ? CARD_NOT_CONFIGURED_NOTICE
          : result.error ?? 'Could not open the payment page.');
      }
    });
  }, [amount]);

  const cardOptions = useMemo<CardOption[]>(() => {
    const urlOptions: CardOption[] = (cardProviders ?? []).map((p) => ({ id: p.id, label: p.label, kind: 'url' }));
    return crossmintAvailable
      ? [...urlOptions, { id: 'crossmint', label: 'Crossmint', kind: 'crossmint' }]
      : urlOptions;
  }, [cardProviders, crossmintAvailable]);

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

  // Status line, tone told by the leading mark: orange pulse while waiting,
  // green pulse once funds are detected/sweeping, a check mark when credited.
  // Dot color is inlined (not a CSS descendant rule) so the tone switch can
  // never be lost to stylesheet scoping.
  const dotColor = statusLine.tone === 'busy'
    ? 'var(--accent-green)'
    : statusLine.tone === 'error'
      ? 'var(--accent-red, #d64545)'
      : '#f59e0b';
  const watchStatusRow = (
    <div className={`${styles.watchStatus} ${styles[`watchStatus_${statusLine.tone}`] ?? ''}`} role="status">
      {statusLine.tone === 'done' ? (
        <HugeiconsIcon icon={Tick02Icon} size={15} strokeWidth={2.5} className={styles.watchCheck} />
      ) : (
        <span
          className={`${styles.watchPulse}${statusLine.tone === 'error' ? ` ${styles.watchPulseStatic}` : ''}`}
          style={{ background: dotColor }}
          aria-hidden="true"
        />
      )}
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
        <VprPage title="Add credits" backFallback="credits">
        <div className={styles.stack}>

          <VprCard className={styles.balanceCard}>
            <span className={styles.balanceLabel}>Your balance</span>
            <span className={styles.balanceValue}>${formatCredits(snap.spendable)}</span>
            <span className={styles.balanceHint}>
              Credits are USDC held for you in AntSeed's on-chain escrow. You only pay for
              what you use, and unused credits can be withdrawn anytime.
            </span>
          </VprCard>

          {/* Primary path: deposit through Fun (fun.xyz). The Fun checkout
              only runs on the web; until our hosted integration is live this
              opens their site directly. */}
          <button
            type="button"
            className={styles.funCta}
            onClick={() => void window.antseedDesktop?.openExternalUrl?.('https://fun.xyz')}
          >
            <span>Deposit with</span>
            <span className={styles.funBrand} aria-label="Fun">
              <FunMark size={16} />
              <span>fun</span>
            </span>
          </button>
          {payPageNotice && <div className={styles.cardNotice} role="alert">{payPageNotice}</div>}

          <button
            type="button"
            className={styles.moreLink}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <span>More options</span>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={16}
              strokeWidth={2}
              className={`${styles.moreLinkChevron}${moreOpen ? ` ${styles.moreLinkChevronOpen}` : ''}`}
            />
          </button>

          {moreOpen && (
            <div className={styles.optionList}>
              <button type="button" className={styles.methodCta} onClick={() => goToStage('crypto')}>
                <span className={styles.methodCtaIcon}>
                  <UsdcMark size={22} />
                </span>
                <span className={styles.methodCtaText}>
                  <span className={styles.methodCtaTitle}>USDC on Base</span>
                  <span className={styles.methodCtaCaption}>No limit · Instant</span>
                </span>
                <span className={styles.methodBadges} aria-hidden="true">
                  <BaseMark />
                  <span className={styles.badgeChip}>
                    <HugeiconsIcon icon={QrCodeIcon} size={12} strokeWidth={2} />
                  </span>
                </span>
                <HugeiconsIcon icon={ArrowRight01Icon} size={18} strokeWidth={2} className={styles.methodCtaArrow} />
              </button>

              {/* Fixed lineup — deliberately NOT the configurable card
                  provider list, which may carry legacy entries. These two ids
                  always resolve in the main process. */}
              <button type="button" className={styles.methodCta} onClick={() => openCardProvider('meridian')}>
                <span className={styles.methodCtaIcon}>
                  <MeridianMark />
                </span>
                <span className={styles.methodCtaText}>
                  <span className={styles.methodCtaTitle}>Meridian</span>
                  <span className={styles.methodCtaCaption}>Crypto · Cross-chain</span>
                </span>
                <span className={styles.methodBadges} aria-hidden="true">
                  <EthMark />
                  <BaseMark />
                  <span className={styles.badgeChip}>+</span>
                </span>
                <HugeiconsIcon icon={ArrowUpRight01Icon} size={18} strokeWidth={2} className={styles.methodCtaArrow} />
              </button>

              <button type="button" className={styles.methodCta} onClick={() => openCardProvider('antseed-pay')}>
                <span className={styles.methodCtaIcon}>
                  <AntSeedMark color="#F5B90F" />
                </span>
                <span className={styles.methodCtaText}>
                  <span className={styles.methodCtaTitle}>AntSeed Pay</span>
                  <span className={styles.methodCtaCaption}>Card or Apple Pay · Stripe checkout</span>
                </span>
                <span className={styles.methodBadges} aria-hidden="true">
                  <VisaMark />
                  <MastercardMark />
                </span>
                <HugeiconsIcon icon={ArrowUpRight01Icon} size={18} strokeWidth={2} className={styles.methodCtaArrow} />
              </button>
              {cardNotice && <div className={styles.cardNotice} role="alert">{cardNotice}</div>}
            </div>
          )}

          <div className={styles.secureNote}>
            <HugeiconsIcon icon={SquareLock01Icon} size={12} strokeWidth={2} />
            <span>Encrypted &amp; secure · Non-custodial escrow on Base</span>
          </div>

          <VprCard className={styles.trustCard}>
            {TRUST_POINTS.map(({ icon, text }) => (
              <div key={text} className={styles.trustRow}>
                <HugeiconsIcon icon={icon} size={14} strokeWidth={2} />
                <span>{text}</span>
              </div>
            ))}
          </VprCard>
        </div>
        </VprPage>
      );
    }

    if (current === 'crypto') {
      return (
        <VprPage title="Pay with USDC on Base" onBack={() => goToStage('choose')}>
        <div className={styles.stack}>

          {amountForm}

          <VprCard className={styles.payCard}>
            {watchInfo ? (
              <StyledQr text={buildPaymentUri(watchInfo, amount)} label="Scan to send USDC on Base" />
            ) : (
              <div className={styles.qrPlaceholder} aria-hidden="true" />
            )}
            {watchInfo && (
              <button type="button" className={styles.addressRow} onClick={copyAddress} title={watchInfo.address}>
                <code>{shortAddress(watchInfo.address)}</code>
                <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={14} strokeWidth={2} />
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            )}
            {watchStatusRow}
            <div className={styles.qrMeta}>
              <span>Credits update automatically</span>
              <span aria-hidden="true">·</span>
              <span>$0.05 network fee</span>
            </div>
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
              Only send USDC on <strong>Base</strong> — other networks won't
              auto-deposit.
            </div>
          </VprCard>

          <button type="button" className={styles.browserWalletLink} onClick={openBrowserWallet}>
            <span>No wallet on your phone? Pay from a connected wallet instead</span>
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />
          </button>
          {payPageNotice && <div className={styles.cardNotice} role="alert">{payPageNotice}</div>}
        </div>
        </VprPage>
      );
    }

    const creditedTxLink = creditedTxUrl ? (
      <button
        type="button"
        className={styles.txLink}
        onClick={() => void window.antseedDesktop?.openExternalUrl?.(creditedTxUrl)}
      >
        <span>View transaction</span>
        <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />
      </button>
    ) : null;

    // In-app Crossmint embedded checkout — one of the card options.
    if (cardMethod === 'crossmint') {
      const cmChain = crossmintChain(watchInfo?.chainId);
      return (
        <VprPage title="Pay with Crossmint" onBack={() => { setCardMethod(null); setCardNotice(null); }}>
        <div className={styles.stack}>

          {amountForm}

          <VprCard className={styles.payCard}>
            {watchError ? (
              <div className={styles.cardNotice} role="alert">{watchError}</div>
            ) : !watchInfo ? (
              <div className={styles.methodHint}>Preparing your deposit address…</div>
            ) : !cmChain ? (
              <div className={styles.cardNotice} role="alert">
                Crossmint card purchases are available on Base. Switch to Base in Chain Config to use it.
              </div>
            ) : (
              <CrossmintCheckout
                recipient={watchInfo.address}
                chain={cmChain}
                tokenAddress={watchInfo.usdcAddress}
                amount={amount}
                onError={(msg) => setCardNotice(msg || null)}
              />
            )}
            {cardNotice && <div className={styles.cardNotice} role="alert">{cardNotice}</div>}
            {watchStatus && statusLine.tone !== 'idle' && watchStatusRow}
            {creditedTxLink}
          </VprCard>

          <div className={styles.secureNote}>
            <HugeiconsIcon icon={SquareLock01Icon} size={12} strokeWidth={2} />
            <span>Encrypted &amp; secure checkout</span>
          </div>
        </div>
        </VprPage>
      );
    }

    // Card option chooser: hosted providers (Coinbase, …) plus Crossmint.
    return (
      <VprPage title="Pay with card" onBack={() => goToStage('choose')}>
      <div className={styles.stack}>

        {amountForm}

        {cardOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className={styles.methodCta}
            onClick={() => (option.kind === 'crossmint' ? setCardMethod('crossmint') : openCardProvider(option.id))}
          >
            <span className={styles.methodCtaIcon}>
              <HugeiconsIcon icon={CreditCardIcon} size={20} strokeWidth={1.8} />
            </span>
            <span className={styles.methodCtaText}>
              <span className={styles.methodCtaTitle}>Pay with {option.label}</span>
            </span>
            <HugeiconsIcon
              icon={option.kind === 'crossmint' ? ArrowRight01Icon : ArrowUpRight01Icon}
              size={18}
              strokeWidth={2}
              className={styles.methodCtaArrow}
            />
          </button>
        ))}

        <VprCard className={styles.payCard}>
          {cardProviders === null ? (
            <div className={styles.methodHint}>Loading card options…</div>
          ) : cardOptions.length === 0 ? (
            <div className={styles.cardNotice} role="alert">{CARD_NOT_CONFIGURED_NOTICE}</div>
          ) : (
            <div className={styles.methodHint}>
              Card details never touch AntSeed. The USDC you buy is delivered on Base and
              deposited to your credits automatically (a $0.05 network fee is deducted
              per auto-deposit).
            </div>
          )}
          {cardNotice && <div className={styles.cardNotice} role="alert">{cardNotice}</div>}
          {watchStatus && statusLine.tone !== 'idle' && watchStatusRow}
          {creditedTxLink}
        </VprCard>

        <div className={styles.secureNote}>
          <HugeiconsIcon icon={SquareLock01Icon} size={12} strokeWidth={2} />
          <span>Encrypted &amp; secure checkout</span>
        </div>
      </div>
      </VprPage>
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
          <div className={`view view-pinned-header ${styles.view}`}>{renderStage(slide.previous)}</div>
        </div>
      )}
      <div key={stage} className={`view-pane${sliding ? ' view-pane-in' : ''}`}>
        <div className={`view view-pinned-header ${styles.view}`}>{renderStage(stage)}</div>
      </div>
    </section>
  );
}

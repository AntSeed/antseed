import { useAccount } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Coins01Icon,
  CreditCardIcon,
  FingerPrintScanIcon,
  LockKeyIcon,
  PlugSocketIcon,
  Wallet01Icon,
  WalletAdd01Icon,
} from '@hugeicons/core-free-icons';
import type { BalanceData } from '../types';
import type { TabId } from '../layout/sidebar';
import { useAuthorizedWallet } from '../context/authorized-wallet-context';
import { AntMark } from '../components/ui/ant-seed-logo';

type IconData = Parameters<typeof HugeiconsIcon>[0]['icon'];

interface OverviewHeroProps {
  balance: BalanceData | null;
  onOpenDeposit: () => void;
  onSelectTab: (tab: TabId) => void;
}

export function OverviewHero({
  balance,
  onOpenDeposit,
  onSelectTab,
}: OverviewHeroProps) {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { operatorSet, requireAuthorization } = useAuthorizedWallet();

  if (!balance) return <HeroSkeleton />;

  const totalBalance = parseFloat(balance.total);

  if (!isConnected) {
    return (
      <HeroCard
        tone="accent"
        icon={PlugSocketIcon}
        eyebrow="Get started"
        heading="Connect your wallet"
        sub="Connect a wallet so you can deposit USDC, authorize withdrawals, and claim ANTS rewards."
        ctaIcon={Wallet01Icon}
        ctaLabel="Connect wallet"
        onCta={() => openConnectModal?.()}
      />
    );
  }

  if (totalBalance === 0) {
    return (
      <HeroCard
        tone="accent"
        icon={Coins01Icon}
        eyebrow="One more step"
        heading="Deposit USDC to get started"
        sub="Your AntSeed account is funded by USDC deposits. Add as little as $1 to start using services."
        ctaIcon={WalletAdd01Icon}
        ctaLabel="Deposit"
        onCta={onOpenDeposit}
      />
    );
  }

  if (operatorSet === false) {
    return (
      <HeroCard
        tone="amber"
        icon={FingerPrintScanIcon}
        eyebrow="Action recommended"
        heading="Authorize your wallet"
        sub="Without an authorized wallet you can't withdraw USDC or claim ANTS. Set this once — you keep the keys."
        ctaIcon={LockKeyIcon}
        ctaLabel="Authorize"
        onCta={() => requireAuthorization()}
      />
    );
  }

  if (operatorSet === null) return <HeroSkeleton />;

  return (
    <WelcomeHero
      onOpenDeposit={onOpenDeposit}
      onSelectTab={onSelectTab}
    />
  );
}

function HeroSkeleton() {
  return (
    <section
      className="overview-hero overview-hero--ready"
      aria-busy="true"
      aria-label="Loading account"
    >
      <span className="overview-hero-avatar" aria-hidden="true" />
      <div className="overview-hero-content">
        <span className="skel skel-line skel-line--title" />
        <span className="skel skel-line skel-line--sub" />
      </div>
    </section>
  );
}

interface HeroCardProps {
  tone: 'accent' | 'amber';
  icon: IconData;
  eyebrow: string;
  heading: string;
  sub: string;
  ctaIcon?: IconData;
  ctaLabel: string;
  onCta: () => void;
}

function HeroCard({ tone, icon, eyebrow, heading, sub, ctaIcon, ctaLabel, onCta }: HeroCardProps) {
  return (
    <section className={`overview-hero overview-hero--${tone}`}>
      <span className="overview-hero-icon">
        <HugeiconsIcon icon={icon} size={20} strokeWidth={1.5} />
      </span>
      <div className="overview-hero-content">
        <div className="overview-hero-eyebrow">{eyebrow}</div>
        <h2 className="overview-hero-heading">{heading}</h2>
        <p className="overview-hero-sub">{sub}</p>
      </div>
      <button type="button" className="overview-hero-cta" onClick={onCta}>
        {ctaIcon && <HugeiconsIcon icon={ctaIcon} size={13} strokeWidth={1.8} />}
        {ctaLabel}
      </button>
    </section>
  );
}

interface WelcomeHeroProps {
  onOpenDeposit: () => void;
  onSelectTab: (tab: TabId) => void;
}

function WelcomeHero({ onOpenDeposit, onSelectTab }: WelcomeHeroProps) {
  return (
    <section className="overview-hero overview-hero--ready">
      <span className="overview-hero-avatar" aria-hidden="true">
        <AntMark size={26} />
      </span>

      <div className="overview-hero-content">
        <h2 className="overview-hero-heading">What's next?</h2>
        <p className="overview-hero-sub">Top up your balance, check channels, or claim ANTS rewards.</p>
      </div>

      <div className="overview-hero-actions">
        <button
          type="button"
          className="overview-hero-shortcut"
          onClick={() => onSelectTab('channels')}
        >
          <HugeiconsIcon icon={CreditCardIcon} size={13} strokeWidth={1.5} />
          View channels
        </button>
        <button
          type="button"
          className="overview-hero-shortcut"
          onClick={() => onSelectTab('emissions')}
        >
          Earn $ANTS
        </button>
        <button
          type="button"
          className="overview-hero-deposit"
          onClick={onOpenDeposit}
        >
          <HugeiconsIcon icon={WalletAdd01Icon} size={15} strokeWidth={1.6} />
          Deposit
        </button>
      </div>
    </section>
  );
}

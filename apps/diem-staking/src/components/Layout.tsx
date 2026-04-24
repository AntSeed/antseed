// Static layout sections: Nav, Hero, AlphaStrip, ClaimBanner, HowItWorks, FAQ,
// DualCards, Footer. These don't depend on on-chain state (ClaimBanner and
// Hero take a couple of computed values as props so they can show live APR /
// pool TVL). Every AntStation download link flows through `useAntstationDownload`
// so Mac + Windows visitors get a direct installer href — same behaviour as
// antseed.com.

import { ConnectButton } from '@rainbow-me/rainbowkit';
import type { MouseEvent, ReactNode } from 'react';

import { fmtPct, fmtPrice } from '../lib/format';
import { useAntstationDownload, ANTSTATION_RELEASES_URL, type Platform } from '../lib/antstation';

const ANTSEED_URL = 'https://antseed.com';
const CONTRACT_URL_BASE = 'https://basescan.org/address';

// OS glyph for the primary download button. Matches the mark used in
// apps/website/src/lib/DesktopDownloadIcon.tsx so the two properties feel
// identical across hosts.
function PlatformIcon({ platform, size = 16 }: { platform: Platform; size?: number }) {
  if (platform === 'win') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M3 5.5L11 4.3v7.2H3zM12 4.2L21 3v8.5h-9zM3 12.5h8v7.2L3 18.5zM12 12.5h9V21l-9-1.3z" />
      </svg>
    );
  }
  if (platform === 'mac') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
      </svg>
    );
  }
  return null;
}

// Platforms where we show the OS-specific label + icon. Other platforms
// (Linux / mobile / unknown) keep the brand-generic "Download AntStation →".
function hasDirectInstaller(platform: Platform): platform is 'mac' | 'win' {
  return platform === 'mac' || platform === 'win';
}

export function AlphaStrip({ maxStakeDisplay }: { maxStakeDisplay: string | null }) {
  if (!maxStakeDisplay) {
    return (
      <div className="alpha-strip">
        <span className="alpha-pill">◆ ALPHA</span>
        <span className="alpha-msg">Live on Base mainnet · pool capacity uncapped.</span>
      </div>
    );
  }
  return (
    <div className="alpha-strip">
      <span className="alpha-pill">◆ ALPHA</span>
      <span className="alpha-msg">Alpha cap: <strong>{maxStakeDisplay}</strong> $DIEM total. Owner-raiseable.</span>
    </div>
  );
}

export function Nav() {
  const scrollTo = (id: string) => (e: MouseEvent) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    const nav = document.querySelector<HTMLElement>('.nav');
    const offset = (nav?.offsetHeight ?? 73) + 8;
    window.scrollTo({ top: Math.max(0, el.offsetTop - offset), behavior: 'smooth' });
    history.replaceState(null, '', `#${id}`);
  };
  return (
    <nav className="nav">
      <a className="brand" href="/">
        <span>
          <span className="ant">ANT</span>
          <span className="seed">SEED</span>
        </span>
        <span className="slash">/</span>
        <span className="diem">Diem Staking</span>
      </a>
      <div className="nav-links">
        <a href="#how" onClick={scrollTo('how')} className="link hide-sm">How it works</a>
        <a href="#faq" onClick={scrollTo('faq')} className="link hide-sm">FAQ</a>
        <div className="nav-connect-wrap">
          <ConnectButton
            accountStatus={{ smallScreen: 'avatar', largeScreen: 'full' }}
            chainStatus="none"
            showBalance={false}
          />
        </div>
      </div>
    </nav>
  );
}

export function Hero({ diemPrice, apr }: { diemPrice: number | null; apr: number }) {
  return (
    <section className="hero" id="stake">
      <span className="eyebrow"><span className="pulse" /> Live on Base mainnet</span>
      <h1 className="hero-title">Your $DIEM, now <em>earning</em> USDC.</h1>
      <p className="hero-sub">
        Stake $DIEM into the AntSeed pool on Base. USDC from every AI inference request
        streams directly into the contract in real time; $ANTS emissions land every epoch.
        No fees on the pool, no lockups, fully on-chain.
      </p>
      <div className="hero-meta">
        <span className="live-badge">$DIEM ${fmtPrice(diemPrice)}</span>
        <span className="dot" />
        <span><strong>{fmtPct(apr)}</strong> <span className="apr-sub">USDC APR · ROLLING 7D</span></span>
        <span className="dot" />
        <span>+ <strong>$ANTS</strong> every epoch</span>
        <span className="dot" />
        <span><strong style={{ color: 'var(--brand-dark)' }}>0% fees</strong></span>
      </div>
    </section>
  );
}

export function ClaimBanner() {
  const { href, platform, label } = useAntstationDownload();
  return (
    <div className="claim-banner">
      <div className="claim-banner-inner">
        <div>
          <span className="eyebrow"><span className="pulse" /> Claim your $ANTS</span>
          <h2>Your $ANTS also live inside <em>AntStation</em>.</h2>
          <p>
            You can claim $ANTS on-chain here, but AntStation — the AntSeed desktop app — is
            where you spend them. Use any model in the app, or connect Claude Code, Cursor,
            or any agent via{' '}
            <code style={{ background: 'rgba(31,216,122,0.12)', color: 'var(--brand)', padding: '1px 6px', borderRadius: 4, fontFamily: 'var(--mono)', fontSize: 12 }}>
              localhost:8377
            </code>
            . Pass-through pricing, more inference per dollar than any subscription.
          </p>
          <div className="claim-banner-actions">
            {/* Match antseed.com's primary download button: OS icon +
                "Download for <OS>" when we have a direct installer,
                brand-generic fallback otherwise. */}
            <a
              href={href}
              className="btn-primary"
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              {hasDirectInstaller(platform) ? (
                <>
                  <PlatformIcon platform={platform} />
                  {label}
                </>
              ) : (
                <>Download AntStation →</>
              )}
            </a>
            <a
              href={ANTSTATION_RELEASES_URL}
              className="btn-ghost"
              target="_blank"
              rel="noopener noreferrer"
            >
              All releases →
            </a>
            <a href={ANTSEED_URL} className="btn-ghost" target="_blank" rel="noopener noreferrer">
              What is AntSeed?
            </a>
          </div>
        </div>
        <div className="claim-mock">
          <div className="line"><span className="comment"># antstation › staking portal</span></div>
          <div className="line"><span className="key">connected wallet</span><span className="num">same as here</span></div>
          <div className="line"><span className="key">$ANTS pending</span><span className="num">auto-synced</span></div>
          <div className="line"><span className="key">USDC earned</span><span className="num">live stream</span></div>
          <hr />
          <div className="line"><span className="comment"># spend on any model →</span></div>
          <div className="line"><span className="key">claude-sonnet-4.6</span><span className="num">ready</span></div>
          <div className="line"><span className="key">gpt-5.2</span><span className="num">ready</span></div>
          <div className="line"><span className="key">sora-2 · video</span><span className="num">ready</span></div>
        </div>
      </div>
    </div>
  );
}

export function HowItWorks() {
  const { href } = useAntstationDownload();
  return (
    <section id="how">
      <span className="sec-label">How it works</span>
      <h2 className="sec-title">Four steps. <em>Fully on-chain.</em></h2>
      <p className="sec-sub">
        Your $DIEM stays in an audited smart contract on Base. USDC from inference streams
        straight into the pool as it happens; $ANTS emissions land every epoch.
      </p>

      <div className="steps">
        <Step num="01" label="Stake" title="Deposit your $DIEM">
          Connect your wallet and deposit $DIEM into the staking contract on Base. One
          transaction. Your tokens, your keys, your control.
        </Step>
        <Step num="02" label="Flow" title="AI demand earns fees">
          Your pooled $DIEM powers AI inference across the AntSeed network. Every request
          settles a USDC micropayment on-chain, paid directly from the AntSeed payment
          channel into the staking contract — no middleman, no operator skimming.
        </Step>
        <Step num="03" label="USDC" title="USDC streams in real time">
          Your share of every inflow credits to your position the moment it lands. No epoch
          wait, no distribution cycle — just a pro-rata stream. Claim to your wallet whenever.
        </Step>
        <Step num="04" label="$ANTS" title="Claim $ANTS on-chain, spend in AntStation">
          $ANTS emissions accrue every epoch. Claim them on-chain here, then{' '}
          <a href={href} target="_blank" rel="noopener noreferrer">download AntStation</a>{' '}
          to spend them on any model on the network.
        </Step>
      </div>

      <Why />
    </section>
  );
}

function Step(props: { num: string; label: string; title: string; children: ReactNode }) {
  return (
    <div className="step">
      <span className="step-num">{props.num} ·  {props.label}</span>
      <h3>{props.title}</h3>
      <p>{props.children}</p>
    </div>
  );
}

function Why() {
  const items = [
    { h: 'Real revenue, not emissions', p: 'USDC yield comes from actual AI requests on the AntSeed network. If demand grows, your yield grows with it.' },
    { h: 'Your $DIEM never leaves Base', p: 'Funds stay in an audited smart contract. No bridges, no centralized custody, no rehypothecation.' },
    { h: 'Two income streams', p: 'USDC for cash yield today. $ANTS for upside in the network tomorrow. Long-term stakers earn a bigger share of both.' },
    { h: 'Zero fees on the pool', p: 'Stakers capture 100% of the USDC that flows through the pool. No staking fee, no protocol cut, no hidden spread.' },
  ];
  return (
    <div className="why-block">
      <h3 className="why-subtitle">Yield backed by <em>real demand</em>.</h3>
      <p className="why-lead">
        This isn't farming. It isn't printed rewards. It's USDC that real developers and AI
        agents pay for inference, flowing straight back to you.
      </p>
      <div className="why-grid">
        {items.map((it) => (
          <div className="why" key={it.h}>
            <div className="check">✓</div>
            <div>
              <h4>{it.h}</h4>
              <p>{it.p}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DualCards() {
  const { href, platform, label } = useAntstationDownload();
  return (
    <section>
      <div className="dual">
        <a href={href} className="dual-card" target="_blank" rel="noopener noreferrer">
          <span className="tag">◆  AntStation</span>
          <h4>The AntSeed desktop app</h4>
          <p>Chat with Claude, GPT, and every open model. Generate images and video. All at provider cost. No subscription markup. Free to download.</p>
          <span className="arrow">{hasDirectInstaller(platform) ? `${label} →` : 'Download AntStation →'}</span>
        </a>
        <a href={ANTSEED_URL} className="dual-card" target="_blank" rel="noopener noreferrer">
          <span className="tag">◆  AntSeed</span>
          <h4>The P2P AI network</h4>
          <p>No central gatekeeper. No markup. Pay per token in USDC. Connect any agent, any coding tool, or just chat through AntStation. Same network underneath.</p>
          <span className="arrow">Explore AntSeed →</span>
        </a>
      </div>
    </section>
  );
}

export function FAQ() {
  const { href } = useAntstationDownload();
  return (
    <section id="faq">
      <span className="sec-label">FAQ</span>
      <h2 className="sec-title">Common questions.</h2>
      <div className="faqs">
        <details className="faq" open>
          <summary>Where does the USDC yield actually come from?</summary>
          <div className="body">
            AntSeed is a peer-to-peer network where developers and AI agents buy inference,
            skills, and other services. Every request settles a USDC micropayment on Base,
            and the AntSeed payment channel pays the staking contract directly — the
            contract is the seller. No operator holds the funds in between. Your share
            credits to your position the moment the micropayment lands, 100% pass-through
            with zero fees taken by the pool.
          </div>
        </details>
        <details className="faq">
          <summary>How is the current APR calculated?</summary>
          <div className="body">
            The APR shown is realized, not projected. We sum the USDC that streamed into
            the pool over the last 7 days, divide by the pool TVL, and annualize (× 52).
            It's backward-looking. Real yield tracks actual AI demand on the network, which
            varies week to week. The contract only ever pays out what it actually received.
            Effective APR is denominated in USDC. $ANTS are extra on top.
          </div>
        </details>
        <details className="faq">
          <summary>How does unstaking work?</summary>
          <div className="body">
            From Venice's side the proxy is a single staker, so every unstake would reset
            the cooldown for the whole pool. To avoid that we batch: unstakes queue into
            the currently-open unstake batch on-chain. You'll see three states in the app:
            <strong>queued</strong> (your amount is in the open batch, accrual stopped
            instantly) → <strong>cooling down</strong> (batch flushed to Venice in one call,
            waiting for Venice's native cooldown) → <strong>claimable</strong> (your DIEM is
            ready to withdraw). Once the current batch finishes claiming, a new batch
            opens. Each state advances with a tx anyone in the batch can trigger — so you'll
            often find yours has moved already by the time you check back.
            <br /><br />
            Each batch also has a minimum open window (24h by default) measured from the
            first queuer — this stops a single user from queuing and immediately flushing,
            which would push everyone else into a fresh Venice cooldown. The queue state
            shows a live countdown until the batch is flushable.
          </div>
        </details>
        <details className="faq">
          <summary>How do I claim my $ANTS rewards?</summary>
          <div className="body">
            $ANTS are distributed every epoch to the same wallet you staked with. You can
            claim them on-chain from the Claim tab here. $ANTS are best spent inside{' '}
            <a href={href} target="_blank" rel="noopener noreferrer">AntStation</a>,
            the AntSeed desktop app — any model on the network accepts them.
          </div>
        </details>
        <details className="faq">
          <summary>What's an epoch and how often is USDC paid out?</summary>
          <div className="body">
            <strong>USDC streams in real time</strong> — every inference request pays the
            staking contract directly and credits your share in the same transaction.
            There's no epoch wait for USDC; claim to your wallet whenever. <strong>$ANTS</strong>
            are different: they're distributed per weekly epoch via a time-weighted points
            system that rewards how long you were staked during the epoch, not just whether
            you're staked at the moment of distribution. Long-term stakers get a bigger
            share — and you can still claim $ANTS for epochs you contributed to even after
            fully unstaking.
          </div>
        </details>
        <details className="faq">
          <summary>Are there any fees on the pool?</summary>
          <div className="body">
            No. Staking, unstaking, and claiming are all zero-fee from the pool's side.
            100% of the USDC the pool earns from AI demand flows to stakers pro-rata. The
            AntSeed channels contract itself takes a protocol fee upstream, so "zero fees"
            is scoped to the pool. Your only cost is the Base gas for your own transactions
            (typically a few cents).
          </div>
        </details>
      </div>
    </section>
  );
}

export function Footer({ proxyAddress }: { proxyAddress: string | null }) {
  const { href: antstationHref } = useAntstationDownload();
  const contractHref = proxyAddress ? `${CONTRACT_URL_BASE}/${proxyAddress}` : `${CONTRACT_URL_BASE}/`;
  return (
    <footer>
      <div>
        <a className="brand" href="/">
          <span>
            <span className="ant">ANT</span>
            <span className="seed">SEED</span>
          </span>
          <span className="slash">/</span>
          <span className="diem">Diem</span>
        </a>
      </div>
      <div className="links">
        <a href={ANTSEED_URL}>antseed.com</a>
        <a href={antstationHref} target="_blank" rel="noopener noreferrer">AntStation</a>
        <a href={contractHref} target="_blank" rel="noopener noreferrer">Contract</a>
        <a href="#stake">Stake</a>
      </div>
      <div>Live on Base · v0.1</div>
    </footer>
  );
}

export { ANTSEED_URL };

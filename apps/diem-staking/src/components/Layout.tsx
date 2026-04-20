// Static layout sections: Nav, Hero, AlphaStrip, ClaimBanner, HowItWorks, FAQ,
// DualCards, Footer. These don't depend on on-chain state (ClaimBanner and
// Hero take a couple of computed values as props so they can show live APR /
// pool TVL).

import { ConnectButton } from '@rainbow-me/rainbowkit';
import type { MouseEvent } from 'react';

import { fmtPct, fmtPrice } from '../lib/format';

const ANTSTATION_DOWNLOAD_URL = 'https://github.com/AntSeed/antseed/releases/latest';
const ANTSEED_URL = 'https://antseed.com';
const CONTRACT_URL_BASE = 'https://basescan.org/address';

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
        Stake $DIEM into the AntSeed pool on Base. Every epoch, we distribute USDC and $ANTS
        to stakers. No fees on the pool, no lockups, fully on-chain.
      </p>
      <div className="hero-meta">
        <span className="live-badge">$DIEM ${fmtPrice(diemPrice)}</span>
        <span className="dot" />
        <span><strong>{fmtPct(apr)}</strong> <span className="apr-sub">USDC APR · LAST EPOCH</span></span>
        <span className="dot" />
        <span>+ <strong>$ANTS</strong> every epoch</span>
        <span className="dot" />
        <span><strong style={{ color: 'var(--brand-dark)' }}>0% fees</strong></span>
      </div>
    </section>
  );
}

export function ClaimBanner() {
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
            <a href={ANTSTATION_DOWNLOAD_URL} className="btn-primary" target="_blank" rel="noopener noreferrer">
              Download AntStation →
            </a>
            <a href="https://antseed.com/network" className="btn-ghost" target="_blank" rel="noopener noreferrer">
              See pricing →
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
          <div className="line"><span className="key">USDC earned</span><span className="num">visible</span></div>
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
  return (
    <section id="how">
      <span className="sec-label">How it works</span>
      <h2 className="sec-title">Four steps. <em>Fully on-chain.</em></h2>
      <p className="sec-sub">
        Your $DIEM stays in an audited smart contract on Base. Every epoch we distribute the
        USDC the network earned back to stakers, plus $ANTS token rewards.
      </p>

      <div className="steps">
        <Step num="01" label="Stake" title="Deposit your $DIEM">
          Connect your wallet and deposit $DIEM into the staking contract on Base. One
          transaction. Your tokens, your keys, your control.
        </Step>
        <Step num="02" label="Flow" title="AI demand earns fees">
          Your pooled $DIEM powers AI inference across the AntSeed network. Every request
          developers and agents make generates USDC, streamed back to the pool.
        </Step>
        <Step num="03" label="USDC" title="USDC every epoch">
          At the end of each epoch, the USDC the network earned is distributed to stakers
          pro-rata to your share of the pool. Claim to your wallet whenever.
        </Step>
        <Step num="04" label="$ANTS" title="Claim $ANTS on-chain, spend in AntStation">
          $ANTS emissions accrue every epoch. Claim them on-chain here, then{' '}
          <a href={ANTSTATION_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">download AntStation</a>{' '}
          to spend them on any model on the network.
        </Step>
      </div>

      <Why />
    </section>
  );
}

function Step(props: { num: string; label: string; title: string; children: React.ReactNode }) {
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
  return (
    <section>
      <div className="dual">
        <a href={ANTSTATION_DOWNLOAD_URL} className="dual-card" target="_blank" rel="noopener noreferrer">
          <span className="tag">◆  AntStation</span>
          <h4>The AntSeed desktop app</h4>
          <p>Chat with Claude, GPT, and every open model. Generate images and video. All at provider cost. No subscription markup. Free to download.</p>
          <span className="arrow">Download AntStation →</span>
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
  return (
    <section id="faq">
      <span className="sec-label">FAQ</span>
      <h2 className="sec-title">Common questions.</h2>
      <div className="faqs">
        <details className="faq" open>
          <summary>Where does the USDC yield actually come from?</summary>
          <div className="body">
            AntSeed is a peer-to-peer network where developers and AI agents buy inference,
            skills, and other services. Every request is a USDC micropayment on Base. The
            staking pool earns a share of that flow and distributes it to stakers pro-rata,
            100% pass-through with zero fees taken by the pool.
          </div>
        </details>
        <details className="faq">
          <summary>How is the current APR calculated?</summary>
          <div className="body">
            The APR shown is realized. We take the USDC distributed to the pool in the most
            recent epoch, divide by the pool TVL, and annualize (× 52 epochs per year). It's
            backward-looking, not a projection. Real yield depends on actual AI demand on
            the network, which varies epoch to epoch. The contract always distributes what's
            actually earned, nothing more, nothing less. Effective APR is denominated in
            USDC. $ANTS are extra on top.
          </div>
        </details>
        <details className="faq">
          <summary>How does unstaking work?</summary>
          <div className="body">
            Unstakes are batched into weekly cohorts on-chain. You'll see three states in
            the app: <strong>queued</strong> (your amount is in the current cohort, accrual
            stopped instantly) → <strong>cooling down</strong> (cohort sent to Venice, waiting
            for Venice's native unstake cooldown) → <strong>claimable</strong> (your DIEM is
            ready to withdraw). Each state advances with an on-chain transaction that anyone
            in your cohort can trigger — so you'll often find yours has moved already by the
            time you check back.
          </div>
        </details>
        <details className="faq">
          <summary>How do I claim my $ANTS rewards?</summary>
          <div className="body">
            $ANTS are distributed every epoch to the same wallet you staked with. You can
            claim them on-chain from the Claim tab here. $ANTS are best spent inside{' '}
            <a href={ANTSTATION_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">AntStation</a>,
            the AntSeed desktop app — any model on the network accepts them.
          </div>
        </details>
        <details className="faq">
          <summary>What's an epoch and how often is USDC paid out?</summary>
          <div className="body">
            An epoch is one week. At the end of each epoch, the USDC the pool earned is
            distributed to stakers pro-rata to your share, and $ANTS emissions are
            allocated for that week. USDC flows to your wallet on claim. Effective APR is
            always denominated in USDC. $ANTS are extra on top.
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
        <a href={ANTSTATION_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">AntStation</a>
        <a href={contractHref} target="_blank" rel="noopener noreferrer">Contract</a>
        <a href="#stake">Stake</a>
      </div>
      <div>Live on Base · v0.1</div>
    </footer>
  );
}

export { ANTSTATION_DOWNLOAD_URL, ANTSEED_URL };

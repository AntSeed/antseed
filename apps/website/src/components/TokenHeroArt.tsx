import {useEffect, useState} from 'react';
import styles from './TokenHeroArt.module.css';
import {useEpochCountdown} from '../lib/useEpochCountdown';

/**
 * /ants-token hero animation: the recognized-usage loop as a live ledger.
 * Top: the real epoch clock (weekly epochs from the emissions genesis).
 * Middle: settled USDC volume × provider-pool stake = recognized usage.
 * Bottom: a feed of settlements arriving and being recognized. Numbers
 * are illustrative; only the epoch and countdown are real.
 */

const MODELS = ['deepseek-v4-flash', 'gpt-oss-120b', 'kimi-k2.6', 'qwen3-coder', 'claude-fable-5-1', 'glm-5'];
const STAKE_ANTS = 1_250_000;
const START_VOLUME = 12_480.2;
const TICK_MS = 1400;
const VISIBLE = 3;

type Row = {id: number; model: string; amt: number};

const usd = (n: number) => `$${n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(0)}k`);

function makeRow(i: number): Row {
  // deterministic pseudo-random so SSR and client agree on the first frame
  const seed = (i * 9301 + 49297) % 233280;
  const r = seed / 233280;
  return {id: 48219 + i, model: MODELS[i % MODELS.length], amt: 0.08 + r * 1.9};
}

export function TokenHeroArt() {
  const {epoch, timeLeft, progress, started} = useEpochCountdown();
  const [count, setCount] = useState(VISIBLE);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    if (mq.matches) return undefined;
    const id = window.setInterval(() => setCount((c) => c + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const rows: Row[] = [];
  for (let i = Math.max(0, count - VISIBLE); i < count; i++) rows.push(makeRow(i));
  const settled = rows.reduce((sum, r) => sum + r.amt, 0);
  const volume = START_VOLUME + (count - VISIBLE) * 0.62 + settled;
  const recognized = volume; // pass-through policy: recognized volume tracks settled volume

  return (
    <div className={`${styles.well} ${reduced ? styles.reduced : ''}`}>
      <div className={styles.panel} role="img" aria-label="Settled usage becoming recognized usage on Antseed">
        <div className={styles.bar}>
          <span>
            Epoch <strong>{started ? epoch : '–'}</strong>
          </span>
          <span className={styles.epochTrack} aria-hidden="true">
            <span className={styles.epochFill} style={{width: `${Math.round(progress * 100)}%`}} />
          </span>
          <span>
            Next in <strong>{timeLeft}</strong>
          </span>
        </div>

        <div className={styles.eq}>
          <div className={styles.term}>
            <span className={styles.termLabel}>Settled volume</span>
            <span className={styles.termValue}>{usd(volume)}</span>
          </div>
          <div className={styles.term}>
            <span className={styles.termLabel}>
              <span className={styles.termOp} aria-hidden="true">×</span>
              Pool stake
            </span>
            <span className={styles.termValue}>{compact(STAKE_ANTS)} ANTS</span>
          </div>
          <div className={`${styles.term} ${styles.termResult}`}>
            <span className={styles.termLabel}>
              <span className={styles.termOp} aria-hidden="true">=</span>
              Recognized usage
            </span>
            <span className={styles.termValue}>{usd(recognized)}</span>
          </div>
        </div>

        <div className={styles.feed}>
          {rows.map((r) => (
            <div key={r.id} className={styles.row}>
              <span className={styles.rowId}>#{r.id}</span>
              <span className={styles.rowModel}>{r.model}</span>
              <span className={styles.rowAmt}>{usd(r.amt)}</span>
              <span className={styles.rowOk}>recognized</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

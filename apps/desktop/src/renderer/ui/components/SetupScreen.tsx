import { useEffect, useState } from 'react';
import { AntStationStackedLogo } from './AntStationLogo';
import { TitleBar } from './TitleBar';
import { useUiSnapshot } from '../hooks/useUiSnapshot';
import styles from './SetupScreen.module.scss';

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2.5 7L5.5 10L11.5 4" stroke="var(--accent-green)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type StepRowProps = {
  label: string;
  done: boolean;
  active: boolean;
};

function StepRow({ label, done, active }: StepRowProps) {
  return (
    <div className={`${styles.stepRow} ${done ? styles.done : ''} ${active ? styles.active : ''}`}>
      <div className={styles.stepIcon}>
        {done ? (
          <CheckIcon />
        ) : active ? (
          <div className={styles.thinkingDots}>
            <span />
            <span />
            <span />
          </div>
        ) : (
          <div className={styles.stepDot} />
        )}
      </div>
      <span className={styles.stepLabel}>{label}</span>
    </div>
  );
}

// Progress level advances monotonically: 0 → 1 → 2 → 3, never backward.
// 0 = waiting for plugin  1 = plugin done, connecting
// 2 = P2P activity seen   3 = model-loading activity seen
type ProgressLevel = 0 | 1 | 2 | 3;

export function SetupScreen() {
  const snap = useUiSnapshot();
  const [level, setLevel] = useState<ProgressLevel>(0);

  const hasModels = snap.chatModelOptions.length > 0;
  const msg = snap.runtimeActivity.message;

  // Advance progress level monotonically inside useEffect so mutations
  // only happen during the commit phase (safe in concurrent/strict mode).
  useEffect(() => {
    setLevel((prev) => {
      // Advance at most one level per call so intermediate steps animate visibly.
      if (snap.appSetupComplete && prev < 1) return 1 as ProgressLevel;
      if (prev >= 1 && /\bpeer(s)?\b|p2p|dht|discovering/i.test(msg) && prev < 2) return 2 as ProgressLevel;
      if (prev >= 1 && (/model/i.test(msg) || hasModels) && prev < 3) return 3 as ProgressLevel;
      return prev;
    });
  }, [snap.appSetupComplete, msg, hasModels]);
  const networkDone = level >= 2 || hasModels;
  const modelActive = level >= 2 && !hasModels;

  const connectLabel = level === 1 ? (msg || 'Connecting to P2P network...') : 'Connecting to P2P network';
  const modelLabel = modelActive ? (msg || 'Loading models...') : 'Loading models';

  return (
    <>
      <TitleBar />
      <div className={styles.container}>
        <div className={styles.content}>
          <AntStationStackedLogo height={60} className={styles.logo} />
          <h1 className={styles.title}>Setting up AntStation</h1>
          <p className={styles.subtitle}>This only takes a moment on first launch</p>

          <div className={styles.steps}>
            <StepRow label="Preparing workspace" done={true} active={false} />
            <StepRow
              label={snap.appSetupStep || 'Installing router plugin...'}
              done={snap.appSetupComplete}
              active={!snap.appSetupComplete}
            />
            <StepRow label={connectLabel} done={networkDone} active={level === 1} />
            <StepRow label="Discovering peers" done={networkDone} active={false} />
            <StepRow label={modelLabel} done={hasModels} active={modelActive} />
          </div>

          {snap.appSetupComplete && hasModels && (
            <div className={styles.ready}>
              <span className={styles.readyDot} />
              Ready
            </div>
          )}
        </div>
      </div>
    </>
  );
}

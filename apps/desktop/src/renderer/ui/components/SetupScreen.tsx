import { useRef } from 'react';
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

// Progress levels — only move forward, never backward.
type ProgressLevel = 0 | 1 | 2 | 3;
// 0 = waiting for plugin
// 1 = plugin done, connecting
// 2 = seen P2P/peer activity
// 3 = seen model-loading activity

export function SetupScreen() {
  const snap = useUiSnapshot();
  const progressRef = useRef<ProgressLevel>(0);

  const hasModels = snap.chatModelOptions.length > 0;
  const msg = snap.runtimeActivity.message;

  // Advance progress monotonically based on observed state.
  if (snap.appSetupComplete && progressRef.current < 1) progressRef.current = 1;
  if (progressRef.current >= 1 && /peer|connecting|p2p|proxy|dht/i.test(msg) && progressRef.current < 2) progressRef.current = 2;
  if (progressRef.current >= 1 && /model/i.test(msg) && progressRef.current < 3) progressRef.current = 3;
  if (hasModels && progressRef.current < 3) progressRef.current = 3;

  const level = progressRef.current;

  const dhtDone = level >= 2 || hasModels;
  const dhtActive = level === 1;
  const peerDone = level >= 2 || hasModels;
  const peerActive = false; // absorbed into dhtActive for simplicity
  const modelDone = hasModels;
  const modelActive = level >= 2 && !hasModels;

  // Show the live activity message only on the currently active step.
  const dhtLabel = dhtActive ? (msg || 'Connecting to P2P network...') : 'Connecting to P2P network';
  const modelLabel = modelActive ? (msg || 'Loading models...') : 'Loading models';

  const allDone = snap.appSetupComplete && hasModels;

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
            <StepRow label={dhtLabel} done={dhtDone} active={dhtActive} />
            <StepRow
              label="Discovering peers"
              done={peerDone}
              active={peerActive}
            />
            <StepRow label={modelLabel} done={modelDone} active={modelActive} />
          </div>

          {allDone && (
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

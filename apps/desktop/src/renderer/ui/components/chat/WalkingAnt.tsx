import { useEffect, useState } from 'react';
import styles from './WalkingAnt.module.scss';

type WalkingAntProps = {
  elapsedMs: number;
};

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

export function WalkingAnt({ elapsedMs: initialElapsedMs }: WalkingAntProps) {
  const [elapsed, setElapsed] = useState(initialElapsedMs);

  useEffect(() => {
    setElapsed(initialElapsedMs);
    const id = setInterval(() => setElapsed((prev) => prev + 1000), 1000);
    return () => clearInterval(id);
  }, [initialElapsedMs]);

  return (
    <div className={styles.container}>
      <div className={styles.scene}>
        <div className={styles.ant}>
          {/* Antenna */}
          <div className={styles.antennaGroup}>
            <div className={`${styles.antenna} ${styles.antenna1}`}>
              <div className={styles.antennaTip} />
            </div>
            <div className={`${styles.antenna} ${styles.antenna2}`}>
              <div className={styles.antennaTip} />
            </div>
          </div>
          {/* Body */}
          <div className={styles.head} />
          <div className={styles.thorax} />
          <div className={styles.abdomen} />
          {/* Legs */}
          <div className={styles.legs}>
            <div className={`${styles.leg} ${styles.legFrontA}`} />
            <div className={`${styles.leg} ${styles.legFrontB}`} />
            <div className={`${styles.leg} ${styles.legMidA}`} />
            <div className={`${styles.leg} ${styles.legMidB}`} />
            <div className={`${styles.leg} ${styles.legRearA}`} />
            <div className={`${styles.leg} ${styles.legRearB}`} />
          </div>
        </div>
      </div>

      {elapsed >= 1000 && (
        <span className={styles.timer}>{formatElapsed(elapsed)}</span>
      )}
    </div>
  );
}

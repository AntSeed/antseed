import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowExpand02Icon,
  ArrowShrink02Icon,
  Cancel01Icon,
  LeftToRightListBulletIcon,
} from '@hugeicons/core-free-icons';
import type { VprFloatData } from '../../types/bridge';
import { VprMark } from '../components/VprLogo';
import {
  CompactRoutingHeader,
  CompactRoutingPanel,
} from '../components/compact/CompactRoutingPanel';
import styles from './FloatApp.module.scss';

const COMPACT_MAX_WIDTH = 160;

export function FloatApp() {
  const bridge = window.antseedDesktop;
  const [data, setData] = useState<VprFloatData | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [compact, setCompact] = useState(() => window.innerWidth <= COMPACT_MAX_WIDTH);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => setFlipped(false), [compact]);
  useEffect(() => {
    if (!flipped) return undefined;
    const timer = window.setTimeout(() => setFlipped(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [flipped]);

  const setCompactMode = (next: boolean) => {
    setCompact(next);
    bridge?.vprFloatAction?.({ type: 'set-compact', compact: next });
  };

  const compactRef = useRef(compact);
  useEffect(() => { compactRef.current = compact; }, [compact]);

  useEffect(() => bridge?.onVprFloatData?.((next) => {
    setData(next);
    if (next.openMenu) {
      if (compactRef.current) {
        setCompact(false);
        bridge.vprFloatAction?.({ type: 'set-compact', compact: false });
      }
      setMenuOpen(true);
    }
  }) ?? undefined, [bridge]);

  useEffect(() => {
    void bridge?.vprFloatGetCompact?.().then((value) => setCompact(Boolean(value)));
    return bridge?.onVprFloatCompact?.(setCompact);
  }, [bridge]);

  useEffect(() => {
    bridge?.vprFloatSetExpanded?.(menuOpen);
  }, [bridge, menuOpen]);
  useEffect(() => {
    if (compact) setMenuOpen(false);
  }, [compact]);

  if (compact) {
    return (
      <div className={styles.compactRoot}>
        <div className={styles.compactChip}>
          <div className={`${styles.chipFlip}${flipped ? ` ${styles.chipFlipped}` : ''}`}>
            <div className={styles.chipFace}>
              <div className={styles.appBadge}>
                <button type="button" className={styles.chipIconButton} onClick={() => setFlipped(true)} title="Options" aria-label="Show expand button">
                  <VprMark size={26} />
                </button>
              </div>
            </div>
            <div className={`${styles.chipFace} ${styles.chipFaceBack}`}>
              <button type="button" className={styles.chipExpandButton} onClick={() => setCompactMode(false)} title="Expand" aria-label="Expand floating window">
                <HugeiconsIcon icon={ArrowExpand02Icon} size={18} strokeWidth={2} />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pill}>
      <CompactRoutingHeader data={data} variant="float" onAddBalance={() => bridge?.vprFloatAction?.({ type: 'open-deposit' })} />

      <button type="button" className={`${styles.menuToggle}${menuOpen ? ` ${styles.menuToggleOpen}` : ''}`} onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-label={menuOpen ? 'Close conversations menu' : 'Open conversations menu'} title={menuOpen ? 'Close menu' : 'Open menu'}>
        <HugeiconsIcon icon={LeftToRightListBulletIcon} size={14} strokeWidth={2} />
      </button>

      {menuOpen ? (
        <div className={styles.menuPanel}>
          <CompactRoutingPanel data={data} variant="float" onAction={(action) => bridge?.vprFloatAction?.(action)} onOpenMain={() => bridge?.vprFloatAction?.('open-main')} />
        </div>
      ) : null}

      <button type="button" className={styles.shrink} onClick={() => setCompactMode(true)} aria-label="Shrink to badge" title="Shrink">
        <HugeiconsIcon icon={ArrowShrink02Icon} size={13} strokeWidth={2} />
      </button>
      <button type="button" className={styles.close} onClick={() => { void bridge?.vprFloatClose?.(); }} aria-label="Close floating window" title="Close">
        <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

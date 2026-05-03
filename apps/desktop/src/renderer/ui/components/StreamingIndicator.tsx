import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { PeerToPeer02Icon } from '@hugeicons/core-free-icons';
import { Router02Icon } from '@hugeicons/core-free-icons';
import { Globe02Icon } from '@hugeicons/core-free-icons';
import { UserGroupIcon } from '@hugeicons/core-free-icons';
import { Activity03Icon } from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../hooks/useUiSnapshot';
import styles from './StreamingIndicator.module.scss';

type ParsedStatus = {
  buyer: 'connected' | 'offline' | 'unknown';
  router: string;
  peers: string;
  proxy: string;
  prefix: string;
};

function parseStatusText(text: string): ParsedStatus {
  const out: ParsedStatus = {
    buyer: 'unknown',
    router: '—',
    peers: '—',
    proxy: '—',
    prefix: '',
  };

  const buyerMatch = text.match(/Buyer (connected|offline)/i);
  if (buyerMatch) out.buyer = buyerMatch[1].toLowerCase() as 'connected' | 'offline';

  const routerMatch = text.match(/Router ([^·]+)/);
  if (routerMatch) out.router = routerMatch[1].trim();

  const peersMatch = text.match(/(\d+)\s+peer/);
  if (peersMatch) {
    const n = Number(peersMatch[1]);
    out.peers = `${n} peer${n === 1 ? '' : 's'}`;
  }

  const proxyMatch = text.match(/Proxy ([^·]+)/);
  if (proxyMatch) out.proxy = proxyMatch[1].trim();

  // Anything before the first "Buyer ..." is streaming context (Turn/elapsed).
  const buyerIdx = text.search(/Buyer (connected|offline)/i);
  if (buyerIdx > 0) {
    out.prefix = text.slice(0, buyerIdx).replace(/[·\s]+$/, '').trim();
  }

  return out;
}

export function StreamingIndicator() {
  const { chatStreamingIndicatorText, chatStreamingActive, runtimeActivity } = useUiSnapshot();
  const statusText = chatStreamingIndicatorText || 'Idle';
  const activityText = runtimeActivity.message || 'Idle';
  const tone = chatStreamingActive ? 'active' : runtimeActivity.tone;

  const parsed = useMemo(() => parseStatusText(statusText), [statusText]);

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const toggle = useCallback(() => setOpen((p) => !p), []);

  return (
    <div
      className={`${styles.statusWrap}${chatStreamingActive ? ` ${styles.isThinking}` : ''}`}
      data-tone={tone}
      ref={wrapRef}
    >
      {open && (
        <div className={styles.popover} role="dialog" aria-label="Connection status">
          <div className={styles.popHeader}>
            <span className={styles.popHeaderDot} aria-hidden="true" />
            <span className={styles.popHeaderText}>{activityText}</span>
          </div>

          <div className={styles.popDivider} aria-hidden="true" />

          <ul className={styles.popList}>
            <li className={styles.popRow}>
              <span className={styles.popRowLabel}>
                <HugeiconsIcon icon={PeerToPeer02Icon} size={13} strokeWidth={1.5} />
                Buyer
              </span>
              <span className={styles.popRowValue} data-state={parsed.buyer}>
                {parsed.buyer === 'unknown' ? '—' : parsed.buyer}
              </span>
            </li>
            <li className={styles.popRow}>
              <span className={styles.popRowLabel}>
                <HugeiconsIcon icon={Router02Icon} size={13} strokeWidth={1.5} />
                Router
              </span>
              <span className={styles.popRowValue}>{parsed.router}</span>
            </li>
            <li className={styles.popRow}>
              <span className={styles.popRowLabel}>
                <HugeiconsIcon icon={UserGroupIcon} size={13} strokeWidth={1.5} />
                Peers
              </span>
              <span className={styles.popRowValue}>{parsed.peers}</span>
            </li>
            <li className={styles.popRow}>
              <span className={styles.popRowLabel}>
                <HugeiconsIcon icon={Globe02Icon} size={13} strokeWidth={1.5} />
                Proxy
              </span>
              <span className={styles.popRowValue}>{parsed.proxy}</span>
            </li>
            {parsed.prefix && (
              <li className={`${styles.popRow} ${styles.popRowFull}`}>
                <span className={styles.popRowLabel}>
                  <HugeiconsIcon icon={Activity03Icon} size={13} strokeWidth={1.5} />
                  Activity
                </span>
                <span className={styles.popRowValueWrap}>{parsed.prefix}</span>
              </li>
            )}
          </ul>
        </div>
      )}

      <button
        type="button"
        className={`${styles.statusBtn}${open ? ` ${styles.statusBtnOpen}` : ''}`}
        onClick={toggle}
        aria-expanded={open ? 'true' : 'false'}
        aria-haspopup="dialog"
        title={statusText}
      >
        <span className={styles.statusLabel}>{activityText}</span>
        <span className={styles.statusDot} aria-hidden="true" />
      </button>
    </div>
  );
}

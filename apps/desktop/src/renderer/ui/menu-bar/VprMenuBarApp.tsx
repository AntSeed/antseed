import { useEffect, useRef, useState } from 'react';
import type { VprFloatData } from '../../types/bridge';
import type { VprMenuBarAction } from '../../../shared/vpr-menu-bar.js';
import {
  CompactRoutingHeader,
  CompactRoutingPanel,
} from '../components/compact/CompactRoutingPanel';
import styles from './VprMenuBarApp.module.scss';

function isData(value: unknown): value is VprFloatData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<VprFloatData>;
  return Array.isArray(data.apps) && Array.isArray(data.models) && Array.isArray(data.conversations);
}

export function VprMenuBarApp() {
  const bridge = window.antseedDesktop;
  const [data, setData] = useState<VprFloatData | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const send = (action: VprMenuBarAction) => bridge?.vprMenuBarAction?.(action);

  useEffect(() => {
    let mounted = true;
    void bridge?.vprMenuBarGetState?.().then((next) => {
      if (mounted && isData(next)) setData(next);
    });
    const unsubscribe = bridge?.onVprMenuBarData?.((next) => {
      if (isData(next)) setData(next);
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [bridge]);

  function handleKeys(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      send({ type: 'dismiss' });
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = current < 0 ? 0 : current;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + delta + items.length) % items.length]?.focus();
  }

  return (
    <div ref={rootRef} className={styles.shell} onKeyDown={handleKeys}>
      <div className={styles.arrow} />
      <section className={styles.popover} aria-label="AntSeed routing status">
        <CompactRoutingHeader
          data={data}
          variant="menu-bar"
          onAddBalance={() => send({ type: 'open-deposit' })}
          onOpenChats={() => send({ type: 'open-chats' })}
          onOpenFloatingWindow={() => send({ type: 'open-floating-window' })}
          onDismiss={() => send({ type: 'dismiss' })}
        />
        <CompactRoutingPanel
          data={data}
          variant="menu-bar"
          onAction={(action) => send(action)}
          onOpenMain={() => send({ type: 'open-main' })}
        />
      </section>
    </div>
  );
}

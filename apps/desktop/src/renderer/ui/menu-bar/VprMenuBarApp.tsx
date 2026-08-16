import { useEffect, useMemo, useRef, useState } from 'react';
import type { VprMenuBarAction, VprMenuBarState } from '../../../shared/vpr-menu-bar.js';
import { BrandIcon } from '../components/brand/BrandIcon';
import styles from './VprMenuBarApp.module.scss';

function isState(value: unknown): value is VprMenuBarState {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as VprMenuBarState).models));
}

function isSelected(
  model: VprMenuBarState['models'][number],
  selected: VprMenuBarState['selectedModel'],
): boolean {
  return Boolean(selected && model.provider === selected.provider && model.serviceId === selected.serviceId);
}

export function VprMenuBarApp() {
  const bridge = window.antseedDesktop;
  const [state, setState] = useState<VprMenuBarState | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    void bridge?.vprMenuBarGetState?.().then((next) => {
      if (mounted && isState(next)) setState(next);
    });
    const unsubscribe = bridge?.onVprMenuBarData?.((next) => {
      if (isState(next)) setState(next);
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [bridge]);

  const selected = state?.selectedModel ?? null;
  const models = useMemo(() => state?.models.slice(0, 8) ?? [], [state]);

  useEffect(() => {
    if (!state) return;
    requestAnimationFrame(() => {
      const active = rootRef.current?.querySelector<HTMLButtonElement>('[data-selected="true"]');
      const first = rootRef.current?.querySelector<HTMLButtonElement>('[data-menu-item="true"]');
      (active ?? first)?.focus();
    });
  }, [state]);

  const send = (action: VprMenuBarAction): void => bridge?.vprMenuBarAction?.(action);

  function handleKeys(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      send({ type: 'dismiss' });
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-menu-item="true"]') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + delta + items.length) % items.length]?.focus();
  }

  return (
    <div ref={rootRef} className={styles.shell} onKeyDown={handleKeys}>
      <div className={styles.arrow} />
      <section className={styles.popover} aria-label="VPR model picker">
        <div className={styles.utilityActions} aria-label="AntSeed windows">
          <button
            type="button"
            className={styles.utilityButton}
            data-menu-item="true"
            aria-label="Open AntSeed VPR"
            onClick={() => send({ type: 'open-main' })}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <rect x="3.5" y="5" width="17" height="13.5" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="M3.5 8.5h17" stroke="currentColor" strokeWidth="1.8" />
              <circle cx="6.5" cy="6.75" r="0.8" fill="currentColor" />
            </svg>
            <span>Open AntSeed VPR</span>
          </button>
          <button
            type="button"
            className={styles.utilityButton}
            data-menu-item="true"
            aria-label="Show Floating Window"
            onClick={() => send({ type: 'open-floating-window' })}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <rect x="3.5" y="4.5" width="17" height="15" rx="3" stroke="currentColor" strokeWidth="1.8" />
              <rect x="9" y="8" width="8.5" height="7" rx="1.8" stroke="currentColor" strokeWidth="1.8" />
              <path d="M6.5 8h.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <span>Show Floating Window</span>
          </button>
        </div>

        {models.length > 0 && (
          <div className={styles.modelSection}>
            <div className={styles.sectionLabel}>Quick models</div>
            <div className={styles.modelList} role="listbox" aria-label="Quick models">
              {models.map((model) => {
                const active = isSelected(model, selected);
                return (
                  <button
                    key={`${model.provider}:${model.serviceId}`}
                    type="button"
                    className={`${styles.modelRow}${active ? ` ${styles.selected}` : ''}`}
                    role="option"
                    aria-selected={active}
                    data-menu-item="true"
                    data-selected={active ? 'true' : 'false'}
                    onClick={() => {
                      if (!active) {
                        send({ type: 'select-model', provider: model.provider, serviceId: model.serviceId });
                      }
                    }}
                  >
                    <span className={styles.brandBadge}>
                      <BrandIcon name={model.provider} hints={[model.label]} size={17} />
                    </span>
                    <span className={styles.modelName}>{model.label}</span>
                    {active && (
                      <span className={styles.check} aria-hidden="true">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path d="M2.2 6.2l2.2 2.2 5.2-5.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <button
          type="button"
          className={styles.browseButton}
          data-menu-item="true"
          onClick={() => send({ type: 'browse-models' })}
        >
          <span>Manage models &amp; favorites</span>
          <span className={styles.chevron} aria-hidden="true">›</span>
        </button>
      </section>
    </div>
  );
}

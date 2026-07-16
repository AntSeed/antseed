import { useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowExpand02Icon, ArrowShrink02Icon, Cancel01Icon } from '@hugeicons/core-free-icons';
import type { VprFloatData } from '../../types/bridge';
import { BrandIcon } from '../components/brand/BrandIcon';
import styles from './FloatApp.module.scss';

/* Native selects size themselves to their longest option, which would blow
   out the 256px pill. Measure the selected label instead and size the select
   to it, leaving room for the chevron. */
let measureContext: CanvasRenderingContext2D | null = null;

function measureLabel(label: string, font: string): number {
  if (!measureContext) {
    measureContext = document.createElement('canvas').getContext('2d');
  }
  if (!measureContext) return 120;
  measureContext.font = font;
  return Math.ceil(measureContext.measureText(label).width);
}

const SELECT_CHEVRON_SPACE = 16;
const MODEL_FONT = '600 14px Geist, sans-serif';
const APP_FONT = '400 12px Geist, sans-serif';

/* Keep the pulse alive slightly past one payload interval (3s) so steady
   traffic reads as a continuous heartbeat. */
const PULSE_HOLD_MS = 4_500;

/* Viewport width below this means the window is at compact-chip size (88px)
   rather than the full pill (272px). */
const COMPACT_MAX_WIDTH = 160;

/**
 * Content of the detachable always-on-top pill window (Figma "flowing
 * window", 4075:1842). The main window pushes VprFloatData over IPC; the
 * model dropdown routes a 'select-model' action back, and the app dropdown
 * switches which connected app the pill is adjusting (display-local).
 */
export function FloatApp() {
  const bridge = window.antseedDesktop;
  const [data, setData] = useState<VprFloatData | null>(null);
  const [appChoice, setAppChoice] = useState<string | null>(null);
  const [pulsing, setPulsing] = useState(false);
  const [compact, setCompact] = useState(() => window.innerWidth <= COMPACT_MAX_WIDTH);
  // Compact chip flipped over, showing the expand button on its back face.
  const [flipped, setFlipped] = useState(false);
  const pulseTimer = useRef<number | null>(null);

  // The chip's center buttons must be clickable AND draggable, which
  // -webkit-app-region can't express (drag regions swallow clicks). So the
  // buttons are no-drag and dragging is done by hand: pointer deltas stream
  // to the main process, and a press that never moved past the threshold
  // counts as the click.
  const chipDrag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const chipDragHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      chipDrag.current = { x: event.screenX, y: event.screenY, moved: false };
    },
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
      const state = chipDrag.current;
      if (!state) return;
      const dx = event.screenX - state.x;
      const dy = event.screenY - state.y;
      if (!state.moved && Math.hypot(dx, dy) < 3) return;
      state.moved = true;
      state.x = event.screenX;
      state.y = event.screenY;
      bridge?.vprFloatMoveBy?.(dx, dy);
    },
    onPointerUp: () => {
      // Leave `moved` for onClick (fires right after) to consume.
      if (chipDrag.current && !chipDrag.current.moved) chipDrag.current = null;
    },
    onPointerCancel: () => {
      chipDrag.current = null;
    },
  };
  /** True when the press that triggered this click was actually a drag. */
  const chipClickWasDrag = () => {
    const dragged = chipDrag.current?.moved ?? false;
    chipDrag.current = null;
    return dragged;
  };

  // Reset the flip whenever the chip leaves/enters compact mode, and flip
  // back on its own if the user doesn't take the expand action.
  useEffect(() => setFlipped(false), [compact]);
  useEffect(() => {
    if (!flipped) return undefined;
    const timer = window.setTimeout(() => setFlipped(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [flipped]);

  // The main process resizes the window; this component just swaps layouts.
  const setCompactMode = (next: boolean) => {
    setCompact(next);
    bridge?.vprFloatAction?.({ type: 'set-compact', compact: next });
  };

  useEffect(() => bridge?.onVprFloatData?.(setData) ?? undefined, [bridge]);

  // The main process owns the compact state (it does the resize). Query it on
  // mount (covers reloads and the push-before-listener race) and subscribe to
  // live changes, so the layout can't desync from the window — even across a
  // dev HMR reload or if the OS clamps the resize size.
  useEffect(() => {
    void bridge?.vprFloatGetCompact?.().then((value) => setCompact(Boolean(value)));
    return bridge?.onVprFloatCompact?.(setCompact);
  }, [bridge]);

  const apps = data?.apps ?? [];
  // The user's local dropdown choice wins while that app is still connected;
  // otherwise fall back to what the main window suggests.
  const selectedApp = useMemo(() => {
    if (appChoice && apps.some((app) => app.name === appChoice)) {
      return apps.find((app) => app.name === appChoice)!;
    }
    return apps.find((app) => app.name === data?.selectedApp) ?? apps[0] ?? null;
  }, [appChoice, apps, data?.selectedApp]);

  // Turn the status ring green while traffic is moving through the proxies.
  // Active payloads extend a safety hold; an explicit inactive payload drops
  // back to the orange "ready" ring right away so it stays in sync with the
  // actual traffic.
  const trafficActive = data?.trafficActive ?? false;
  useEffect(() => {
    if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
    if (!trafficActive) {
      pulseTimer.current = null;
      setPulsing(false);
      return;
    }
    setPulsing(true);
    pulseTimer.current = window.setTimeout(() => setPulsing(false), PULSE_HOLD_MS);
  }, [trafficActive, data]);
  useEffect(() => () => {
    if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
  }, []);

  const models = data?.models ?? [];
  const selectedModelValue = data?.selectedModel
    ? `${data.selectedModel.provider}:${data.selectedModel.serviceId}`
    : '';
  const selectedModel = models.find(
    (model) => `${model.provider}:${model.serviceId}` === selectedModelValue,
  ) ?? null;

  const modelLabel = selectedModel?.label ?? 'Select model';
  const modelSelectWidth = measureLabel(modelLabel, MODEL_FONT) + SELECT_CHEVRON_SPACE;
  const appLabel = selectedApp?.displayName ?? 'No app connected';
  const appSelectWidth = measureLabel(appLabel, APP_FONT) + SELECT_CHEVRON_SPACE;

  const badgeClassName = [
    styles.appBadge,
    // Ready ring whenever an app is connected; green while traffic moves.
    selectedApp ? styles.appBadgeReady : '',
    pulsing ? styles.appBadgeActive : '',
  ].filter(Boolean).join(' ');

  if (compact) {
    return (
      <div className={styles.compactRoot}>
      <div className={styles.compactChip}>
        <div className={`${styles.chipFlip}${flipped ? ` ${styles.chipFlipped}` : ''}`}>
          {/* Front: the status badge. Only the icon itself is clickable —
              the rest of the chip stays a drag handle. */}
          <div className={styles.chipFace}>
            <div className={badgeClassName}>
              <button
                type="button"
                className={styles.chipIconButton}
                {...chipDragHandlers}
                onClick={() => { if (!chipClickWasDrag()) setFlipped(true); }}
                title="Options"
                aria-label="Show expand button"
              >
                {selectedApp ? (
                  <BrandIcon name={selectedApp.name} hints={[selectedApp.displayName]} size={26} />
                ) : null}
              </button>
            </div>
          </div>
          {/* Back: the explicit expand action. */}
          <div className={`${styles.chipFace} ${styles.chipFaceBack}`}>
            <button
              type="button"
              className={styles.chipExpandButton}
              {...chipDragHandlers}
              onClick={() => { if (!chipClickWasDrag()) setCompactMode(false); }}
              title="Expand"
              aria-label="Expand floating window"
            >
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
      <button
        type="button"
        className={badgeClassName}
        onClick={() => bridge?.vprFloatAction?.('open-main')}
        title="Open AntSeed"
        aria-label="Open AntSeed"
      >
        {selectedApp ? (
          <BrandIcon name={selectedApp.name} hints={[selectedApp.displayName]} size={26} />
        ) : null}
      </button>

      <div className={styles.body}>
        <select
          className={styles.modelSelect}
          style={{ width: modelSelectWidth }}
          value={selectedModel ? selectedModelValue : ''}
          onChange={(event) => {
            const [provider, ...rest] = event.currentTarget.value.split(':');
            const serviceId = rest.join(':');
            if (provider && serviceId) {
              bridge?.vprFloatAction?.({ type: 'select-model', provider, serviceId });
            }
          }}
          aria-label="Model"
        >
          {!selectedModel && <option value="">Select model</option>}
          {models.map((model) => (
            <option key={`${model.provider}:${model.serviceId}`} value={`${model.provider}:${model.serviceId}`}>
              {model.label}
            </option>
          ))}
        </select>

        {apps.length > 1 ? (
          <select
            className={styles.appSelect}
            style={{ width: appSelectWidth }}
            value={selectedApp?.name ?? ''}
            onChange={(event) => setAppChoice(event.currentTarget.value)}
            aria-label="App"
          >
            {apps.map((app) => (
              <option key={app.name} value={app.name}>{app.displayName}</option>
            ))}
          </select>
        ) : (
          <span className={styles.app}>{appLabel}</span>
        )}

        {data?.usageLabel ? <span className={styles.usage}>{data.usageLabel}</span> : null}
      </div>

      <button
        type="button"
        className={styles.shrink}
        onClick={() => setCompactMode(true)}
        aria-label="Shrink to badge"
        title="Shrink"
      >
        <HugeiconsIcon icon={ArrowShrink02Icon} size={13} strokeWidth={2} />
      </button>

      <button
        type="button"
        className={styles.close}
        onClick={() => { void bridge?.vprFloatClose?.(); }}
        aria-label="Close floating window"
        title="Close"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

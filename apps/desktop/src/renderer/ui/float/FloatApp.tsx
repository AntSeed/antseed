import { useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon } from '@hugeicons/core-free-icons';
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
  const pulseTimer = useRef<number | null>(null);

  useEffect(() => bridge?.onVprFloatData?.(setData) ?? undefined, [bridge]);

  const apps = data?.apps ?? [];
  // The user's local dropdown choice wins while that app is still connected;
  // otherwise fall back to what the main window suggests.
  const selectedApp = useMemo(() => {
    if (appChoice && apps.some((app) => app.name === appChoice)) {
      return apps.find((app) => app.name === appChoice)!;
    }
    return apps.find((app) => app.name === data?.selectedApp) ?? apps[0] ?? null;
  }, [appChoice, apps, data?.selectedApp]);

  // Pulse the app icon while traffic is moving through the proxies. Active
  // payloads extend a safety hold; an explicit inactive payload stops the
  // pulse right away so it stays in sync with the actual traffic.
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

  return (
    <div className={styles.pill}>
      <button
        type="button"
        className={`${styles.appBadge}${pulsing ? ` ${styles.appBadgeActive}` : ''}`}
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

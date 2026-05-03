import { useState, useEffect, useCallback, useRef } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ShoppingBag03Icon,
  Wallet02Icon,
  LaptopIcon,
  EthernetPortIcon,
  Download04Icon,
  Upload04Icon,
  Award01Icon,
  Blockchain01Icon,
  CodeSquareIcon,
  FloppyDiskIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import styles from './ConfigView.module.scss';

type SelectOption = { value: string; label: string; hint?: string };

function InlineSelect({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={wrapperRef} className={styles.selectWrap}>
      <button
        type="button"
        className={styles.selectTrigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={styles.selectTriggerLabel}>
          {selected ? selected.label : 'Select…'}
        </span>
        <svg
          className={`${styles.selectChevron}${open ? ` ${styles.selectChevronOpen}` : ''}`}
          width="10" height="6" viewBox="0 0 10 6" fill="none"
          aria-hidden="true"
        >
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className={styles.selectPopover} role="listbox" aria-label={ariaLabel}>
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={active}
                className={`${styles.selectOption}${active ? ` ${styles.selectOptionActive}` : ''}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span className={styles.selectOptionText}>
                  <span className={styles.selectOptionLabel}>{opt.label}</span>
                  {opt.hint && <span className={styles.selectOptionHint}>{opt.hint}</span>}
                </span>
                {active && (
                  <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} className={styles.selectOptionTick} />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const CHAIN_OPTIONS: SelectOption[] = [
  { value: 'base-mainnet', label: 'Base Mainnet' },
  { value: 'base-sepolia', label: 'Base Sepolia', hint: 'testnet' },
  { value: 'base-local', label: 'Base Local', hint: 'development' },
];

type ConfigViewProps = {
  active: boolean;
};

export function ConfigView({ active }: ConfigViewProps) {
  const { configFormData, configSaving, devMode, configMessage } = useUiSnapshot();
  const actions = useActions();

  // Local form state — initialized from config, edited locally, saved on button click
  const [proxyPort, setProxyPort] = useState('8377');
  const [maxInput, setMaxInput] = useState('0');
  const [maxOutput, setMaxOutput] = useState('0');
  const [minRep, setMinRep] = useState('0');
  const [chainId, setChainId] = useState('base-mainnet');
  const [dirty, setDirty] = useState(false);

  // Sync from config on first load only
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (configFormData && !initialized) {
      setProxyPort(String(configFormData.proxyPort));
      setMaxInput(String(configFormData.maxInputUsdPerMillion));
      setMaxOutput(String(configFormData.maxOutputUsdPerMillion));
      setMinRep(String(configFormData.minRep));
      setChainId(configFormData.cryptoChainId || 'base-mainnet');
      setInitialized(true);
    }
  }, [configFormData, initialized]);

  const markDirty = useCallback(() => setDirty(true), []);

  function toggleDevMode() {
    if (!configFormData) return;
    void actions.saveConfig({ ...configFormData, devMode: !devMode });
  }

  async function handleSaveAndRestart() {
    if (!configFormData) return;
    await actions.saveConfig({
      ...configFormData,
      proxyPort: parseInt(proxyPort, 10) || 8377,
      maxInputUsdPerMillion: parseFloat(maxInput) || 0,
      maxOutputUsdPerMillion: parseFloat(maxOutput) || 0,
      minRep: parseInt(minRep, 10) || 0,
      cryptoChainId: chainId,
    });
    setDirty(false);
    try { await actions.stopConnect(); } catch { /* may not be running */ }
    try { await actions.startConnect(); } catch { /* will auto-start on next request */ }
  }

  return (
    <section className={`view${active ? ' active' : ''} ${styles.page}`} role="tabpanel">
      <div className={styles.shell}>
          <header className={styles.intro}>
            <div className={styles.introMain}>
              <span className={styles.eyebrow}>Preferences</span>
              <h2 className={styles.title}>Settings</h2>
              <p className={styles.subtitle}>
                Tune how your node discovers peers, prices token streams, and settles payments on-chain.
              </p>
            </div>
            {configMessage && (
              <span
                key={configMessage.text}
                className={`${styles.statusChip} ${
                  configMessage.type === 'success'
                    ? styles.statusChipSuccess
                    : configMessage.type === 'error'
                      ? styles.statusChipError
                      : styles.statusChipInfo
                }`}
                role="status"
                aria-live="polite"
                title={configMessage.text}
              >
                <span className={styles.statusDot} aria-hidden="true" />
                <span className={styles.statusText}>{configMessage.text}</span>
              </span>
            )}
          </header>

          {/* ─── Buyer Settings ─── */}
          <article className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.cardHeadIcon}>
                <HugeiconsIcon icon={ShoppingBag03Icon} size={16} strokeWidth={1.5} />
              </span>
              <div className={styles.cardHeadText}>
                <h3 className={styles.cardHeadTitle}>Buyer Settings</h3>
                <p className={styles.cardHeadDesc}>Routing, pricing limits, and peer quality filters.</p>
              </div>
            </div>

            <div className={styles.rows}>
              <label className={styles.row}>
                <span className={styles.rowIcon}>
                  <HugeiconsIcon icon={EthernetPortIcon} size={16} strokeWidth={1.5} />
                </span>
                <div className={styles.rowCopy}>
                  <span className={styles.rowTitle}>Proxy Port</span>
                  <span className={styles.rowDesc}>Local port for service routing and chat requests.</span>
                </div>
                <span className={styles.inputWrap}>
                  <input
                    type="number"
                    className={styles.input}
                    value={proxyPort}
                    onChange={(e) => { setProxyPort(e.target.value); markDirty(); }}
                  />
                </span>
              </label>

              <label className={styles.row}>
                <span className={styles.rowIcon}>
                  <HugeiconsIcon icon={Download04Icon} size={16} strokeWidth={1.5} />
                </span>
                <div className={styles.rowCopy}>
                  <span className={styles.rowTitle}>Max Input Price</span>
                  <span className={styles.rowDesc}>Highest input token price you will accept.</span>
                </div>
                <span className={styles.inputWrap}>
                  <input
                    type="number"
                    className={styles.input}
                    step="0.01"
                    value={maxInput}
                    onChange={(e) => { setMaxInput(e.target.value); markDirty(); }}
                  />
                  <span className={styles.inputUnit}>$ / 1M</span>
                </span>
              </label>

              <label className={styles.row}>
                <span className={styles.rowIcon}>
                  <HugeiconsIcon icon={Upload04Icon} size={16} strokeWidth={1.5} />
                </span>
                <div className={styles.rowCopy}>
                  <span className={styles.rowTitle}>Max Output Price</span>
                  <span className={styles.rowDesc}>Highest output token price you will accept.</span>
                </div>
                <span className={styles.inputWrap}>
                  <input
                    type="number"
                    className={styles.input}
                    step="0.01"
                    value={maxOutput}
                    onChange={(e) => { setMaxOutput(e.target.value); markDirty(); }}
                  />
                  <span className={styles.inputUnit}>$ / 1M</span>
                </span>
              </label>

              <label className={styles.row}>
                <span className={styles.rowIcon}>
                  <HugeiconsIcon icon={Award01Icon} size={16} strokeWidth={1.5} />
                </span>
                <div className={styles.rowCopy}>
                  <span className={styles.rowTitle}>Minimum Peer Reputation</span>
                  <span className={styles.rowDesc}>Peers below this score are excluded from routing.</span>
                </div>
                <span className={styles.inputWrap}>
                  <input
                    type="number"
                    className={styles.input}
                    min="0"
                    max="100"
                    value={minRep}
                    onChange={(e) => { setMinRep(e.target.value); markDirty(); }}
                  />
                  <span className={styles.inputUnit}>/ 100</span>
                </span>
              </label>
            </div>
          </article>

          {/* ─── Payment Settings ─── */}
          <article className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.cardHeadIcon}>
                <HugeiconsIcon icon={Wallet02Icon} size={16} strokeWidth={1.5} />
              </span>
              <div className={styles.cardHeadText}>
                <h3 className={styles.cardHeadTitle}>Payment Settings</h3>
                <p className={styles.cardHeadDesc}>Settlement chain and on-chain payment routing.</p>
              </div>
            </div>

            <div className={styles.rows}>
              <label className={styles.row}>
                <span className={styles.rowIcon}>
                  <HugeiconsIcon icon={Blockchain01Icon} size={16} strokeWidth={1.5} />
                </span>
                <div className={styles.rowCopy}>
                  <span className={styles.rowTitle}>Chain Environment</span>
                  <span className={styles.rowDesc}>Settlement chain for payments. Contracts resolve automatically.</span>
                </div>
                <InlineSelect
                  ariaLabel="Chain Environment"
                  value={chainId}
                  options={CHAIN_OPTIONS}
                  onChange={(v) => { setChainId(v); markDirty(); }}
                />
              </label>
            </div>
          </article>

          {/* ─── Desktop Preferences ─── */}
          <article className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.cardHeadIcon}>
                <HugeiconsIcon icon={LaptopIcon} size={16} strokeWidth={1.5} />
              </span>
              <div className={styles.cardHeadText}>
                <h3 className={styles.cardHeadTitle}>Desktop Preferences</h3>
                <p className={styles.cardHeadDesc}>App-only options that don't require a restart.</p>
              </div>
            </div>

            <div className={styles.rows}>
              <div className={styles.row}>
                <span className={styles.rowIcon}>
                  <HugeiconsIcon icon={CodeSquareIcon} size={16} strokeWidth={1.5} />
                </span>
                <div className={styles.rowCopy}>
                  <span className={styles.rowTitle}>Developer Mode</span>
                  <span className={styles.rowDesc}>Shows Connection, Peers, and Logs in the sidebar.</span>
                </div>
                <button
                  type="button"
                  className={`${styles.toggle}${devMode ? ` ${styles.toggleOn}` : ''}`}
                  aria-pressed={devMode}
                  onClick={toggleDevMode}
                  disabled={configSaving}
                >
                  <span className={styles.toggleLabel}>{devMode ? 'On' : 'Off'}</span>
                  <span className={styles.toggleTrack}>
                    <span className={styles.toggleThumb} />
                  </span>
                </button>
              </div>
            </div>
          </article>

          {/* ─── Sticky save bar (only when dirty) ─── */}
          {dirty && (
            <div className={styles.saveBar}>
              <span className={styles.saveBarDot} aria-hidden="true" />
              <span className={styles.saveBarText}>
                <strong>Unsaved changes.</strong> Saving will restart the buyer runtime.
              </span>
              <button
                type="button"
                className={styles.saveBarBtn}
                onClick={() => void handleSaveAndRestart()}
                disabled={configSaving}
              >
                <HugeiconsIcon icon={FloppyDiskIcon} size={14} strokeWidth={1.8} />
                {configSaving ? 'Saving…' : 'Save & Restart'}
              </button>
            </div>
          )}

        </div>
    </section>
  );
}

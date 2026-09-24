import { useRef, useState, type ReactNode } from 'react';

/** Open the browser dashboard and surface launcher failures. */
export function StakingButton({ className, children, page = 'stake', disabled = false }: { className?: string; children: ReactNode; page?: 'stake' | 'rewards'; disabled?: boolean }) {
  const opening = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = async () => {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    setError('');
    try {
      const launch = window.antseedDesktop?.stakingOpen;
      if (!launch) throw new Error('Staking is available in the VPR desktop app.');
      const result = await launch({ page });
      if (!result.ok) throw new Error(result.error || 'Could not open Staking.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open Staking.');
    } finally {
      opening.current = false;
      setBusy(false);
    }
  };
  return <>
    <button type="button" className={className} onClick={() => void open()} disabled={busy || disabled} aria-busy={busy}>
      {busy ? 'Opening…' : children}
    </button>
    {error && <span role="alert" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{error}</span>}
  </>;
}

import { Button } from './ui';
import { useEffect, useState } from 'react';
import type { WithdrawRequest } from '../../../src/api-types';
import { api, type WithdrawPreview } from '../api';
import { describeError, formatAnts, formatBps } from '../format';
import { useJobs } from '../jobs';
import { Confirm, useActionBlock } from './Confirm';
import { Spinner } from './Feedback';

interface Props {
  positionIds: number[];
  size?: 'sm';
  /** Open the preview immediately instead of waiting for the button (row-level withdraw). */
  autoOpen?: boolean;
  onStarted?: () => void;
  onCancel?: () => void;
}

/** Withdraw flow: preview first (synchronous), then an explicit slashing acknowledgement when exiting early. */
export function WithdrawAction({ positionIds, size, autoOpen = false, onStarted, onCancel }: Props) {
  const jobs = useJobs();
  const block = useActionBlock();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<WithdrawPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadPreview = async () => {
    setLoadingPreview(true);
    setPreview(null);
    setPreviewError(null);
    setAccepted(false);
    try {
      setPreview(await api.withdrawPreview(positionIds));
    } catch (err) {
      setPreviewError(describeError(err));
    } finally {
      setLoadingPreview(false);
    }
  };

  const onOpen = () => {
    setOpen(true);
    setError(null);
    void loadPreview();
  };

  const disabled = block.blocked || positionIds.length === 0;

  useEffect(() => {
    if (autoOpen && !disabled) onOpen();
    // Only on mount: the caller remounts this component per position selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onConfirm = async () => {
    if (!preview) return;
    const body: WithdrawRequest = {
      positionIds,
      acceptSlashing: preview.earlyExit && accepted,
      maxSlashedAmount: preview.totalSlashed,
    };
    setBusy(true);
    setError(null);
    try {
      await jobs.start('/api/positions/withdraw', body);
      setOpen(false);
      onStarted?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const reason = block.reason ?? (positionIds.length === 0 ? 'Select at least one position.' : undefined);
  const canConfirm = preview !== null && (!preview.earlyExit || accepted);

  return (
    <div className="action">
      {open && autoOpen ? null : (
        <span className="btn-wrap" title={reason}>
          <Button variant="outline" size={size === 'sm' ? 'sm' : 'md'} onClick={onOpen} disabled={disabled}>
            Withdraw
          </Button>
        </span>
      )}
      {open ? (
        <Confirm
          title={`Withdraw ${positionIds.length} position${positionIds.length === 1 ? '' : 's'}`}
          confirmLabel={preview?.earlyExit ? 'Withdraw and burn slashed principal' : 'Withdraw'}
          danger={preview?.earlyExit === true}
          disabled={!canConfirm}
          busy={busy}
          error={error}
          onConfirm={() => {
            void onConfirm();
          }}
          onCancel={() => {
            setOpen(false);
            onCancel?.();
          }}
        >
          {loadingPreview ? (
            <div className="muted small">
              <Spinner /> Computing slashing preview…
            </div>
          ) : null}
          {previewError ? (
            <div>
              <div className="error-text">{previewError}</div>
              <div className="mt">
                <Button variant="outline" size="sm" onClick={() => void loadPreview()}>
                  Retry preview
                </Button>
              </div>
            </div>
          ) : null}
          {preview ? (
            <div className="stack">
              <div className="table-wrap" style={{ marginBottom: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th className="num">Amount</th>
                      <th className="num">Slash</th>
                      <th className="num">Burned</th>
                      <th className="num">Returned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.positions.map((p) => (
                      <tr key={p.id}>
                        <td className="mono">#{p.id}</td>
                        <td className="num">{formatAnts(p.amount, 4)}</td>
                        <td className={`num ${p.slashBps > 0 ? 'danger' : ''}`}>{formatBps(p.slashBps)}</td>
                        <td className={`num ${p.slashBps > 0 ? 'danger' : ''}`}>{formatAnts(p.slashedAmount, 4)}</td>
                        <td className="num">{formatAnts(p.returnedAmount, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td />
                      <td />
                      <td className={`num ${preview.earlyExit ? 'danger' : ''}`}>{formatAnts(preview.totalSlashed, 4)}</td>
                      <td className="num">{formatAnts(preview.totalReturned, 4)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {preview.earlyExit ? (
                <label className="check danger">
                  <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
                  <span>
                    I accept burning <span className="mono">{formatAnts(preview.totalSlashed, 4)}</span> ANTS of principal (early exit).
                  </span>
                </label>
              ) : (
                <div className="hint">No early-exit slashing applies. Pending rewards are settled with the withdrawal.</div>
              )}
            </div>
          ) : null}
        </Confirm>
      ) : null}
    </div>
  );
}

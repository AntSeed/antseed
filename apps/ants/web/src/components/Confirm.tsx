import { Button, Card } from './ui';
import { useState, type ReactNode } from 'react';
import { useConfig } from '../app-context';
import { describeError } from '../format';
import { useJobs } from '../jobs';

export type Summary = Array<[string, ReactNode]>;

interface ConfirmProps {
  title: string;
  summary?: Summary;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Inline confirmation panel: summarises exactly what will be sent before a signing job starts. */
export function Confirm({ title, summary, children, confirmLabel = 'Confirm', danger, disabled, busy, error, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Card className="confirm" tone={danger ? 'danger' : 'surface'} role="dialog" aria-label={title}>
      <div className="confirm-title">{title}</div>
      {summary && summary.length > 0 ? (
        <dl className="facts">
          {summary.map(([label, value], index) => (
            <SummaryRow key={`${label}-${index}`} label={label} value={value} />
          ))}
        </dl>
      ) : null}
      {children}
      {error ? <div className="error-text">{error}</div> : null}
      <div className="confirm-actions">
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={disabled || busy}>
          {busy ? 'Sending…' : confirmLabel}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

export interface ActionButtonProps {
  label: string;
  title?: string;
  summary: Summary;
  path: string;
  body: unknown;
  /** Return an error message to block opening the confirm panel. */
  validate?: () => string | null;
  disabled?: boolean;
  disabledReason?: string;
  variant?: 'primary' | 'default' | 'danger';
  size?: 'sm';
  confirmLabel?: string;
  /** Keep the confirm panel open but block its Confirm button (e.g. a required select has no options yet). */
  confirmDisabled?: boolean;
  children?: ReactNode;
  onStarted?: () => void;
}

/** Hook describing why actions are blocked (read-only wallet or a job already running). */
export function useActionBlock(): { blocked: boolean; reason: string | undefined } {
  const { readOnly } = useConfig();
  const { running } = useJobs();
  if (readOnly) return { blocked: true, reason: 'Read-only mode: no wallet is available to sign.' };
  if (running) return { blocked: true, reason: 'Another action is still running.' };
  return { blocked: false, reason: undefined };
}

/** Button that opens an inline confirm panel and starts a job on confirm. */
export function ActionButton(props: ActionButtonProps) {
  const jobs = useJobs();
  const block = useActionBlock();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const blocked = block.blocked || props.disabled === true;
  const reason = block.reason ?? (props.disabled ? props.disabledReason : undefined);

  const onClick = () => {
    const problem = props.validate?.() ?? null;
    setError(problem);
    setOpen(problem === null);
  };

  const onConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await jobs.start(props.path, props.body);
      setOpen(false);
      props.onStarted?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const variant = props.variant === 'primary' ? 'primary' : props.variant === 'danger' ? 'danger' : 'outline';

  return (
    <div className="action">
      <span className="btn-wrap" title={reason}>
        <Button variant={variant} size={props.size === 'sm' ? 'sm' : 'md'} onClick={onClick} disabled={blocked}>
          {props.label}
        </Button>
      </span>
      {error && !open ? <div className="error-text">{error}</div> : null}
      {open ? (
        <Confirm
          title={props.title ?? props.label}
          summary={props.summary}
          confirmLabel={props.confirmLabel}
          danger={props.variant === 'danger'}
          disabled={props.confirmDisabled}
          busy={busy}
          error={error}
          onConfirm={() => {
            void onConfirm();
          }}
          onCancel={() => {
            setOpen(false);
            setError(null);
          }}
        >
          {props.children}
        </Confirm>
      ) : null}
    </div>
  );
}

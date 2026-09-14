import type { ReactNode } from 'react';

/** Collapsed-by-default section (native <details>) for numbers and forms that are not needed at a glance. */
export function Details({ summary, children, open, className }: { summary: ReactNode; children: ReactNode; open?: boolean; className?: string }) {
  return (
    <details className={['details', className ?? ''].filter(Boolean).join(' ')} open={open}>
      <summary>{summary}</summary>
      <div className="details-body">{children}</div>
    </details>
  );
}

import type { ToolApprovalRequest } from '../../../types/bridge';
import styles from './ToolApprovalCard.module.scss';

type ToolApprovalCardProps = {
  request: ToolApprovalRequest | null;
  onAllowOnce: () => void;
  onAlwaysAllow: () => void;
  onDeny: () => void;
};

function getWorkspaceLabel(workspacePath: string): string {
  const trimmed = workspacePath.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return 'this workspace';
  return trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed;
}

function getPeerLabel(request: ToolApprovalRequest): string {
  return request.peerName || (request.peerId ? `${request.peerId.slice(0, 8)}…` : 'No pinned peer');
}

export function ToolApprovalCard({ request, onAllowOnce, onAlwaysAllow, onDeny }: ToolApprovalCardProps) {
  if (!request) return null;

  return (
    <div className={styles.approval} role="group" aria-label={request.title}>
      <div className={styles.header}>
        <div className={styles.title}>{request.title}</div>
        <div className={styles.description}>{request.description}</div>
      </div>
      {request.subject ? <div className={styles.subject}>{request.subject}</div> : null}
      <div className={styles.meta}>Tool: {request.toolName} · Peer: {getPeerLabel(request)} · Workspace: {getWorkspaceLabel(request.workspacePath)}</div>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={onAllowOnce}>Allow once</button>
        {request.canAlwaysAllow ? (
          <button type="button" className={styles.secondary} onClick={onAlwaysAllow}>{request.alwaysAllowLabel}</button>
        ) : null}
        <button type="button" className={styles.danger} onClick={onDeny}>Deny</button>
      </div>
    </div>
  );
}

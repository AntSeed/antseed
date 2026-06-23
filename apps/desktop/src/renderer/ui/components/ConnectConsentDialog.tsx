import { useEffect, useState } from 'react';
import { Button, Modal } from '@antseed/ui';
import styles from './ConnectConsentDialog.module.scss';

type ConnectScope = {
  id: string;
  label: string;
  description: string;
  value: string;
};

type ConnectRequestData = {
  id: string;
  origin: string;
  appName: string | null;
  appIcon: string | null;
  scopes: ConnectScope[];
};

/**
 * Consent prompt for an AntSeed Connect request. Display and decision only.
 * The wallet and signing stay in the main process.
 */
export function ConnectConsentDialog() {
  const [request, setRequest] = useState<ConnectRequestData | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => window.antseedDesktop?.onConnectRequest?.((data) => setRequest(data)), []);

  const respond = async (approved: boolean) => {
    if (!request || busy) return;
    setBusy(true);
    try {
      await window.antseedDesktop?.connectRespond?.(request.id, approved);
    } finally {
      setBusy(false);
      setRequest(null);
    }
  };

  return (
    <Modal
      isOpen={request !== null}
      onClose={() => void respond(false)}
      size="md"
      title="Share account info?"
    >
      {request && (
        <div className={styles.body}>
          <div className={styles.header}>
            {request.appName && (
              <div className={styles.appRow}>
                {request.appIcon && <img className={styles.icon} src={request.appIcon} alt="" />}
                <span className={styles.appName}>{request.appName}</span>
              </div>
            )}
            <p className={styles.origin}>{request.origin}</p>
            <p className={styles.prompt}>wants to read your AntSeed account info:</p>
          </div>
          <ul className={styles.scopes}>
            {request.scopes.map((scope) => (
              <li key={scope.id}>
                <div className={styles.scopeLabel}>{scope.label}</div>
                <code className={styles.scopeValue}>{scope.value}</code>
                <div className={styles.scopeDescription}>{scope.description}</div>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <Button variant="outline" disabled={busy} onClick={() => void respond(false)}>
              Deny
            </Button>
            <Button disabled={busy} onClick={() => void respond(true)}>
              Approve &amp; share
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

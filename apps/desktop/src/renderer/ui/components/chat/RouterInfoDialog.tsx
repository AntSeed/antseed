import { useEffect, useState } from 'react';
import { Button, Modal } from '@antseed/ui';
import type { RouterPluginInfo } from '../../../types/bridge';
import type { AccessBillingSnapshot } from '../../../../shared/access-billing';
import styles from './RouterInfoDialog.module.scss';

type Props = {
  isOpen: boolean;
  plugin: RouterPluginInfo | null;
  onClose: () => void;
  onConfirm: () => void;
};

export function RouterInfoDialog({ isOpen, plugin, onClose, onConfirm }: Props) {
  const [billing, setBilling] = useState<AccessBillingSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const serviceId = plugin?.accessServiceId;
  useEffect(() => {
    let disposed = false;
    setBilling(null);
    setError('');
    if (isOpen && serviceId) {
      void window.antseedDesktop?.chatAiAccessBilling?.({ action: 'status', serviceId }).then((result) => {
        if (disposed) return;
        if (result.ok && result.data) setBilling(result.data);
        else setError(result.error ?? 'Access pricing is unavailable.');
      }).catch(() => { if (!disposed) setError('Access pricing is unavailable.'); });
    }
    return () => { disposed = true; };
  }, [isOpen, serviceId]);
  const offer = billing?.offer;
  const submit = async (action: 'activate' | 'pause') => {
    if (!serviceId) return onConfirm();
    if (!offer || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.antseedDesktop?.chatAiAccessBilling?.({
        action, serviceId, sellerPeerId: offer.peerId,
        amountMicroUsdc: offer.amountMicroUsdc, durationSeconds: offer.durationSeconds,
      });
      if (!result?.ok) throw new Error(result?.error ?? 'Access approval failed');
      if (action === 'activate') onConfirm();
      else onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Access approval failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal bodyClassName={styles.dialogBody} size="sm" isOpen={isOpen} onClose={onClose} title={plugin?.displayName ?? 'Model router'}>
      <p className={styles.paragraph}>{plugin?.description}</p>
      <p className={styles.paragraph}>The router chooses the initial model for a conversation. Later turns reuse that model. Model inference is billed separately.</p>
      {serviceId && <div className={styles.priceLine}>
        {offer ? `$${(Number(offer.amountMicroUsdc) / 1_000_000).toFixed(6)} per ${offer.durationSeconds / 3600}-hour access pass` : 'No unambiguous current access price is available.'}
      </div>}
      {serviceId && <p className={styles.paragraph}>Enabling approves purchase on use, not a purchase now. No idle-period charges. Changed terms pause new purchases until you accept them again.</p>}
      {!serviceId && <p className={styles.paragraph}>Enabling does not approve paid classification. Configure any token-priced or per-call routing service separately.</p>}
      {billing?.agreement?.pauseReason && <p className={styles.paragraph}>Purchases paused: {billing.agreement.pauseReason}.</p>}
      {error && <p className={styles.paragraph} role="alert">{error}</p>}
      <div className={styles.actions}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {billing?.agreement?.enabled && <Button variant="ghost" disabled={busy} onClick={() => void submit('pause')}>Pause purchases</Button>}
        <Button disabled={busy || (!!serviceId && !offer)} onClick={() => void submit('activate')}>
          {serviceId ? 'Accept terms and enable' : 'Enable router'}
        </Button>
      </div>
    </Modal>
  );
}

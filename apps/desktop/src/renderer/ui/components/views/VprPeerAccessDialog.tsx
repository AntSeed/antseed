import { useMemo, useState } from 'react';
import { Button, Modal } from '@antseed/ui';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import type { VprPeerListing, VprRoutingPreferences } from '../../../core/state';
import type { VprPeerOption } from '../../../modules/vpr-tools';
import {
  buildPeerAccessRows,
  filterPeerAccessRows,
  peerAccessModeLabel,
  PEER_ACCESS_STATUS_LABEL,
  type PeerAccessRow,
} from '../../../modules/vpr-peer-access';
import { VprSearch } from '../vpr/VprKit';
import type { PeerAccessStatus } from '../../../modules/vpr-peer-access';
import styles from './VprPeerAccessDialog.module.scss';

/* CSS modules build with camelCaseOnly, so the status classes are looked up
   through an explicit map rather than composed from the status string. */
const STATUS_CLASS: Record<PeerAccessStatus, string> = {
  allowed: styles.statusAllowed,
  blocked: styles.statusBlocked,
  eligible: styles.statusEligible,
  excluded: styles.statusExcluded,
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  preferences: VprRoutingPreferences;
  /** Every peer known from discovery or the last peer scan. */
  peerOptions: VprPeerOption[];
  onSetListing: (peerId: string, listing: VprPeerListing) => void;
  /** Drops the allowlist so every seller is eligible again. */
  onClearAllowlist: () => void;
};

export function VprPeerAccessDialog({
  isOpen,
  onClose,
  preferences,
  peerOptions,
  onSetListing,
  onClearAllowlist,
}: Props) {
  const [query, setQuery] = useState('');

  const rows = useMemo(
    () => buildPeerAccessRows(peerOptions, preferences),
    [peerOptions, preferences],
  );
  const matches = useMemo(() => filterPeerAccessRows(rows, query), [rows, query]);
  const allowlistOn = preferences.allowedPeerIds.length > 0;

  // Toggling the button a seller already sits on clears the rule rather than
  // re-applying it, so every state is reachable from two buttons.
  const toggle = (row: PeerAccessRow, listing: Exclude<VprPeerListing, 'none'>) => {
    onSetListing(row.peerId, row.listing === listing ? 'none' : listing);
  };

  return (
    <Modal
      bodyClassName={styles.dialogBody}
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title="Manage sellers"
    >
      <div className={`${styles.banner}${allowlistOn ? ` ${styles.bannerStrict}` : ''}`}>
        <p className={styles.bannerText}>{peerAccessModeLabel(preferences)}</p>
        {allowlistOn && (
          <button type="button" className={styles.bannerAction} onClick={onClearAllowlist}>
            Clear allowlist
          </button>
        )}
      </div>

      <VprSearch
        value={query}
        onChange={setQuery}
        placeholder="Search sellers"
        ariaLabel="Search sellers"
      />

      {matches.length === 0 ? (
        <div className={styles.empty}>
          {rows.length === 0 ? 'No sellers discovered yet' : 'No sellers match that search'}
        </div>
      ) : (
        <div className={styles.list} role="list">
          {matches.map((row) => (
            <div key={row.peerId} className={styles.row} role="listitem">
              <span className={styles.rowText}>
                <span className={styles.rowName}>{row.label}</span>
                <span className={styles.rowMeta}>
                  <span className={STATUS_CLASS[row.status]}>
                    {PEER_ACCESS_STATUS_LABEL[row.status]}
                  </span>
                  {' · '}
                  {row.online ? 'Online' : 'Offline'}
                </span>
              </span>
              <div className={styles.rowActions}>
                <RuleButton
                  label="Allow"
                  icon={Tick02Icon}
                  pressed={row.listing === 'allowed'}
                  peerLabel={row.label}
                  className={styles.allowButton}
                  onClick={() => toggle(row, 'allowed')}
                />
                <RuleButton
                  label="Block"
                  icon={Cancel01Icon}
                  pressed={row.listing === 'blocked'}
                  peerLabel={row.label}
                  className={styles.blockButton}
                  onClick={() => toggle(row, 'blocked')}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={styles.actions}>
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

function RuleButton({ label, icon, pressed, peerLabel, className, onClick }: {
  label: 'Allow' | 'Block';
  icon: Parameters<typeof HugeiconsIcon>[0]['icon'];
  pressed: boolean;
  peerLabel: string;
  className: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={`${pressed ? `Clear ${label.toLowerCase()} rule for` : `${label}`} ${peerLabel}`}
      title={pressed ? `Clear this rule (${label.toLowerCase()}ed)` : label}
      className={`${styles.ruleButton} ${className}${pressed ? ` ${styles.ruleButtonOn}` : ''}`}
      onClick={onClick}
    >
      <HugeiconsIcon icon={icon} size={13} strokeWidth={2} />
      {label}
    </button>
  );
}

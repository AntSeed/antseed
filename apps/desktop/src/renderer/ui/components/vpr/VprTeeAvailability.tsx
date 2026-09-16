import { HugeiconsIcon } from '@hugeicons/react';
import { Globe02Icon, Shield01Icon } from '@hugeicons/core-free-icons';
import type { TeeBrowseFilter } from '../../../modules/catalog/tee-browse';
import { InfoTooltip } from '../InfoTooltip';
import { VprBadge } from './VprKit';
import { VprFilterDropdown, type VprFilterOption } from './VprFilterDropdown';
import styles from './VprTeeAvailability.module.scss';

const TEE_DESCRIPTION = 'This seller advertises TEE attestation support. This is not a verification verdict and does not guarantee that downstream inference runs inside a TEE.';
const options: readonly VprFilterOption<TeeBrowseFilter>[] = [
  { value: 'all', label: 'All sellers', icon: <HugeiconsIcon icon={Globe02Icon} size={16} /> },
  { value: 'tee', label: 'TEE advertised', description: 'Sellers advertising TEE attestation support', icon: <HugeiconsIcon icon={Shield01Icon} size={16} /> },
];

export function VprTeeBadge({ sellerCount }: { sellerCount?: number }) {
  return (
    <InfoTooltip content={TEE_DESCRIPTION}>
      <span tabIndex={0} className={styles.badge} aria-label={TEE_DESCRIPTION}>
        <VprBadge tone="neutral">
          {sellerCount === undefined ? 'TEE advertised' : `TEE available · ${sellerCount} ${sellerCount === 1 ? 'seller' : 'sellers'}`}
        </VprBadge>
      </span>
    </InfoTooltip>
  );
}

export function VprTeeFilter({ value, onChange }: { value: TeeBrowseFilter; onChange: (value: TeeBrowseFilter) => void }) {
  return (
    <div className={styles.filter}>
      <VprFilterDropdown label="Seller TEE availability" value={value} onChange={onChange} options={options} active={value === 'tee'} />
    </div>
  );
}

export function VprTeeNotice({ selectedSellerHidden, onClear }: { selectedSellerHidden?: boolean; onClear: () => void }) {
  return (
    <div className={styles.notice} role="status">
      <span>Browsing filter only — automatic routing may use other sellers</span>
      <span>Prices and seller counts below reflect TEE-advertised offers.</span>
      {selectedSellerHidden && <span>The selected seller is hidden by this filter. Your selection has not changed.</span>}
      <button type="button" onClick={onClear}>Show all sellers</button>
    </div>
  );
}

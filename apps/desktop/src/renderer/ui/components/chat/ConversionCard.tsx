import type { ConversionOffer } from '../../../core/state';
import styles from './ConversionCard.module.scss';

type ConversionCardProps = {
  offer: ConversionOffer;
  onDeposit: () => void;
  onDismiss: () => void;
};

export function ConversionCard({ offer, onDeposit, onDismiss }: ConversionCardProps) {
  const usage = offer.retrospectiveUsd
    ? `${offer.requestsCount} free requests, worth about $${offer.retrospectiveUsd}.`
    : `${offer.requestsCount} free requests so far.`;

  return (
    <section className={styles.card} aria-label="$10 frontier offer">
      <strong>Add $10</strong>
      <span>{usage}</span>
      <span>$10 gives you about ${offer.prospectiveUsd} of model usage.</span>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={onDeposit}>Add $10</button>
        <button type="button" className={styles.secondary} onClick={onDismiss}>Dismiss</button>
      </div>
    </section>
  );
}

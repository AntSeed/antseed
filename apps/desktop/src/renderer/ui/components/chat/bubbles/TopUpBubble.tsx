import { SignAuthBubble } from './SignAuthBubble';
import type { PaymentBubbleMeta } from '../payment-types';
import styles from '../PaymentBubble.module.scss';

type TopUpBubbleProps = {
  authRequest: NonNullable<PaymentBubbleMeta['authRequest']>;
  onComplete: () => void;
};

export function TopUpBubble({ authRequest, onComplete }: TopUpBubbleProps) {
  return (
    <div className={styles.topUpWrapper}>
      <p className={styles.bubbleHint}>Your session budget is running low</p>
      <SignAuthBubble authRequest={authRequest} onComplete={onComplete} />
    </div>
  );
}

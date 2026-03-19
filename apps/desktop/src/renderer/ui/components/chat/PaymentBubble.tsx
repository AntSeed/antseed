import type { ChatMessage } from './chat-shared';
import { getPaymentMeta } from './payment-types';
import { ConnectBubble } from './bubbles/ConnectBubble';
import { FundBubble } from './bubbles/FundBubble';
import { DepositBubble } from './bubbles/DepositBubble';
import { SignAuthBubble } from './bubbles/SignAuthBubble';
import { TopUpBubble } from './bubbles/TopUpBubble';
import styles from './PaymentBubble.module.scss';

type PaymentBubbleProps = {
  message: ChatMessage;
  onComplete?: (callbackId: string) => void;
};

export function PaymentBubble({ message, onComplete }: PaymentBubbleProps) {
  const meta = getPaymentMeta(message);
  if (!meta) return null;

  const handleComplete = () => {
    if (meta.callbackId && onComplete) {
      onComplete(meta.callbackId);
    }
  };

  return (
    <div className={styles.paymentBubble}>
      {meta.paymentAction === 'connect-wallet' && (
        <ConnectBubble onComplete={handleComplete} />
      )}
      {meta.paymentAction === 'fund-wallet' && (
        <FundBubble onComplete={handleComplete} />
      )}
      {meta.paymentAction === 'deposit-escrow' && (
        <DepositBubble
          suggestedAmount={meta.suggestedAmount}
          onComplete={handleComplete}
        />
      )}
      {meta.paymentAction === 'sign-spending-auth' && meta.authRequest && (
        <SignAuthBubble
          authRequest={meta.authRequest}
          onComplete={handleComplete}
        />
      )}
      {meta.paymentAction === 'topup-auth' && meta.authRequest && (
        <TopUpBubble
          authRequest={meta.authRequest}
          onComplete={handleComplete}
        />
      )}
    </div>
  );
}

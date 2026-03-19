import { ConnectWallet, Wallet } from '@coinbase/onchainkit/wallet';
import { useAccount } from 'wagmi';
import { useEffect } from 'react';
import styles from '../PaymentBubble.module.scss';

type ConnectBubbleProps = { onComplete: () => void };

export function ConnectBubble({ onComplete }: ConnectBubbleProps) {
  const { isConnected } = useAccount();

  useEffect(() => {
    if (isConnected) onComplete();
  }, [isConnected, onComplete]);

  if (isConnected) {
    return (
      <div className={styles.bubbleContent}>
        <div className={styles.bubbleIcon}>&#10003;</div>
        <span className={styles.bubbleText}>Wallet connected</span>
      </div>
    );
  }

  return (
    <div className={styles.bubbleContent}>
      <p className={styles.bubbleText}>Connect your wallet to start chatting</p>
      <Wallet>
        <ConnectWallet className={styles.bubbleAction} />
      </Wallet>
    </div>
  );
}

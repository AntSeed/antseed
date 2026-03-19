import { FundButton } from '@coinbase/onchainkit/fund';
import { useAccount, useBalance } from 'wagmi';
import { base } from 'viem/chains';
import { useEffect } from 'react';
import styles from '../PaymentBubble.module.scss';

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

type FundBubbleProps = { onComplete: () => void };

export function FundBubble({ onComplete }: FundBubbleProps) {
  const { address } = useAccount();
  const { data: balance } = useBalance({
    address,
    token: USDC_ADDRESS,
    chainId: base.id,
    query: { refetchInterval: 10_000 },
  });

  const hasBalance = balance && balance.value > 0n;

  useEffect(() => {
    if (hasBalance) onComplete();
  }, [hasBalance, onComplete]);

  if (hasBalance) {
    return (
      <div className={styles.bubbleContent}>
        <div className={styles.bubbleIcon}>&#10003;</div>
        <span className={styles.bubbleText}>Wallet funded</span>
      </div>
    );
  }

  return (
    <div className={styles.bubbleContent}>
      <p className={styles.bubbleText}>Fund your wallet with USDC to get started</p>
      <div className={styles.bubbleActions}>
        <FundButton className={styles.bubbleAction} text="Buy USDC" />
        <FundButton className={styles.bubbleAction} text="Buy ETH (for gas)" />
      </div>
    </div>
  );
}

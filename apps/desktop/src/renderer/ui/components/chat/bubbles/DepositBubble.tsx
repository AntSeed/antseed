import {
  Transaction,
  TransactionButton,
  TransactionStatus,
  TransactionStatusLabel,
  TransactionStatusAction,
} from '@coinbase/onchainkit/transaction';
import type { LifecycleStatus } from '@coinbase/onchainkit/transaction';
import { useCallback } from 'react';
import { base } from 'viem/chains';
import { encodeFunctionData } from 'viem';
import styles from '../PaymentBubble.module.scss';

const ESCROW_ADDRESS = '0x...'; // TODO: from config
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

type DepositBubbleProps = {
  suggestedAmount?: string;
  onComplete: () => void;
};

export function DepositBubble({ suggestedAmount, onComplete }: DepositBubbleProps) {
  const amount = BigInt(suggestedAmount || '10000000'); // 10 USDC default
  const formatted = `${Number(amount) / 1_000_000} USDC`;

  const calls = [
    // Step 1: Approve USDC spending
    {
      to: USDC_ADDRESS as `0x${string}`,
      data: encodeFunctionData({
        abi: [{ name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' }],
        functionName: 'approve',
        args: [ESCROW_ADDRESS as `0x${string}`, amount],
      }),
    },
    // Step 2: Deposit into escrow
    {
      to: ESCROW_ADDRESS as `0x${string}`,
      data: encodeFunctionData({
        abi: [{ name: 'deposit', type: 'function', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }],
        functionName: 'deposit',
        args: [amount],
      }),
    },
  ];

  const handleStatus = useCallback((status: LifecycleStatus) => {
    if (status.statusName === 'success') {
      onComplete();
    }
  }, [onComplete]);

  return (
    <div className={styles.bubbleContent}>
      <p className={styles.bubbleText}>Deposit {formatted} into escrow to enable payments</p>
      <Transaction
        chainId={base.id}
        calls={calls}
        onStatus={handleStatus}
      >
        <TransactionButton text={`Deposit ${formatted}`} className={styles.bubbleAction} />
        <TransactionStatus>
          <TransactionStatusLabel />
          <TransactionStatusAction />
        </TransactionStatus>
      </Transaction>
    </div>
  );
}

import {
  Signature,
  SignatureButton,
  SignatureStatus,
} from '@coinbase/onchainkit/signature';
import { useCallback } from 'react';
import { useAccount } from 'wagmi';
import type { PaymentBubbleMeta } from '../payment-types';
import styles from '../PaymentBubble.module.scss';

type SignAuthBubbleProps = {
  authRequest: NonNullable<PaymentBubbleMeta['authRequest']>;
  onComplete: () => void;
};

// EIP-712 domain for AntseedEscrow
const ESCROW_DOMAIN = {
  name: 'AntseedEscrow',
  version: '1',
  chainId: 8453,
  verifyingContract: '0x...' as `0x${string}`, // TODO: from config
};

const SPENDING_AUTH_TYPES = {
  SpendingAuth: [
    { name: 'seller', type: 'address' },
    { name: 'sessionId', type: 'bytes32' },
    { name: 'maxAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'previousConsumption', type: 'uint256' },
    { name: 'previousSessionId', type: 'bytes32' },
  ],
} as const;

export function SignAuthBubble({ authRequest, onComplete }: SignAuthBubbleProps) {
  const { address } = useAccount();
  const maxAmountUsdc = `${Number(BigInt(authRequest.maxAmount)) / 1_000_000} USDC`;
  const sellerShort = `${authRequest.sellerPeerId.slice(0, 8)}...`;

  const message = {
    seller: authRequest.seller as `0x${string}`,
    sessionId: authRequest.sessionId as `0x${string}`,
    maxAmount: BigInt(authRequest.maxAmount),
    nonce: BigInt(authRequest.nonce),
    deadline: BigInt(authRequest.deadline),
    previousConsumption: BigInt(authRequest.previousConsumption),
    previousSessionId: authRequest.previousSessionId as `0x${string}`,
  };

  const handleSuccess = useCallback(async (sig: string) => {
    const bridge = (window as unknown as Record<string, unknown>).antseedDesktop as
      | { sendSpendingAuth?: (payload: Record<string, unknown>) => Promise<unknown> }
      | undefined;
    if (bridge?.sendSpendingAuth) {
      await bridge.sendSpendingAuth({
        ...authRequest,
        buyerSig: sig,
        buyerEvmAddr: address,
      });
    }
    onComplete();
  }, [authRequest, onComplete, address]);

  return (
    <div className={styles.bubbleContent}>
      <div className={styles.authDetails}>
        <p className={styles.bubbleText}>Authorize spending for this session</p>
        <div className={styles.authInfo}>
          <span className={styles.authLabel}>Seller</span>
          <span className={styles.authValue}>{sellerShort}</span>
        </div>
        <div className={styles.authInfo}>
          <span className={styles.authLabel}>Max amount</span>
          <span className={styles.authValue}>{maxAmountUsdc}</span>
        </div>
      </div>
      <Signature
        domain={ESCROW_DOMAIN}
        types={SPENDING_AUTH_TYPES}
        primaryType="SpendingAuth"
        message={message}
        onSuccess={handleSuccess}
      >
        <SignatureButton className={styles.bubbleAction} label="Approve" />
        <SignatureStatus />
      </Signature>
    </div>
  );
}

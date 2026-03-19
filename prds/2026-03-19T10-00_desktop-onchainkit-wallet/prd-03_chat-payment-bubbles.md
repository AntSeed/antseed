# PRD-03: Chat Payment Bubbles

**Created:** 2026-03-19T10:00:00Z
**Dependencies:** PRD-01
**Estimated Tasks:** 6

## Overview

Create special chat bubble components for payment interactions. These render inline in the chat conversation as system messages, embedding OnchainKit components for wallet connect, funding, USDC deposit, SpendingAuth signing, and top-up authorization.

---

### Task 1: Define payment bubble message types

##### CREATE: apps/desktop/src/renderer/ui/components/chat/payment-types.ts

Define the message shape for payment-related system bubbles. These extend the existing `ChatMessage` pattern with a `meta.paymentAction` discriminator.

```typescript
/**
 * Payment bubble types — rendered inline in chat as system messages.
 * Discriminated by meta.paymentAction.
 */
export type PaymentAction =
  | 'connect-wallet'
  | 'fund-wallet'
  | 'deposit-escrow'
  | 'sign-spending-auth'
  | 'topup-auth';

export type PaymentBubbleMeta = {
  paymentAction: PaymentAction;
  /** For sign-spending-auth: EIP-712 domain + message */
  authRequest?: {
    seller: string;
    sellerPeerId: string;
    sessionId: string;
    maxAmount: string;       // USDC base units as string
    nonce: number;
    deadline: number;
    previousConsumption: string;
    previousSessionId: string;
  };
  /** For deposit-escrow: suggested deposit amount */
  suggestedAmount?: string;
  /** Completion callback key (used by orchestrator) */
  callbackId?: string;
};

/** Helper to check if a ChatMessage is a payment bubble */
export function isPaymentBubble(msg: { role: string; meta?: Record<string, unknown> }): boolean {
  return msg.role === 'system' && typeof msg.meta?.paymentAction === 'string';
}

/** Extract payment meta from a ChatMessage */
export function getPaymentMeta(msg: { meta?: Record<string, unknown> }): PaymentBubbleMeta | null {
  if (!msg.meta?.paymentAction) return null;
  return msg.meta as unknown as PaymentBubbleMeta;
}
```

#### Acceptance Criteria
- [ ] Types exported correctly
- [ ] `isPaymentBubble` correctly identifies payment system messages
- [ ] `getPaymentMeta` extracts typed meta
- [ ] No TypeScript errors

---

### Task 2: Create PaymentBubble container component

##### CREATE: apps/desktop/src/renderer/ui/components/chat/PaymentBubble.tsx

A container component that reads `meta.paymentAction` and renders the appropriate OnchainKit-powered bubble. Each bubble type is a sub-component.

```tsx
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
```

#### Acceptance Criteria
- [ ] Renders correct sub-component based on paymentAction
- [ ] Passes onComplete callback through
- [ ] Returns null for unknown payment actions
- [ ] No TypeScript errors

---

### Task 3: Create ConnectBubble and FundBubble components

##### CREATE: apps/desktop/src/renderer/ui/components/chat/bubbles/ConnectBubble.tsx

```tsx
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
```

##### CREATE: apps/desktop/src/renderer/ui/components/chat/bubbles/FundBubble.tsx

```tsx
import { FundButton, getOnrampBuyUrl } from '@coinbase/onchainkit/fund';
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
```

#### Acceptance Criteria
- [ ] ConnectBubble shows connect button when disconnected, checkmark when connected
- [ ] ConnectBubble calls onComplete when wallet connects
- [ ] FundBubble shows fund buttons when balance is zero
- [ ] FundBubble calls onComplete when balance appears (polls every 10s)
- [ ] Both use shared PaymentBubble styles

---

### Task 4: Create DepositBubble component

##### CREATE: apps/desktop/src/renderer/ui/components/chat/bubbles/DepositBubble.tsx

Uses OnchainKit's `<Transaction />` to deposit USDC into the AntseedEscrow contract. Shows suggested amount, handles USDC approval + deposit in one flow.

```tsx
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
```

#### Acceptance Criteria
- [ ] Shows suggested deposit amount in readable format
- [ ] Transaction batches USDC approve + escrow deposit
- [ ] Calls onComplete on success
- [ ] Shows transaction status (pending, success, error)
- [ ] Uses Base chain ID

---

### Task 5: Create SignAuthBubble and TopUpBubble components

##### CREATE: apps/desktop/src/renderer/ui/components/chat/bubbles/SignAuthBubble.tsx

Uses OnchainKit's `<Signature />` component for EIP-712 SpendingAuth signing.

```tsx
import {
  Signature,
  SignatureButton,
  SignatureStatus,
} from '@coinbase/onchainkit/signature';
import { useCallback } from 'react';
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

  const handleSuccess = useCallback((sig: string) => {
    // TODO (PRD-04): Send signature to the payment flow orchestrator
    console.log('[SignAuth] Signature obtained:', sig.slice(0, 20) + '...');
    onComplete();
  }, [onComplete]);

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
        <SignatureButton className={styles.bubbleAction} text="Approve" />
        <SignatureStatus />
      </Signature>
    </div>
  );
}
```

##### CREATE: apps/desktop/src/renderer/ui/components/chat/bubbles/TopUpBubble.tsx

Same as SignAuthBubble but with different display text indicating this is a top-up (additional budget).

```tsx
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
```

#### Acceptance Criteria
- [ ] SignAuthBubble displays seller and max amount in readable format
- [ ] Signature component uses correct EIP-712 domain and types matching AntseedEscrow
- [ ] onSuccess fires with the signature hex string
- [ ] TopUpBubble wraps SignAuthBubble with contextual "budget low" message
- [ ] No TypeScript errors

---

### Task 6: Create PaymentBubble styles and wire into ChatBubble

##### CREATE: apps/desktop/src/renderer/ui/components/chat/PaymentBubble.module.scss

```scss
.paymentBubble {
  max-width: 420px;
  margin: 12px auto;
}

.bubbleContent {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  padding: 16px 20px;
}

.bubbleText {
  font-size: 14px;
  color: var(--text-primary);
  margin-bottom: 12px;
  line-height: 1.5;
}

.bubbleHint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.bubbleIcon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent);
  color: white;
  font-size: 12px;
  margin-right: 8px;
}

.bubbleAction {
  margin-top: 8px;
}

.bubbleActions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.authDetails {
  margin-bottom: 12px;
}

.authInfo {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0;
  font-size: 13px;
}

.authLabel {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.authValue {
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
}

.topUpWrapper {
  // Inherits paymentBubble styling
}
```

##### MODIFY: apps/desktop/src/renderer/ui/components/chat/ChatBubble.tsx

**Add import** (after existing imports):
```tsx
import { isPaymentBubble } from './payment-types';
import { PaymentBubble } from './PaymentBubble';
```

**Add payment bubble rendering** at the top of the component's return, before the existing role-based rendering logic. Find where the component checks `message.role` and add:

```tsx
if (isPaymentBubble(message)) {
  return <PaymentBubble message={message} />;
}
```

This should be the first check, before the `role === 'user'` / `role === 'assistant'` branches.

#### Acceptance Criteria
- [ ] Payment bubbles render with mint accent left border
- [ ] Styled consistently with the chat interface (same fonts, colors, spacing)
- [ ] ChatBubble correctly delegates to PaymentBubble for system payment messages
- [ ] Regular chat messages unaffected
- [ ] Works in both light and dark themes

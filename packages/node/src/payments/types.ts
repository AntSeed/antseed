import type { PeerId } from '../types/peer.js';
import type { UsageReceipt } from '../types/metering.js';

export type PaymentMethod = 'crypto';

export type ChainId = 'base-local' | 'base-sepolia' | 'base-mainnet';

export interface WalletInfo {
  /** EVM address (0x-prefixed hex) */
  address: string;
  /** Base network */
  chainId: ChainId;
  /** ETH balance (formatted string, e.g. "0.05") — needed for gas on Base */
  balanceETH: string;
  /** USDC balance (formatted string, 6 decimals, e.g. "10.50") */
  balanceUSDC: string;
}

export type TransactionType =
  | 'deposit_lock'
  | 'deposit_release'
  | 'deposit_refund'
  | 'dispute_resolution';

export interface Transaction {
  txId: string;
  type: TransactionType;
  amountUSD: number;
  from: string;
  to: string;
  timestamp: number;
  chainId?: ChainId;
  txHash?: string;
  status: 'pending' | 'confirmed' | 'failed';
}

export interface PaymentConfig {
  crypto?: CryptoPaymentConfig;
}

export interface CryptoPaymentConfig {
  /** Base network */
  chainId: ChainId;
  /** Base JSON-RPC URL (e.g. http://127.0.0.1:8545 for anvil) */
  rpcUrl: string;
  /** Deployed AntseedDeposits contract address */
  depositsContractAddress: string;
  /** Deployed AntseedSessions contract address */
  sessionsContractAddress: string;
  /** USDC token contract address */
  usdcAddress: string;
  /** Default lock amount for new sessions (USDC base units as string, e.g. "1000000" = 1 USDC) */
  defaultLockAmountUSDC?: string;
}

export interface SettlementResult {
  sessionId: string;
  receipts: UsageReceipt[];
  totalTokens: number;
  totalCostUSD: number;
  platformFeeUSD: number;
  sellerPayoutUSD: number;
  channelId?: string;
  paymentTxHash?: string;
}

export type DisputeStatus = 'open' | 'resolved' | 'expired';

export interface PaymentDispute {
  disputeId: string;
  channelId: string;
  sessionId: string;
  initiatorPeerId: PeerId;
  reason: string;
  status: DisputeStatus;
  buyerReceipts: UsageReceipt[];
  sellerReceipts: UsageReceipt[];
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}

import { useEffect } from 'react';
import { useAccount } from 'wagmi';
import type { BalanceData, PaymentConfig } from '../types';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';
import { useWithdraw } from '../hooks/useWithdraw';
import { usePaymentNetwork } from '../payment-network';
import { formatUsd, truncateAddress } from '../utils/format';
import { ConnectWalletAction } from './ConnectWalletAction';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

interface PayCheckoutWithdrawProps {
  config: PaymentConfig | null;
  balance: BalanceData | null;
  amount: string;
  onWithdrawn: (txHash: string | null) => void;
}

/**
 * Checkout-style withdraw: sends AntseedDeposits.withdraw() from the
 * connected wallet, which must be the account's authorized operator — the
 * USDC is paid out to that wallet.
 */
export function PayCheckoutWithdraw({ config, balance, amount, onWithdrawn }: PayCheckoutWithdrawProps) {
  const { address, isConnected } = useAccount();
  const walletConnected = isConnected && Boolean(address);
  const { requireAuthorization, operator } = useAuthorizedWallet();
  const { targetChainName, wrongChain, isSwitchingChain } = usePaymentNetwork(config);

  const { run, running, success, error, reset, txHash } = useWithdraw(config);

  useEffect(() => {
    if (success) onWithdrawn(txHash ?? null);
  }, [success, txHash, onWithdrawn]);

  const availableAmount = balance ? parseFloat(balance.available) : 0;
  const buyer = config?.evmAddress ?? balance?.evmAddress ?? null;

  const operatorSet = !!operator && operator !== ZERO_ADDR;
  const wrongWallet = Boolean(
    walletConnected && operatorSet && address && address.toLowerCase() !== operator!.toLowerCase(),
  );

  const amountNum = amount ? parseFloat(amount) : 0;
  const isValidAmount = Number.isFinite(amountNum) && amountNum > 0 && amountNum <= availableAmount;
  const validationError = amount !== '' && Number.isFinite(amountNum) && amountNum > availableAmount
    ? `Only $${formatUsd(availableAmount)} USDC is available to withdraw.`
    : null;

  if (!walletConnected) {
    return (
      <div className="pc-pay">
        <ConnectWalletAction className="pc-pay-button" label="Connect wallet to withdraw" />
        <p className="pc-pay-fineprint">
          Connect your authorized wallet — the USDC is sent to it directly.
        </p>
      </div>
    );
  }

  const buttonLabel = (() => {
    if (isSwitchingChain) return `Switching to ${targetChainName}…`;
    if (wrongChain) return `Switch to ${targetChainName}`;
    if (running) return 'Confirm in your wallet…';
    return `Withdraw $${isValidAmount ? formatUsd(amountNum) : '0.00'} USDC`;
  })();

  return (
    <div className="pc-pay">
      <div className="pc-pay-wallet">
        <span className="pc-pay-wallet-label">Sending to</span>
        <code className="pc-pay-wallet-addr">{truncateAddress(address ?? '')}</code>
        <span className="pc-pay-wallet-balance">
          {balance ? `$${formatUsd(availableAmount)} available` : '…'}
        </span>
      </div>

      {wrongWallet && operator && (
        <div className="pc-pay-error" role="alert">
          This account is authorized to <strong>{truncateAddress(operator)}</strong>. Connect that
          wallet to withdraw, or transfer authorization to the connected wallet first.
        </div>
      )}
      {(error || validationError) && (
        <div className="pc-pay-error" role="alert">{error ?? validationError}</div>
      )}

      <button
        type="button"
        className="pc-pay-button"
        onClick={() => {
          if (!buyer) return;
          requireAuthorization(async () => {
            reset();
            await run(buyer, amount);
          });
        }}
        disabled={running || isSwitchingChain || wrongWallet || !buyer || !config || (!wrongChain && !isValidAmount)}
      >
        {running && <span className="pc-pay-spinner" aria-hidden="true" />}
        {buttonLabel}
      </button>

      <p className="pc-pay-fineprint">
        You&apos;ll confirm one transaction in your wallet. The USDC arrives in the connected wallet.
      </p>
    </div>
  );
}

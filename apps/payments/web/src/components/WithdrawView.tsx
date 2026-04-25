import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import type { BalanceData, PaymentConfig } from '../types';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';
import { useWithdraw } from '../hooks/useWithdraw';
import { usePaymentNetwork } from '../payment-network';
import './WithdrawView.scss';

interface WithdrawViewProps {
  config: PaymentConfig | null;
  balance: BalanceData | null;
  onAction: () => void;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function WithdrawView({ config, balance, onAction }: WithdrawViewProps) {
  const [amount, setAmount] = useState('');
  const { address, isConnected } = useAccount();
  const { requireAuthorization, operator } = useAuthorizedWallet();
  const { targetChainName, walletChainId, wrongChain, isSwitchingChain } = usePaymentNetwork(config);

  const { run, running, success, error, reset, txHash } = useWithdraw(config, () => {
    onAction();
  });

  if (!balance) {
    return (
      <div className="card">
        <div className="card-section-title">Withdraw</div>
        <div className="withdraw-loading">Loading...</div>
      </div>
    );
  }

  const availableAmount = parseFloat(balance.available);
  const buyer = config?.evmAddress ?? balance.evmAddress;

  const operatorSet = !!operator && operator !== ZERO_ADDR;
  const wrongWallet = Boolean(
    isConnected && operatorSet && address && address.toLowerCase() !== operator!.toLowerCase(),
  );

  const amountNum = amount ? parseFloat(amount) : 0;
  const validAmount = Number.isFinite(amountNum) && amountNum > 0 && amountNum <= availableAmount;

  function handleClick() {
    if (!buyer) return;
    requireAuthorization(async () => {
      reset();
      await run(buyer, amount);
    });
  }

  function resetForm() {
    setAmount('');
    reset();
  }

  return (
    <div className="withdraw">
      <div className="card">
        <div className="card-section-title">Withdraw USDC</div>
        <div className="wallet-role-hint">
          Withdrawals are sent to your authorized wallet. You'll be prompted to
          authorize one if you haven't already.
        </div>

        {success ? (
          <div className="deposit-success">
            <div className="deposit-success-icon">&#10003;</div>
            <div className="deposit-success-title">Withdrawal confirmed!</div>
            {txHash && <div className="deposit-success-hash">{txHash.slice(0, 18)}...</div>}
            <div className="deposit-success-note">
              Funds were sent to {address ? shortAddr(address) : 'your authorized wallet'}.
            </div>
            <button className="btn-outline" onClick={resetForm} style={{ marginTop: 12 }}>
              Withdraw more
            </button>
          </div>
        ) : !isConnected ? (
          <div className="deposit-connect-wrapper">
            <ConnectButton.Custom>
              {({ openConnectModal, mounted }) => (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={openConnectModal}
                  disabled={!mounted}
                >
                  Connect Wallet
                </button>
              )}
            </ConnectButton.Custom>
          </div>
        ) : (
          <>
            <div className="deposit-connected">
              <div className="deposit-connected-dot" />
              <span className="deposit-connected-addr">{address ? shortAddr(address) : ''}</span>
              <span className="deposit-connected-label">Connected</span>
            </div>

            {wrongChain && (
              <div className="status-msg" style={{ marginTop: 0, marginBottom: 16 }}>
                Wallet is on chain {walletChainId ?? 'unknown'}. Switch to {targetChainName} before withdrawing.
              </div>
            )}

            {wrongWallet && operator && (
              <div className="status-msg status-error" role="alert" style={{ marginBottom: 16 }}>
                This account is authorized to <strong>{shortAddr(operator)}</strong>. Connect that wallet
                to withdraw, or transfer authorization to the connected wallet first.
              </div>
            )}

            <div className="withdraw-request">
              <div className="input-group">
                <label className="input-label">Amount (USDC)</label>
                <input
                  className="input-field"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={running}
                />
                <span className="hint">Available: ${availableAmount.toFixed(2)} USDC</span>
              </div>

              <button
                className="btn-primary"
                onClick={handleClick}
                disabled={
                  running ||
                  isSwitchingChain ||
                  !validAmount ||
                  !buyer ||
                  wrongWallet ||
                  !config
                }
              >
                {isSwitchingChain ? `Switching to ${targetChainName}...` :
                 wrongChain ? `Switch to ${targetChainName}` :
                 running ? 'Processing...' :
                 'Withdraw'}
              </button>
            </div>
          </>
        )}

        {error && (
          <div className="status-msg status-error">{error}</div>
        )}
      </div>
    </div>
  );
}

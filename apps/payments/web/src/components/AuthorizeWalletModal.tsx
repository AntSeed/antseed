import { useEffect } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ActionModal } from '../layout/ActionModal';
import { useSetOperator } from '../hooks/useSetOperator';
import type { PaymentConfig } from '../types';

interface AuthorizeWalletModalProps {
  isOpen: boolean;
  config: PaymentConfig | null;
  hasPendingAction: boolean;
  onClose: () => void;
  onAuthorized: () => void;
}

export function AuthorizeWalletModal({
  isOpen,
  config,
  hasPendingAction,
  onClose,
  onAuthorized,
}: AuthorizeWalletModalProps) {
  const { address, isConnected } = useAccount();
  const { run, running, success, error, reset } = useSetOperator(config);

  useEffect(() => {
    if (success) {
      onAuthorized();
      reset();
    }
  }, [success, onAuthorized, reset]);

  useEffect(() => {
    if (!isOpen) reset();
  }, [isOpen, reset]);

  return (
    <ActionModal
      isOpen={isOpen}
      onClose={onClose}
      title="Authorize your wallet"
      subtitle="Required to withdraw USDC, claim ANTS, and close channels."
    >
      <div className="authorize-wallet-modal">
        <div className="authorize-wallet-warn">
          <div className="authorize-wallet-warn-title">
            Why you need an authorized wallet
          </div>
          <p>
            Your AntSeed signer lives on this node and authorizes spending, but it
            never holds USDC or ANTS. To <strong>withdraw funds</strong>,{' '}
            <strong>claim ANTS rewards</strong>, or <strong>close a channel</strong>,
            you need to designate an external wallet that the contracts will trust.
          </p>
          <p>
            Without an authorized wallet, if you lose access to this node (deleted{' '}
            <code>.antseed</code> directory, lost machine, etc.) your funds are{' '}
            <strong>unrecoverable</strong>. Set this now to keep your funds safe.
          </p>
        </div>

        {!isConnected ? (
          <div className="authorize-wallet-connect">
            <div className="authorize-wallet-step-label">Step 1 — Connect a wallet</div>
            <ConnectButton.Custom>
              {({ openConnectModal, mounted }) => (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={openConnectModal}
                  disabled={!mounted}
                >
                  Connect wallet
                </button>
              )}
            </ConnectButton.Custom>
          </div>
        ) : (
          <div className="authorize-wallet-connect">
            <div className="authorize-wallet-step-label">Connected wallet</div>
            <div className="authorize-wallet-addr">{address}</div>
          </div>
        )}

        <div className="authorize-wallet-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void run()}
            disabled={!isConnected || running || !config}
          >
            {running ? 'Authorizing…' : 'Authorize this wallet'}
          </button>
          <button
            type="button"
            className="btn-link"
            onClick={onClose}
            disabled={running}
          >
            {hasPendingAction ? 'Cancel' : 'Later'}
          </button>
        </div>

        {error && <div className="status-msg status-error">{error}</div>}
      </div>
    </ActionModal>
  );
}

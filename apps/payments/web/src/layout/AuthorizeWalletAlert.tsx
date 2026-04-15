import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';

export function AuthorizeWalletAlert() {
  const { operatorSet, bannerDismissed, dismissBanner, requireAuthorization } = useAuthorizedWallet();

  if (operatorSet !== false || bannerDismissed) return null;

  return (
    <div className="authorize-wallet-alert" role="status">
      <div className="authorize-wallet-alert-icon" aria-hidden="true">!</div>
      <div className="authorize-wallet-alert-body">
        <div className="authorize-wallet-alert-title">Your funds are not recoverable yet</div>
        <div className="authorize-wallet-alert-desc">
          Authorize an external wallet so you can withdraw USDC, claim ANTS, and close
          channels. Without one, losing this node means losing your funds.
        </div>
      </div>
      <div className="authorize-wallet-alert-actions">
        <button
          type="button"
          className="btn-primary authorize-wallet-alert-btn"
          onClick={() => requireAuthorization()}
        >
          Authorize now
        </button>
      </div>
    </div>
  );
}

import type { ViewModelProps } from '../types';

type WalletViewProps = {
  vm: ViewModelProps['vm'];
};

export function WalletView({ vm }: WalletViewProps) {
  return (
    <section id="view-wallet" className={vm.viewClass(vm.shellState.activeView === 'wallet')} role="tabpanel" data-mode="seeder">
      <div className="page-header">
        <h2>Wallet</h2>
        <div id="walletMeta" className={vm.toneClass(vm.walletMetaTone)}>{vm.walletMetaLabel}</div>
      </div>
      <p id="walletMessage" className="message">{vm.walletMessage}</p>
      <div className="wallet-mode-toggle">
        <button id="walletModeNode" className={vm.walletMode === 'node' ? 'toggle-btn active' : 'toggle-btn'} data-mode="node" onClick={() => vm.setWalletModeState('node')}>Node Wallet</button>
        <button id="walletModeExternal" className={vm.walletMode === 'external' ? 'toggle-btn active' : 'toggle-btn'} data-mode="external" onClick={() => { vm.setWalletModeState('external'); void vm.refreshWcState(); }}>External Wallet</button>
      </div>
      <div id="walletNodeSection" style={{ display: vm.walletMode === 'node' ? '' : 'none' }}>
        <div className="wallet-card">
          <div className="wallet-address-row">
            <div className="wallet-address-label">Wallet Address</div>
            <div className="wallet-address-display">
              <span id="walletAddress" className="mono">{vm.walletAddress || 'Not configured'}</span>
              <button id="walletCopyBtn" className="btn-icon" title="Copy address" onClick={() => {
                if (!vm.walletAddress) return;
                void navigator.clipboard.writeText(vm.walletAddress);
              }}>Copy</button>
            </div>
            <div id="walletChain" className="wallet-chain">{vm.safeString(vm.walletInfo?.chainId, 'base-sepolia')}</div>
          </div>
        </div>
      </div>
      <div id="walletExternalSection" style={{ display: vm.walletMode === 'external' ? '' : 'none' }}>
        <div className="wallet-card">
          <div className="wallet-address-row">
            <div className="wallet-address-label">WalletConnect</div>
            <div id="wcStatus" className="wc-status">
              <span id="wcStatusText">
                {vm.wcState.connected ? 'Connected' : (vm.wcState.pairingUri ? 'Waiting for approval...' : 'Not connected')}
              </span>
            </div>
            <div id="wcAddressRow" className="wallet-address-display" style={{ display: vm.wcState.connected && vm.wcState.address ? '' : 'none' }}>
              <span id="wcAddress" className="mono">{vm.wcState.address ?? '-'}</span>
              <button id="wcCopyBtn" className="btn-icon" title="Copy address" onClick={() => {
                if (!vm.wcState.address) return;
                void navigator.clipboard.writeText(vm.wcState.address);
              }}>Copy</button>
            </div>
            <div className="wc-actions">
              <button id="wcConnectBtn" style={{ display: !vm.wcState.connected ? '' : 'none' }} onClick={() => void vm.handleWcConnect()}>Connect Wallet</button>
              <button id="wcDisconnectBtn" className="danger" style={{ display: vm.wcState.connected ? '' : 'none' }} onClick={() => void vm.handleWcDisconnect()}>Disconnect</button>
            </div>
            <div id="wcQrContainer" className="wc-qr-container" style={{ display: vm.wcState.pairingUri && !vm.wcState.connected ? '' : 'none' }}>
              <canvas id="wcQrCanvas" width={260} height={260} />
              <p className="wc-qr-hint">Scan with your mobile wallet</p>
              <p className="wc-qr-hint mono">{vm.wcState.pairingUri ?? ''}</p>
            </div>
          </div>
        </div>
      </div>
      <div className="stat-grid">
        <div className="stat-card"><p className="stat-label">ETH Balance</p><p id="walletETH" className="stat-value">{vm.safeString(vm.walletInfo?.balanceETH, '0.00')} ETH</p></div>
        <div className="stat-card"><p className="stat-label">USDC Balance</p><p id="walletUSDC" className="stat-value green">{vm.safeString(vm.walletInfo?.balanceUSDC, '0.00')} USDC</p></div>
        <div className="stat-card"><p className="stat-label">Network</p><p id="walletNetwork" className="stat-value">Base</p></div>
      </div>
      <div className="panel-grid two-col">
        <article className="panel">
          <div className="panel-head"><h3>Escrow Balance</h3></div>
          <div className="escrow-grid">
            <div className="escrow-item">
              <span className="escrow-label">Deposited</span>
              <span id="escrowDeposited" className="escrow-value green">{vm.formatMoney(vm.walletEscrow.deposited)}</span>
            </div>
            <div className="escrow-item">
              <span className="escrow-label">Committed</span>
              <span id="escrowCommitted" className="escrow-value">{vm.formatMoney(vm.walletEscrow.committed)}</span>
            </div>
            <div className="escrow-item">
              <span className="escrow-label">Available</span>
              <span id="escrowAvailable" className="escrow-value">{vm.formatMoney(vm.walletEscrow.available)}</span>
            </div>
          </div>
        </article>
        <article className="panel">
          <div className="panel-head"><h3>Deposit / Withdraw</h3></div>
          <div className="wallet-actions">
            <div className="wallet-action-row">
              <input id="walletAmount" type="number" className="form-input" placeholder="Amount (USDC)" step="0.01" min={0} value={vm.walletAmount} onChange={(event) => vm.setWalletAmount(event.target.value)} />
            </div>
            <div className="wallet-action-row">
              <button id="walletDepositBtn" onClick={() => void vm.handleWalletDeposit()}>Deposit</button>
              <button id="walletWithdrawBtn" className="secondary" onClick={() => void vm.handleWalletWithdraw()}>Withdraw</button>
            </div>
            <p id="walletActionMessage" className={`message settings-message ${vm.walletActionTone}`}>{vm.walletActionMessage}</p>
          </div>
        </article>
      </div>
    </section>
  );
}

export function initWalletModule({
  bridge,
  elements,
  uiState,
  getDashboardPort,
  setText,
  setBadgeTone,
  safeString,
  formatMoney,
  getWalletActionResult,
}) {
  async function refreshWalletInfo() {
    if (!bridge || !bridge.walletGetInfo) return;

    try {
      const result = await bridge.walletGetInfo(getDashboardPort());
      if (result.ok && result.data) {
        uiState.walletInfo = result.data;
        renderWalletView(result.data);
      } else {
        setText(elements.walletMessage, result.error || 'Unable to load wallet info');
        setBadgeTone(elements.walletMeta, 'warn', 'Error');
      }
    } catch {
      setText(elements.walletMessage, 'Wallet bridge unavailable');
    }
  }

  function renderWalletView(info) {
    if (!info) return;

    const addr = info.address;
    if (addr) {
      setText(elements.walletAddress, addr);
      setBadgeTone(elements.walletMeta, 'active', `${addr.slice(0, 6)}...${addr.slice(-4)}`);
    } else {
      setText(elements.walletAddress, 'Not configured');
      setBadgeTone(elements.walletMeta, 'idle', 'Not connected');
    }

    setText(elements.walletChain, safeString(info.chainId, 'base-sepolia'));
    setText(elements.walletETH, `${safeString(info.balanceETH, '0.00')} ETH`);
    setText(elements.walletUSDC, `${safeString(info.balanceUSDC, '0.00')} USDC`);
    setText(elements.walletNetwork, 'Base');
    setText(elements.escrowDeposited, formatMoney(info.escrow?.deposited));
    setText(elements.escrowCommitted, formatMoney(info.escrow?.committed));
    setText(elements.escrowAvailable, formatMoney(info.escrow?.available));
    setText(
      elements.walletMessage,
      addr
        ? 'Wallet derived from node identity.'
        : 'Configure wallet address in Settings or start seeding to auto-generate.'
    );
  }

  function showWalletAction(text, type) {
    if (!elements.walletActionMessage) return;
    elements.walletActionMessage.textContent = text;
    elements.walletActionMessage.className = `message settings-message ${type}`;
    setTimeout(() => {
      if (elements.walletActionMessage.textContent === text) {
        elements.walletActionMessage.textContent = '';
        elements.walletActionMessage.className = 'message';
      }
    }, 8000);
  }

  function setWalletMode(mode) {
    uiState.walletMode = mode;
    if (elements.walletModeNode) elements.walletModeNode.classList.toggle('active', mode === 'node');
    if (elements.walletModeExternal) elements.walletModeExternal.classList.toggle('active', mode === 'external');
    if (elements.walletNodeSection) elements.walletNodeSection.style.display = mode === 'node' ? '' : 'none';
    if (elements.walletExternalSection) elements.walletExternalSection.style.display = mode === 'external' ? '' : 'none';
  }

  function renderWcState(state) {
    uiState.wcState = state || uiState.wcState;
    const s = uiState.wcState;

    if (s.connected && s.address) {
      setText(elements.wcStatusText, 'Connected');
      if (elements.wcAddressRow) elements.wcAddressRow.style.display = '';
      setText(elements.wcAddress, s.address);
      if (elements.wcConnectBtn) elements.wcConnectBtn.style.display = 'none';
      if (elements.wcDisconnectBtn) elements.wcDisconnectBtn.style.display = '';
      if (elements.wcQrContainer) elements.wcQrContainer.style.display = 'none';
    } else if (s.pairingUri) {
      setText(elements.wcStatusText, 'Waiting for approval...');
      if (elements.wcAddressRow) elements.wcAddressRow.style.display = 'none';
      if (elements.wcConnectBtn) elements.wcConnectBtn.style.display = 'none';
      if (elements.wcDisconnectBtn) elements.wcDisconnectBtn.style.display = 'none';
      if (elements.wcQrContainer) elements.wcQrContainer.style.display = '';
      drawQrCode(s.pairingUri);
    } else {
      setText(elements.wcStatusText, 'Not connected');
      if (elements.wcAddressRow) elements.wcAddressRow.style.display = 'none';
      if (elements.wcConnectBtn) elements.wcConnectBtn.style.display = '';
      if (elements.wcDisconnectBtn) elements.wcDisconnectBtn.style.display = 'none';
      if (elements.wcQrContainer) elements.wcQrContainer.style.display = 'none';
    }
  }

  async function refreshWcState() {
    if (!bridge || !bridge.walletConnectState) return;
    try {
      const result = await bridge.walletConnectState();
      if (result.ok) {
        renderWcState(result.data);
      }
    } catch {
      // WalletConnect unavailable
    }
  }

  async function connectWalletConnect() {
    if (!bridge || !bridge.walletConnectConnect) return;
    if (elements.wcConnectBtn) elements.wcConnectBtn.disabled = true;

    try {
      const result = await bridge.walletConnectConnect();
      if (!result.ok) {
        showWalletAction(result.error || 'Failed to start WalletConnect', 'error');
      }
    } catch {
      showWalletAction('WalletConnect connection failed', 'error');
    } finally {
      if (elements.wcConnectBtn) elements.wcConnectBtn.disabled = false;
    }
  }

  async function disconnectWalletConnect() {
    if (!bridge || !bridge.walletConnectDisconnect) return;
    try {
      await bridge.walletConnectDisconnect();
      renderWcState({ connected: false, address: null, chainId: null, pairingUri: null });
    } catch {
      showWalletAction('Disconnect failed', 'error');
    }
  }

  function drawQrCode(text) {
    const canvas = elements.wcQrCanvas;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const size = 260;
    canvas.width = size;
    canvas.height = size;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    const moduleCount = 33;
    const cellSize = Math.floor(size / moduleCount);
    const offset = Math.floor((size - cellSize * moduleCount) / 2);

    ctx.fillStyle = '#000000';

    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }

    const drawFinder = (x, y) => {
      for (let dy = 0; dy < 7; dy += 1) {
        for (let dx = 0; dx < 7; dx += 1) {
          const isOuter = dy === 0 || dy === 6 || dx === 0 || dx === 6;
          const isInner = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
          if (isOuter || isInner) {
            ctx.fillRect(offset + (x + dx) * cellSize, offset + (y + dy) * cellSize, cellSize, cellSize);
          }
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(moduleCount - 7, 0);
    drawFinder(0, moduleCount - 7);

    let seed = Math.abs(hash);
    for (let y = 0; y < moduleCount; y += 1) {
      for (let x = 0; x < moduleCount; x += 1) {
        if ((x < 8 && y < 8) || (x >= moduleCount - 8 && y < 8) || (x < 8 && y >= moduleCount - 8)) {
          continue;
        }
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        if (seed % 3 === 0) {
          ctx.fillRect(offset + x * cellSize, offset + y * cellSize, cellSize, cellSize);
        }
      }
    }

    ctx.fillStyle = '#666666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Copy the URI and paste in your wallet', size / 2, size - 4);
  }

  if (elements.walletDepositBtn && bridge) {
    elements.walletDepositBtn.addEventListener('click', async () => {
      const amount = elements.walletAmount?.value;
      if (!amount || Number(amount) <= 0) {
        showWalletAction('Enter a valid amount', 'error');
        return;
      }
      elements.walletDepositBtn.disabled = true;
      try {
        const result = await bridge.walletDeposit(amount);
        const action = getWalletActionResult(result, 'Deposit initiated', 'Deposit failed');
        showWalletAction(action.message, action.type);
      } catch {
        showWalletAction('Deposit failed', 'error');
      } finally {
        elements.walletDepositBtn.disabled = false;
      }
    });
  }

  if (elements.walletWithdrawBtn && bridge) {
    elements.walletWithdrawBtn.addEventListener('click', async () => {
      const amount = elements.walletAmount?.value;
      if (!amount || Number(amount) <= 0) {
        showWalletAction('Enter a valid amount', 'error');
        return;
      }
      elements.walletWithdrawBtn.disabled = true;
      try {
        const result = await bridge.walletWithdraw(amount);
        const action = getWalletActionResult(result, 'Withdrawal initiated', 'Withdrawal failed');
        showWalletAction(action.message, action.type);
      } catch {
        showWalletAction('Withdrawal failed', 'error');
      } finally {
        elements.walletWithdrawBtn.disabled = false;
      }
    });
  }

  if (elements.walletCopyBtn) {
    elements.walletCopyBtn.addEventListener('click', () => {
      const addr = elements.walletAddress?.textContent;
      if (addr && addr !== 'Not configured') {
        navigator.clipboard.writeText(addr).then(() => {
          elements.walletCopyBtn.textContent = 'Copied!';
          setTimeout(() => {
            elements.walletCopyBtn.textContent = 'Copy';
          }, 1500);
        });
      }
    });
  }

  if (elements.walletModeNode) {
    elements.walletModeNode.addEventListener('click', () => setWalletMode('node'));
  }

  if (elements.walletModeExternal) {
    elements.walletModeExternal.addEventListener('click', () => {
      setWalletMode('external');
      refreshWcState();
    });
  }

  if (elements.wcConnectBtn) {
    elements.wcConnectBtn.addEventListener('click', connectWalletConnect);
  }

  if (elements.wcDisconnectBtn) {
    elements.wcDisconnectBtn.addEventListener('click', disconnectWalletConnect);
  }

  if (elements.wcCopyBtn) {
    elements.wcCopyBtn.addEventListener('click', () => {
      const addr = elements.wcAddress?.textContent;
      if (addr && addr !== '-') {
        navigator.clipboard.writeText(addr).then(() => {
          elements.wcCopyBtn.textContent = 'Copied!';
          setTimeout(() => {
            elements.wcCopyBtn.textContent = 'Copy';
          }, 1500);
        });
      }
    });
  }

  if (bridge && bridge.onWalletConnectStateChanged) {
    bridge.onWalletConnectStateChanged((state) => {
      renderWcState(state);
    });
  }

  return {
    refreshWalletInfo,
    refreshWcState,
  };
}

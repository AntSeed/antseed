import { EventEmitter } from 'node:events';
import { writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface WalletConnectState {
  connected: boolean;
  address: string | null;
  chainId: number | null;
  pairingUri: string | null;
}

const SESSION_PATH = path.join(homedir(), '.antseed', 'walletconnect-session.json');

const BASE_CHAIN_ID = 8453;
const BASE_RPC = 'https://mainnet.base.org';

/**
 * Manages WalletConnect pairing, session persistence, and signer creation.
 *
 * The WalletConnect provider runs in the main Electron process. The renderer
 * communicates via IPC to initiate pairing (receiving a URI for QR display),
 * disconnect, and query state.
 */
export class WalletConnectManager extends EventEmitter {
  private _provider: InstanceType<typeof import('@walletconnect/ethereum-provider').default> | null = null;
  private _state: WalletConnectState = {
    connected: false,
    address: null,
    chainId: null,
    pairingUri: null,
  };

  get state(): WalletConnectState {
    return { ...this._state };
  }

  /**
   * Initialize the WalletConnect provider.
   * Attempts to restore a previous session from disk.
   */
  async init(projectId: string): Promise<void> {
    if (!projectId || projectId.length === 0) {
      console.log('[WalletConnect] No project ID configured, WalletConnect disabled');
      return;
    }

    try {
      const EthereumProvider = (await import('@walletconnect/ethereum-provider')).default;

      this._provider = await EthereumProvider.init({
        projectId,
        chains: [BASE_CHAIN_ID],
        showQrModal: false,
        metadata: {
          name: 'AntSeed Desktop',
          description: 'Decentralized AI inference marketplace',
          url: 'https://antseed.ai',
          icons: [],
        },
        rpcMap: {
          [BASE_CHAIN_ID]: BASE_RPC,
        },
      });

      // Listen for session events
      this._provider.on('connect', () => {
        this._onConnect();
      });

      this._provider.on('disconnect', () => {
        this._onDisconnect();
      });

      this._provider.on('chainChanged', (chainId: string | number) => {
        this._state.chainId = Number(chainId);
        this.emit('state', this.state);
      });

      this._provider.on('accountsChanged', (accounts: string[]) => {
        this._state.address = accounts[0] ?? null;
        this.emit('state', this.state);
      });

      // Try restoring session
      if (this._provider.session) {
        this._onConnect();
        console.log('[WalletConnect] Restored previous session');
      }
    } catch (err) {
      console.error('[WalletConnect] Init failed:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Start a new pairing. Returns the URI for QR code display.
   */
  async connect(): Promise<string | null> {
    if (!this._provider) {
      return null;
    }

    this._state.pairingUri = null;

    // Listen for the display_uri event to capture the pairing URI
    const uriPromise = new Promise<string>((resolve) => {
      this._provider!.on('display_uri', (uri: string) => {
        this._state.pairingUri = uri;
        this.emit('state', this.state);
        resolve(uri);
      });
    });

    // Start connection (don't await - it resolves when user approves on wallet)
    const connectPromise = this._provider.connect();

    // Wait for the URI to be available
    const uri = await uriPromise;

    // Handle connection completion in the background
    connectPromise
      .then(() => this._onConnect())
      .catch((err: unknown) => {
        console.error('[WalletConnect] Connect failed:', err instanceof Error ? err.message : String(err));
        this._state.pairingUri = null;
        this.emit('state', this.state);
      });

    return uri;
  }

  /**
   * Disconnect the current session.
   */
  async disconnect(): Promise<void> {
    if (!this._provider) {
      return;
    }

    try {
      await this._provider.disconnect();
    } catch {
      // Already disconnected
    }

    this._onDisconnect();
    await this._clearSession();
  }

  /**
   * Get an ethers Signer from the connected WalletConnect provider.
   * Returns null if not connected.
   */
  async getSigner(): Promise<unknown> {
    if (!this._provider || !this._state.connected) {
      return null;
    }

    try {
      const { BrowserProvider } = await import('ethers');
      const provider = new BrowserProvider(this._provider);
      return provider.getSigner();
    } catch (err) {
      console.error('[WalletConnect] getSigner failed:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private _onConnect(): void {
    if (!this._provider) return;

    const accounts = this._provider.accounts ?? [];
    this._state = {
      connected: true,
      address: accounts[0] ?? null,
      chainId: this._provider.chainId ?? null,
      pairingUri: null,
    };

    this.emit('state', this.state);
    void this._saveSession();
    console.log(`[WalletConnect] Connected: ${this._state.address}`);
  }

  private _onDisconnect(): void {
    this._state = {
      connected: false,
      address: null,
      chainId: null,
      pairingUri: null,
    };
    this.emit('state', this.state);
    console.log('[WalletConnect] Disconnected');
  }

  private async _saveSession(): Promise<void> {
    try {
      await writeFile(SESSION_PATH, JSON.stringify({ timestamp: Date.now() }), 'utf-8');
    } catch {
      // Non-critical
    }
  }

  private async _clearSession(): Promise<void> {
    try {
      await unlink(SESSION_PATH);
    } catch {
      // Already gone
    }
  }
}

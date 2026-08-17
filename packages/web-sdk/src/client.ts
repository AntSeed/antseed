/**
 * High-level browser buyer built on the SHARED buyer machinery from
 * @antseed/buyer-core — the same BuyerRequestHandler / BuyerPaymentManager /
 * BuyerPaymentNegotiator stack the node buyer proxy runs, wired to a WebRTC
 * transport and an injectable channel store (in-memory by default).
 */

import {
  BuyerPaymentManager,
  BuyerPaymentNegotiator,
  BuyerRequestHandler,
  ChannelsClient,
  DepositsClient,
  ProxyMux,
  VerificationMux,
  type BuyerConnection,
  type BuyerIdentity,
  type BuyerPeerView,
  type BuyerSigner,
  type PaymentMux,
} from '@antseed/buyer-core';
import type { BuyerChannelStore } from '@antseed/buyer-core/channel-store-types';
import {
  MessageType,
  toPeerId,
  type PeerId,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
} from '@antseed/protocol';
import { SellerConnection, type ConnectionOptions, type RtcEnvironment } from './connection.js';
import { MemoryChannelStore } from './channel-store.js';
import { signerFromPrivateKey } from './identity.js';

export interface SellerSummary {
  peerId: string;
  displayName?: string;
  publicAddress?: string;
  providers: unknown[];
  sellerContract?: string;
  [key: string]: unknown;
}

export interface WebPaymentConfig {
  chainId: number;
  channelsContractAddress: string;
  depositsContractAddress: string;
  usdcAddress: string;
  /** RPC endpoint for read-only deposit/channel checks. Empty disables them. */
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  maxPerRequestUsdc?: bigint;
  maxReserveAmountUsdc?: bigint;
  defaultAuthDurationSecs?: number;
  costToleranceMultiplier?: number;
}

export interface ClientOptions {
  /** Relay base URL, e.g. https://relay.antseed.com */
  relayUrl: string;
  /**
   * Buyer hot-wallet key, or any ethers AbstractSigner exposing its address
   * as a property (Wallet, JsonRpcSigner, custom non-extractable-key
   * signers). The peerId is its EVM address. Note: the payment stack signs a
   * SpendingAuth per request, so signers that prompt per signature (browser
   * extension wallets) are impractical for chat-style traffic.
   */
  privateKey?: string;
  wallet?: BuyerSigner;
  /**
   * Channel bookkeeping store. Defaults to a fresh in-memory store: channel
   * state is lost on reload and reserved funds stay locked until the session
   * deadline. Production apps should inject a durable implementation whose
   * `flush()` commits before resolving (e.g. IndexedDB behind a synchronous
   * cache) — it is awaited after each signed authorization is persisted and
   * before it is transmitted. When several tabs may share one store, the
   * implementation must also serialize signing (e.g. Web Locks): SpendingAuth
   * amounts are cumulative per channel, and two tabs signing concurrently
   * corrupt the sequence.
   */
  channelStore?: BuyerChannelStore;
  /** Defaults to Base mainnet (chain 8453). */
  payment?: Partial<WebPaymentConfig>;
  connection?: ConnectionOptions;
  requestTimeoutMs?: number;
  /** Override RTCPeerConnection/WebSocket (browser globals by default). */
  env?: Partial<RtcEnvironment>;
  /** Override the on-chain read clients (tests, custom RPC stacks). */
  depositsClient?: DepositsClient | null;
  channelsClient?: ChannelsClient | null;
}

export interface RequestInput {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** Selects the provider on the seller (x-antseed-provider). */
  provider?: string;
}

export interface StreamCallbacks {
  onChunk?: (data: Uint8Array, done: boolean) => void;
}

// Base mainnet defaults (see packages/node/src/payments/chain-config.ts).
const BASE_MAINNET: WebPaymentConfig = {
  chainId: 8453,
  channelsContractAddress: '0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d',
  depositsContractAddress: '0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2',
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  rpcUrl: 'https://base.publicnode.com',
};

// Stay under the ~256 KiB SCTP message ceiling browsers negotiate with
// libdatachannel sellers; the shared mux default (512 KiB) assumes node peers.
const BROWSER_UPLOAD_THRESHOLD_BYTES = 192 * 1024;

interface SessionWiring {
  conn: SellerConnection;
  proxyMux: ProxyMux;
  verificationMux: VerificationMux;
}

export class AntseedWebClient {
  private readonly identity: BuyerIdentity;
  private readonly env: RtcEnvironment;
  private readonly payment: WebPaymentConfig;
  private readonly store: BuyerChannelStore;
  private readonly handler: BuyerRequestHandler;
  readonly negotiator: BuyerPaymentNegotiator;
  private readonly sessions = new Map<string, SessionWiring>();

  constructor(private readonly options: ClientOptions) {
    const wallet = options.wallet ?? (options.privateKey ? signerFromPrivateKey(options.privateKey) : null);
    if (!wallet) throw new Error('provide privateKey or wallet');
    this.identity = { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), wallet };
    this.store = options.channelStore ?? new MemoryChannelStore();

    const globalRtc = (globalThis as Record<string, unknown>).RTCPeerConnection as
      | typeof RTCPeerConnection
      | undefined;
    const globalWs = (globalThis as Record<string, unknown>).WebSocket as
      | RtcEnvironment['WebSocket']
      | undefined;
    const RTCPeerConnectionImpl = options.env?.RTCPeerConnection ?? globalRtc;
    const WebSocketImpl = options.env?.WebSocket ?? globalWs;
    if (!RTCPeerConnectionImpl || !WebSocketImpl) {
      throw new Error('RTCPeerConnection/WebSocket unavailable — pass them via options.env');
    }
    this.env = { RTCPeerConnection: RTCPeerConnectionImpl, WebSocket: WebSocketImpl };
    this.payment = { ...BASE_MAINNET, ...options.payment };

    const bpm = new BuyerPaymentManager(
      this.identity,
      {
        rpcUrl: this.payment.rpcUrl,
        ...(this.payment.fallbackRpcUrls ? { fallbackRpcUrls: this.payment.fallbackRpcUrls } : {}),
        depositsContractAddress: this.payment.depositsContractAddress,
        channelsContractAddress: this.payment.channelsContractAddress,
        usdcAddress: this.payment.usdcAddress,
        identityRegistryAddress: '0x0000000000000000000000000000000000000000',
        chainId: this.payment.chainId,
        defaultAuthDurationSecs: this.payment.defaultAuthDurationSecs ?? 900,
        maxPerRequestUsdc: this.payment.maxPerRequestUsdc ?? 500_000n,
        maxReserveAmountUsdc: this.payment.maxReserveAmountUsdc ?? 1_000_000n,
        ...(this.payment.costToleranceMultiplier !== undefined
          ? { costToleranceMultiplier: this.payment.costToleranceMultiplier }
          : {}),
        dataDir: '',
      },
      this.store,
    );

    const depositsClient = options.depositsClient !== undefined
      ? options.depositsClient
      : this.payment.rpcUrl
      ? new DepositsClient({
          rpcUrl: this.payment.rpcUrl,
          ...(this.payment.fallbackRpcUrls ? { fallbackRpcUrls: this.payment.fallbackRpcUrls } : {}),
          contractAddress: this.payment.depositsContractAddress,
          usdcAddress: this.payment.usdcAddress,
          evmChainId: this.payment.chainId,
        })
      : null;
    const channelsClient = options.channelsClient !== undefined
      ? options.channelsClient
      : this.payment.rpcUrl
      ? new ChannelsClient({
          rpcUrl: this.payment.rpcUrl,
          ...(this.payment.fallbackRpcUrls ? { fallbackRpcUrls: this.payment.fallbackRpcUrls } : {}),
          contractAddress: this.payment.channelsContractAddress,
          evmChainId: this.payment.chainId,
        })
      : null;

    this.negotiator = new BuyerPaymentNegotiator(
      this.identity,
      bpm,
      depositsClient,
      channelsClient,
      this.store,
      {},
      { emit: () => true },
    );

    this.handler = new BuyerRequestHandler(
      { ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}) },
      {
        localPeerId: this.identity.peerId,
        negotiator: this.negotiator,
        verificationStorage: null,
        verificationSampler: null,
        getConnection: (peer) => this.requireSession(peer.peerId).then((s) => s.conn),
        getMux: (peerId) => this.sessions.get(peerId)!.proxyMux,
        getVerificationMux: (peerId) => this.sessions.get(peerId)!.verificationMux,
        registerPaymentMux: () => {},
      },
    );
  }

  get peerId(): PeerId {
    return this.identity.peerId;
  }

  async sellers(): Promise<SellerSummary[]> {
    const res = await fetch(`${this.options.relayUrl.replace(/\/$/, '')}/sellers`);
    if (!res.ok) throw new Error(`relay /sellers failed: ${res.status}`);
    const body = (await res.json()) as { peers: SellerSummary[]; static: { peerId: string; host: string; port: number }[] };
    const byId = new Map<string, SellerSummary>();
    for (const entry of body.static) {
      byId.set(entry.peerId, { peerId: entry.peerId, providers: [], publicAddress: `${entry.host}:${entry.port}` });
    }
    for (const peer of body.peers) byId.set(peer.peerId, peer);
    return [...byId.values()];
  }

  /** Connect to a seller. `peer` extras (pricing, metadata) improve cost validation. */
  async connect(sellerPeerId: string, peer: Partial<BuyerPeerView> = {}): Promise<SellerSession> {
    const peerId = toPeerId(sellerPeerId.toLowerCase());
    const peerView: BuyerPeerView = { ...peer, peerId };
    await this.requireSession(peerId);
    return new SellerSession(this, peerView);
  }

  /** @internal */
  async requireSession(peerId: PeerId): Promise<SessionWiring> {
    const existing = this.sessions.get(peerId);
    if (existing) {
      if (existing.conn.isOpen) return existing;
      // Close a lingering (e.g. mid-connect) session before overwriting it.
      existing.conn.close();
    }

    const bridgeUrl = `${this.options.relayUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/bridge/${peerId}`;
    const conn = await SellerConnection.connect(bridgeUrl, this.identity.wallet, this.env, this.options.connection);
    const proxyMux = new ProxyMux(conn, { uploadThresholdBytes: BROWSER_UPLOAD_THRESHOLD_BYTES });
    const verificationMux = new VerificationMux(conn);
    const paymentMux: PaymentMux = this.negotiator.getOrCreatePaymentMux(peerId, conn as BuyerConnection);

    conn.onFrame = (frame) => {
      if (frame.type >= 0x50 && frame.type <= 0x5f) {
        void paymentMux.handleFrame(frame);
      } else if (frame.type >= 0x80 && frame.type <= 0x8f) {
        void verificationMux.handleFrame(frame);
      } else if (frame.type !== MessageType.Ping && frame.type !== MessageType.Pong) {
        void proxyMux.handleFrame(frame);
      }
    };
    conn.onClose = () => this.sessions.delete(peerId);

    const wiring: SessionWiring = { conn, proxyMux, verificationMux };
    this.sessions.set(peerId, wiring);
    return wiring;
  }

  /** @internal */
  sendRequest(
    peer: BuyerPeerView,
    req: SerializedHttpRequest,
    callbacks?: { onChunk?: (data: Uint8Array, done: boolean) => void },
  ): Promise<SerializedHttpResponse> {
    const streamCallbacks = callbacks?.onChunk
      ? {
          onResponseChunk: (chunk: { data: Uint8Array; done: boolean }) =>
            callbacks.onChunk!(chunk.data, chunk.done),
        }
      : undefined;
    return this.handler.sendRequest(peer, req, streamCallbacks);
  }

  disconnect(sellerPeerId: string): void {
    const peerId = toPeerId(sellerPeerId.toLowerCase());
    const session = this.sessions.get(peerId);
    session?.conn.close();
    this.sessions.delete(peerId);
  }

  closeAll(): void {
    for (const [, session] of this.sessions) session.conn.close();
    this.sessions.clear();
  }
}

export class SellerSession {
  constructor(
    private readonly client: AntseedWebClient,
    readonly peer: BuyerPeerView,
  ) {}

  /**
   * Send one request through the shared buyer stack: 402 negotiation,
   * NeedAuth signing, retries, and streaming all behave exactly like the
   * node buyer proxy.
   */
  async request(input: RequestInput, callbacks: StreamCallbacks = {}): Promise<SerializedHttpResponse> {
    const req: SerializedHttpRequest = {
      requestId: crypto.randomUUID(),
      method: input.method ?? 'POST',
      path: input.path,
      headers: {
        ...(input.provider ? { 'x-antseed-provider': input.provider } : {}),
        ...input.headers,
      },
      body: typeof input.body === 'string' ? new TextEncoder().encode(input.body) : input.body ?? new Uint8Array(0),
    };
    return this.client.sendRequest(this.peer, req, callbacks);
  }

  close(): void {
    this.client.disconnect(this.peer.peerId);
  }
}

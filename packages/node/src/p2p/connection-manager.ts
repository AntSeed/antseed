import { EventEmitter } from "node:events";
import net, { type Socket } from "node:net";
import type {
  PeerConnection as NativeRtcPeerConnection,
  DataChannel as NativeDataChannel,
  DescriptionType as NativeDescriptionType,
} from "node-datachannel";
import { type PeerId } from "../types/peer.js";
import { ConnectionState, type ConnectionConfig } from "../types/connection.js";
import { type IceConfig, getDefaultIceConfig } from "./ice-config.js";
import type { Wallet } from "ethers";
import {
  type ConnectionAuthEnvelope,
  NonceReplayGuard,
  buildConnectionAuthEnvelope,
  verifyConnectionAuthEnvelope,
} from "./connection-auth.js";

let _nodeDatachannel: typeof import("node-datachannel") | null = null;

async function loadNodeDatachannel(): Promise<typeof import("node-datachannel")> {
  if (_nodeDatachannel) return _nodeDatachannel;
  _nodeDatachannel = await import("node-datachannel");
  return _nodeDatachannel;
}

function getNodeDatachannel(): typeof import("node-datachannel") {
  if (!_nodeDatachannel) throw new Error("node-datachannel not loaded");
  return _nodeDatachannel;
}

export interface PeerEndpoint {
  host: string;
  port: number;
}

type TransportMode = "webrtc" | "tcp";
type InitialWireMessage =
  | {
      type: "intro";
      auth: ConnectionAuthEnvelope;
    }
  | {
      type: "hello";
      auth: ConnectionAuthEnvelope;
    };

type SignalingMessage =
  | {
      type: "sdp";
      sdp: string;
      descriptionType: NativeDescriptionType;
    }
  | {
      type: "candidate";
      candidate: string;
      mid: string;
    };

const DATA_CHANNEL_LABEL = "antseed-data";
const LINE_SEPARATOR = "\n";
const INITIAL_LINE_TIMEOUT_MS = 10_000;
const MAX_INITIAL_LINE_BYTES = 8 * 1024;
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 10_000;

/** Represents a single P2P connection. */
export class PeerConnection extends EventEmitter {
  readonly remotePeerId: PeerId;
  readonly isInitiator: boolean;
  private _state: ConnectionState = ConnectionState.Connecting;
  private _timeoutMs: number;
  private _timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private _rtc: NativeRtcPeerConnection | null = null;
  private _dataChannel: NativeDataChannel | null = null;
  private _rawSocket: Socket | null = null;
  private _signalingSocket: Socket | null = null;

  constructor(config: ConnectionConfig) {
    super();
    this.remotePeerId = config.remotePeerId;
    this.isInitiator = config.isInitiator;
    this._timeoutMs = config.timeoutMs ?? 30_000;
  }

  get state(): ConnectionState {
    return this._state;
  }

  attachRtcPeer(rtc: NativeRtcPeerConnection): void {
    this._rtc = rtc;
  }

  attachSignalingSocket(socket: Socket): void {
    this._signalingSocket = socket;
  }

  attachDataChannel(channel: NativeDataChannel): void {
    this._dataChannel = channel;

    channel.onOpen(() => {
      this.clearTimeout();
      if (this._state === ConnectionState.Connecting) {
        this.setState(ConnectionState.Open);
      }
    });

    channel.onClosed(() => {
      if (this._state !== ConnectionState.Closed && this._state !== ConnectionState.Failed) {
        this.setState(ConnectionState.Closed);
      }
    });

    channel.onError((err: string) => {
      this.fail(new Error(`DataChannel error: ${err}`));
    });

    channel.onMessage((msg: string | Buffer) => {
      if (typeof msg === "string") {
        this.emit("message", new TextEncoder().encode(msg));
      } else {
        this.emit("message", new Uint8Array(msg));
      }
    });
  }

  attachRawSocket(socket: Socket, initialData?: Uint8Array): void {
    this._rawSocket = socket;
    socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);

    socket.on("data", (chunk: Buffer) => {
      this.emit("message", new Uint8Array(chunk));
    });

    socket.on("error", (err: Error) => {
      this.fail(err);
    });

    socket.on("close", () => {
      if (this._state !== ConnectionState.Closed && this._state !== ConnectionState.Failed) {
        this.setState(ConnectionState.Closed);
      }
    });

    this.clearTimeout();
    if (this._state === ConnectionState.Connecting) {
      this.setState(ConnectionState.Open);
    }

    if (initialData && initialData.length > 0) {
      queueMicrotask(() => {
        this.emit("message", initialData);
      });
    }
  }

  fail(err: Error): void {
    if (this._state !== ConnectionState.Failed && this._state !== ConnectionState.Closed) {
      this.setState(ConnectionState.Failed);
    }
    this._teardownTransports();
    this._emitError(err);
  }

  /** Transition to a new state and emit event. */
  setState(newState: ConnectionState): void {
    if (this._state === newState) return;
    this._state = newState;
    this.emit("stateChange", newState);
  }

  /** Start the connection timeout. */
  startTimeout(): void {
    this._timeoutHandle = setTimeout(() => {
      if (this._state === ConnectionState.Connecting) {
        this.fail(new Error(`Connection to ${this.remotePeerId} timed out`));
      }
    }, this._timeoutMs);
  }

  /** Clear the connection timeout. */
  clearTimeout(): void {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  /** Send a message through the active transport. */
  send(data: Uint8Array): void {
    if (this._state !== ConnectionState.Open && this._state !== ConnectionState.Authenticated) {
      throw new Error(`Cannot send in state ${this._state}`);
    }

    if (this._dataChannel && this._dataChannel.isOpen()) {
      const ok = this._dataChannel.sendMessageBinary(data);
      if (!ok) {
        const err = new Error(`Failed to send data to ${this.remotePeerId}`);
        this.fail(err);
        throw err;
      }
      return;
    }

    if (!this._rawSocket || this._rawSocket.destroyed || !this._rawSocket.writable) {
      // Transport is unexpectedly unavailable while state is Open — eagerly fail the
      // connection so it is evicted from the pool and the next request gets a fresh
      // connection instead of also hitting this error.
      const err = new Error(`Cannot send to ${this.remotePeerId}: no writable transport`);
      this.fail(err);
      throw err;
    }

    this._rawSocket.write(Buffer.from(data));
  }

  /** Close the connection gracefully. */
  close(): void {
    if (this._state === ConnectionState.Closed) {
      return;
    }

    this.clearTimeout();
    this.setState(ConnectionState.Closing);
    this._teardownTransports();
    this.setState(ConnectionState.Closed);
    this.removeAllListeners();
  }

  private _teardownTransports(): void {
    if (this._dataChannel) {
      try {
        this._dataChannel.close();
      } catch {
        // best effort close
      }
      this._dataChannel = null;
    }

    if (this._rtc) {
      try {
        this._rtc.close();
      } catch {
        // best effort close
      }
      this._rtc = null;
    }

    if (this._rawSocket && !this._rawSocket.destroyed) {
      this._rawSocket.destroy();
    }
    this._rawSocket = null;

    if (this._signalingSocket && !this._signalingSocket.destroyed) {
      this._signalingSocket.destroy();
    }
    this._signalingSocket = null;
  }

  private _emitError(err: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }
}

/** Manages all peer connections and optional inbound listening. */
export class ConnectionManager extends EventEmitter {
  private _connections = new Map<PeerId, PeerConnection>();
  private _iceConfig: IceConfig;
  private _localPeerId: PeerId | null = null;
  private _localWallet: Wallet | null = null;
  private _listenHost = "127.0.0.1";
  private _listenPort: number | null = null;
  private _server: net.Server | null = null;
  private _transportMode: TransportMode;
  private _metadataProvider: (() => object | null) | null = null;
  private _ipConnectionCounts = new Map<string, number>();
  private readonly _introReplayGuard = new NonceReplayGuard();
  private static _knownEndpoints = new Map<PeerId, PeerEndpoint>();
  private static _detectedTransportMode: TransportMode | null = null;

  constructor(iceConfig?: IceConfig) {
    super();
    this._iceConfig = iceConfig ?? getDefaultIceConfig();
    this._transportMode = ConnectionManager._detectTransportMode();
  }

  static async init(iceConfig?: IceConfig): Promise<ConnectionManager> {
    try {
      await loadNodeDatachannel();
    } catch {
      // node-datachannel not available — TCP fallback will be used
    }
    return new ConnectionManager(iceConfig);
  }

  get iceConfig(): IceConfig {
    return this._iceConfig;
  }

  get connections(): ReadonlyMap<PeerId, PeerConnection> {
    return this._connections;
  }

  getListeningPort(): number | null {
    return this._listenPort;
  }

  setMetadataProvider(provider: () => object | null): void {
    this._metadataProvider = provider;
  }

  setLocalPeerId(peerId: PeerId): void {
    this._localPeerId = peerId;
  }

  setLocalIdentity(identity: { peerId: PeerId; wallet: Wallet }): void {
    this._localPeerId = identity.peerId;
    this._localWallet = identity.wallet;
  }

  static registerPeerEndpoint(peerId: PeerId, endpoint: PeerEndpoint): void {
    this._knownEndpoints.set(peerId, endpoint);
  }

  static resolvePeerEndpoint(peerId: PeerId): PeerEndpoint | undefined {
    return this._knownEndpoints.get(peerId);
  }

  registerPeerEndpoint(peerId: PeerId, endpoint: PeerEndpoint): void {
    ConnectionManager.registerPeerEndpoint(peerId, endpoint);
  }

  async startListening(config: { peerId: PeerId; port: number; host?: string }): Promise<void> {
    this._localPeerId = config.peerId;
    this._listenHost = config.host ?? "127.0.0.1";
    this._listenPort = config.port;

    if (this._server) {
      return;
    }

    this._server = net.createServer((socket) => {
      const ip = socket.remoteAddress ?? 'unknown';
      const current = this._ipConnectionCounts.get(ip) ?? 0;
      if (current >= 10) {
        socket.destroy();
        return;
      }
      this._ipConnectionCounts.set(ip, current + 1);
      // Keepalive set here for all inbound sockets (WebRTC signaling + TCP).
      // TCP ("intro") sockets will have it re-applied in attachRawSocket — harmless.
      socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
      socket.once('close', () => {
        const count = this._ipConnectionCounts.get(ip) ?? 1;
        if (count <= 1) {
          this._ipConnectionCounts.delete(ip);
        } else {
          this._ipConnectionCounts.set(ip, count - 1);
        }
      });
      this._handleInboundSocket(socket);
    });

    this._server.maxConnections = 256;

    await new Promise<void>((resolve, reject) => {
      this._server!.once("error", reject);
      this._server!.listen(this._listenPort!, this._listenHost, () => resolve());
    });

    // Resolve actual bound port (important when port 0 is used for OS-assigned)
    const addr = this._server.address();
    if (addr && typeof addr !== 'string') {
      this._listenPort = addr.port;
    }

    ConnectionManager.registerPeerEndpoint(config.peerId, {
      host: this._listenHost,
      port: this._listenPort,
    });
  }

  async stopListening(): Promise<void> {
    if (!this._server) {
      return;
    }

    const server = this._server;
    this._server = null;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    if (this._localPeerId) {
      ConnectionManager._knownEndpoints.delete(this._localPeerId);
    }
  }

  /** Create a new outbound connection. */
  createConnection(config: ConnectionConfig): PeerConnection {
    const existing = this._connections.get(config.remotePeerId);
    if (existing && existing.state !== ConnectionState.Closed && existing.state !== ConnectionState.Failed) {
      throw new Error(`Connection to ${config.remotePeerId} already exists`);
    }

    const conn = new PeerConnection(config);
    this._registerConnection(config.remotePeerId, conn);
    conn.startTimeout();

    if (!this._localPeerId) {
      queueMicrotask(() => {
        conn.fail(new Error("Local peer id is not configured"));
      });
      return conn;
    }
    if (!this._localWallet) {
      queueMicrotask(() => {
        conn.fail(new Error("Local wallet is not configured"));
      });
      return conn;
    }

    const endpoint = config.endpoint ?? ConnectionManager.resolvePeerEndpoint(config.remotePeerId);
    if (!endpoint) {
      queueMicrotask(() => {
        conn.fail(new Error(`No endpoint registered for peer ${config.remotePeerId}`));
      });
      return conn;
    }

    ConnectionManager.registerPeerEndpoint(config.remotePeerId, endpoint);

    if (this._transportMode === "webrtc") {
      this._createWebRtcConnection(config, conn, endpoint);
    } else {
      this._createTcpConnection(config, conn, endpoint);
    }

    return conn;
  }

  /** Get an existing connection by peer ID. */
  getConnection(peerId: PeerId): PeerConnection | undefined {
    return this._connections.get(peerId);
  }

  /** Close a specific connection. */
  closeConnection(peerId: PeerId): void {
    const conn = this._connections.get(peerId);
    if (conn) {
      conn.close();
    }
  }

  /** Close all connections and clean up. */
  closeAll(): void {
    for (const conn of this._connections.values()) {
      conn.close();
    }
    this._connections.clear();
    if (this._server) {
      void this.stopListening();
    }
  }

  private _createWebRtcConnection(
    config: ConnectionConfig,
    conn: PeerConnection,
    endpoint: PeerEndpoint,
  ): void {
    const signalingSocket = net.connect({ host: endpoint.host, port: endpoint.port });
    signalingSocket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
    conn.attachSignalingSocket(signalingSocket);

    let rtc: NativeRtcPeerConnection | null = null;
    const pendingSignals: SignalingMessage[] = [];

    this._attachSignalingParser(
      signalingSocket,
      (msg) => {
        if (!rtc) {
          pendingSignals.push(msg);
          return;
        }
        this._applySignalToRtc(rtc, msg, conn);
      },
      (err) => conn.fail(err),
      "",
    );

    signalingSocket.once("connect", () => {
      this._sendLine(signalingSocket, {
        type: "hello",
        auth: buildConnectionAuthEnvelope(
          "hello",
          this._localPeerId!,
          this._localWallet!,
        ),
      });

      rtc = this._createRtcPeer(config.remotePeerId);
      conn.attachRtcPeer(rtc);
      this._wireRtcPeer(conn, rtc, signalingSocket, true);

      for (const signal of pendingSignals) {
        this._applySignalToRtc(rtc, signal, conn);
      }
      pendingSignals.length = 0;
    });

    signalingSocket.on("error", (err: Error) => {
      if (conn.state === ConnectionState.Connecting) {
        conn.fail(err);
      }
    });

    signalingSocket.on("close", () => {
      if (conn.state === ConnectionState.Connecting) {
        conn.fail(new Error(`Signaling socket closed before connection to ${config.remotePeerId} opened`));
      }
    });
  }

  private _createTcpConnection(
    config: ConnectionConfig,
    conn: PeerConnection,
    endpoint: PeerEndpoint,
  ): void {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port });

    socket.once("connect", () => {
      this._sendLine(socket, {
        type: "intro",
        auth: buildConnectionAuthEnvelope(
          "intro",
          this._localPeerId!,
          this._localWallet!,
        ),
      });
      conn.attachRawSocket(socket);
    });

    socket.on("error", (err: Error) => {
      if (conn.state === ConnectionState.Connecting) {
        conn.fail(err);
      }
    });

    socket.on("close", () => {
      if (conn.state === ConnectionState.Connecting) {
        conn.fail(new Error(`TCP socket closed before connection to ${config.remotePeerId} opened`));
      }
    });
  }

  private _handleInboundSocket(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      socket.destroy();
    }, INITIAL_LINE_TIMEOUT_MS);

    const onData = (chunk: Buffer): void => {
      if (buffer.length + chunk.length > MAX_INITIAL_LINE_BYTES) {
        socket.off("data", onData);
        clearTimeout(timeout);
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const lineBreak = buffer.indexOf(0x0a); // '\n'
      if (lineBreak < 0) {
        return;
      }

      socket.off("data", onData);
      clearTimeout(timeout);

      const line = buffer.subarray(0, lineBreak).toString("utf8").trim();
      const remaining = buffer.subarray(lineBreak + 1);

      // Detect HTTP requests (metadata endpoint served on signaling port)
      if (line.startsWith("GET ") || line.startsWith("HEAD ")) {
        this._serveHttpMetadata(socket, line);
        return;
      }

      let intro: InitialWireMessage;
      try {
        intro = JSON.parse(line) as InitialWireMessage;
      } catch {
        socket.destroy();
        return;
      }
      if (intro.type !== "intro" && intro.type !== "hello") {
        socket.destroy();
        return;
      }

      const verified = verifyConnectionAuthEnvelope({
        type: intro.type,
        auth: intro.auth,
        replayGuard: this._introReplayGuard,
      });
      if (!verified.ok || !verified.peerId) {
        socket.destroy();
        return;
      }

      if (intro.type === "intro") {
        this._acceptTcpInbound(socket, verified.peerId, remaining);
        return;
      }

      if (intro.type === "hello") {
        this._acceptWebRtcInbound(socket, verified.peerId, remaining.toString("utf8"));
        return;
      }

      socket.destroy();
    };

    socket.on("data", onData);
    socket.on("error", (err: Error) => {
      clearTimeout(timeout);
      // ECONNRESET / EPIPE are expected when scanners or bots drop the
      // connection before sending the intro — suppress to avoid log noise.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED") {
        return;
      }
      this._emitError(err);
    });
    socket.on("close", () => {
      clearTimeout(timeout);
    });
  }

  private _serveHttpMetadata(socket: Socket, requestLine: string): void {
    const MAX_HEADER_SIZE = 8 * 1024; // 8KB
    let headerBytes = 0;
    const headerTimeout = setTimeout(() => {
      socket.destroy();
    }, 5_000);

    const onData = (chunk: Buffer): void => {
      headerBytes += chunk.length;
      if (headerBytes > MAX_HEADER_SIZE) {
        clearTimeout(headerTimeout);
        socket.off("data", onData);
        socket.destroy();
        return;
      }
      if (chunk.includes(Buffer.from("\r\n\r\n")) || chunk.includes(Buffer.from("\n\n"))) {
        clearTimeout(headerTimeout);
        socket.off("data", onData);
      }
    };
    socket.on("data", onData);

    const url = requestLine.split(" ")[1] ?? "";
    let statusLine: string;
    let body: string;

    if (url !== "/metadata") {
      statusLine = "404 Not Found";
      body = JSON.stringify({ error: "not found" });
    } else if (!this._metadataProvider) {
      statusLine = "503 Service Unavailable";
      body = JSON.stringify({ error: "metadata not available" });
    } else {
      const metadata = this._metadataProvider();
      if (!metadata) {
        statusLine = "503 Service Unavailable";
        body = JSON.stringify({ error: "metadata not available" });
      } else {
        statusLine = "200 OK";
        body = JSON.stringify(metadata);
      }
    }

    socket.end(
      `HTTP/1.1 ${statusLine}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      body,
    );
  }

  private _acceptTcpInbound(socket: Socket, remotePeerId: PeerId, remainingData: Buffer): void {
    const existing = this._connections.get(remotePeerId);
    if (existing && existing.state !== ConnectionState.Closed && existing.state !== ConnectionState.Failed) {
      // Replace stale/ghost connections from the same peer instead of rejecting
      // fresh reconnect attempts, which can leave buyers stuck on dead links.
      existing.close();
    }

    const conn = new PeerConnection({
      remotePeerId,
      isInitiator: false,
    });
    this._registerConnection(remotePeerId, conn);
    conn.attachRawSocket(
      socket,
      remainingData.length > 0 ? new Uint8Array(remainingData) : undefined,
    );
    this.emit("connection", conn);
  }

  private _acceptWebRtcInbound(socket: Socket, remotePeerId: PeerId, initialSignalingBuffer: string): void {
    const existing = this._connections.get(remotePeerId);
    if (existing && existing.state !== ConnectionState.Closed && existing.state !== ConnectionState.Failed) {
      // Replace stale/ghost connections from the same peer instead of rejecting
      // fresh reconnect attempts, which can leave buyers stuck on dead links.
      existing.close();
    }

    const conn = new PeerConnection({
      remotePeerId,
      isInitiator: false,
    });
    conn.attachSignalingSocket(socket);
    this._registerConnection(remotePeerId, conn);

    const rtc = this._createRtcPeer(remotePeerId);
    conn.attachRtcPeer(rtc);
    this._wireRtcPeer(conn, rtc, socket, false);

    this._attachSignalingParser(
      socket,
      (msg) => {
        this._applySignalToRtc(rtc, msg, conn);
      },
      (err) => conn.fail(err),
      initialSignalingBuffer,
    );

    socket.on("close", () => {
      if (conn.state === ConnectionState.Connecting) {
        conn.fail(new Error(`Inbound signaling from ${remotePeerId} closed before connection opened`));
      }
    });

    socket.on("error", (err: Error) => {
      conn.fail(err);
    });

    this.emit("connection", conn);
  }

  private _wireRtcPeer(
    conn: PeerConnection,
    rtc: NativeRtcPeerConnection,
    signalingSocket: Socket,
    isInitiator: boolean,
  ): void {
    rtc.onLocalDescription((sdp: string, descriptionType: string) => {
      this._sendLine(signalingSocket, {
        type: "sdp",
        sdp,
        descriptionType: this._normalizeDescriptionType(descriptionType),
      });
    });

    rtc.onLocalCandidate((candidate: string, mid: string) => {
      this._sendLine(signalingSocket, {
        type: "candidate",
        candidate,
        mid,
      });
    });

    rtc.onStateChange((state: string) => {
      const lower = state.toLowerCase();
      if (lower === "failed" || lower === "disconnected" || lower === "closed") {
        if (conn.state === ConnectionState.Connecting || conn.state === ConnectionState.Open) {
          conn.fail(new Error(`WebRTC state is ${state}`));
        } else if (conn.state === ConnectionState.Authenticated) {
          conn.close();
        }
      }
    });

    if (isInitiator) {
      const channel = rtc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
      conn.attachDataChannel(channel);
      rtc.setLocalDescription();
    } else {
      rtc.onDataChannel((channel: NativeDataChannel) => {
        conn.attachDataChannel(channel);
      });
    }
  }

  private _createRtcPeer(remotePeerId: PeerId): NativeRtcPeerConnection {
    const ndc = getNodeDatachannel();
    const iceServers = this._iceConfig.iceServers.flatMap((server) => {
      return Array.isArray(server.urls) ? server.urls : [server.urls];
    });

    return new ndc.PeerConnection(`idleai-${remotePeerId.slice(0, 12)}`, {
      iceServers,
      iceTransportPolicy: this._iceConfig.iceTransportPolicy ?? "all",
    });
  }

  private _applySignalToRtc(
    rtc: NativeRtcPeerConnection,
    signal: SignalingMessage,
    conn: PeerConnection,
  ): void {
    try {
      if (signal.type === "sdp") {
        rtc.setRemoteDescription(signal.sdp, signal.descriptionType);
      } else {
        rtc.addRemoteCandidate(signal.candidate, signal.mid);
      }
    } catch (err) {
      conn.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private _attachSignalingParser(
    socket: Socket,
    onMessage: (msg: SignalingMessage) => void,
    onError: (err: Error) => void,
    initialBuffer: string,
  ): void {
    const MAX_BUFFER_SIZE = 64 * 1024; // 64KB
    let buffer = initialBuffer;

    const processBuffer = (): void => {
      while (true) {
        const lineBreak = buffer.indexOf(LINE_SEPARATOR);
        if (lineBreak < 0) {
          break;
        }

        const line = buffer.slice(0, lineBreak).trim();
        buffer = buffer.slice(lineBreak + LINE_SEPARATOR.length);
        if (line.length === 0) {
          continue;
        }

        try {
          const parsed = JSON.parse(line) as SignalingMessage;
          onMessage(parsed);
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
    };

    if (buffer.length > 0) {
      processBuffer();
    }

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_BUFFER_SIZE) {
        socket.destroy(new Error("Signaling buffer exceeded 64KB limit"));
        return;
      }
      processBuffer();
    });
  }

  private _sendLine(socket: Socket, payload: object): void {
    if (socket.destroyed) {
      throw new Error("Cannot send message on destroyed socket");
    }
    socket.write(JSON.stringify(payload) + LINE_SEPARATOR);
  }

  private _registerConnection(peerId: PeerId, conn: PeerConnection): void {
    this._connections.set(peerId, conn);

    conn.on("stateChange", (state: ConnectionState) => {
      this.emit("connectionStateChange", peerId, state);
      if (state === ConnectionState.Closed || state === ConnectionState.Failed) {
        // Only delete if this exact instance is still the active mapping.
        // A newer replacement connection may already exist for the same peer.
        if (this._connections.get(peerId) === conn) {
          this._connections.delete(peerId);
        }
      }
    });

    conn.on("error", (err: Error) => {
      this._emitError(err);
    });
  }

  private static _detectTransportMode(): TransportMode {
    if (this._detectedTransportMode) {
      return this._detectedTransportMode;
    }

    try {
      const ndc = _nodeDatachannel;
      if (!ndc) {
        this._detectedTransportMode = "tcp";
        return this._detectedTransportMode;
      }
      const probe = new ndc.PeerConnection("idleai-transport-probe", { iceServers: [] });
      try {
        const channel = probe.createDataChannel("probe", { ordered: true });
        channel.close();
      } finally {
        probe.close();
      }
      this._detectedTransportMode = "webrtc";
    } catch {
      this._detectedTransportMode = "tcp";
    }

    return this._detectedTransportMode;
  }

  private _normalizeDescriptionType(type: string): NativeDescriptionType {
    switch (type) {
      case "offer":
      case "answer":
      case "pranswer":
      case "rollback":
      case "unspec":
        return type as NativeDescriptionType;
      default:
        return "unspec" as NativeDescriptionType;
    }
  }

  private _emitError(err: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }
}

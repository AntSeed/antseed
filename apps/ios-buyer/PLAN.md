# iOS Buyer Node — Implementation Plan

## Overview

A native Swift iOS app that runs an AntSeed buyer node, allowing users to
discover AI service providers on the P2P network and interact with them via a
chat interface. The app reimplements the buyer-side protocol in Swift, using
iOS-native equivalents for all Node.js dependencies.

**Primary use case:** Chat interface — users type prompts and see AI responses.
**Discovery:** Full BEP5 DHT implementation in Swift (no HTTP fallback).
**Payments:** Deferred to v2. MVP is free-tier / no escrow.

---

## Phase 1: Project Scaffold & Identity (Week 1)

### 1.1 Xcode Project Setup

Create `apps/ios-buyer/` with the following structure:

```
apps/ios-buyer/
├── AntSeedBuyer.xcodeproj
├── AntSeedBuyer/
│   ├── App/
│   │   ├── AntSeedBuyerApp.swift          # @main entry point
│   │   ├── AppState.swift                  # Observable app-wide state
│   │   └── Info.plist
│   ├── Core/
│   │   ├── Identity/
│   │   │   ├── Identity.swift              # Ed25519 keypair management
│   │   │   └── KeychainStore.swift         # iOS Keychain persistence
│   │   ├── Protocol/
│   │   │   ├── MessageType.swift           # Protocol message type enum (0x01-0xFF)
│   │   │   ├── FrameCodec.swift            # 9-byte header encode/decode
│   │   │   ├── FrameDecoder.swift          # Streaming frame decoder with partial buffering
│   │   │   ├── HttpCodec.swift             # Request/response binary codec
│   │   │   ├── ChunkCodec.swift            # Chunked upload/download codec
│   │   │   └── MessageMux.swift            # Frame routing (proxy vs payment)
│   │   ├── Discovery/
│   │   │   ├── DHTNode.swift               # BEP5 DHT client
│   │   │   ├── DHTRoutingTable.swift       # K-bucket routing table
│   │   │   ├── DHTMessage.swift            # Bencode KRPC messages
│   │   │   ├── Bencode.swift               # Bencode encoder/decoder
│   │   │   ├── TopicHash.swift             # SHA1 topic → infohash mapping
│   │   │   └── PeerMetadata.swift          # Binary metadata decode + Ed25519 verify
│   │   ├── Connection/
│   │   │   ├── ConnectionManager.swift     # Outbound connection pool
│   │   │   ├── SignalingClient.swift        # TCP signaling for SDP/ICE exchange
│   │   │   ├── WebRTCConnection.swift      # Google WebRTC SDK wrapper
│   │   │   ├── ConnectionAuth.swift        # Auth envelope creation + verification
│   │   │   └── KeepaliveManager.swift      # Ping/pong keepalive
│   │   ├── Proxy/
│   │   │   ├── ProxyMux.swift              # Request/response multiplexing
│   │   │   └── RequestExecutor.swift       # High-level sendRequest / sendRequestStream
│   │   ├── Routing/
│   │   │   ├── Router.swift                # Router protocol
│   │   │   └── DefaultRouter.swift         # Price → reputation → latency scoring
│   │   ├── Metering/
│   │   │   ├── MeteringDB.swift            # SQLite schema + queries
│   │   │   └── TokenCounter.swift          # Approximate token counting
│   │   └── Node/
│   │       ├── BuyerNode.swift             # Top-level node (start/stop/discover/send)
│   │       └── PeerInfo.swift              # Peer model
│   ├── UI/
│   │   ├── Chat/
│   │   │   ├── ChatView.swift              # Main chat interface
│   │   │   ├── ChatViewModel.swift         # Chat logic + streaming
│   │   │   ├── MessageBubble.swift         # Message rendering (markdown)
│   │   │   └── MessageModel.swift          # Chat message data model
│   │   ├── Peers/
│   │   │   ├── PeerBrowserView.swift       # Discover & browse peers
│   │   │   ├── PeerDetailView.swift        # Peer info (services, pricing, latency)
│   │   │   └── PeerRowView.swift           # Peer list row
│   │   ├── Settings/
│   │   │   ├── SettingsView.swift          # Identity, bootstrap nodes, preferences
│   │   │   └── IdentityView.swift          # Show/export peer ID
│   │   └── Components/
│   │       ├── StatusBadge.swift           # Connection status indicator
│   │       └── ServicePicker.swift         # Model/service selection
│   └── Resources/
│       └── Assets.xcassets
├── AntSeedBuyerTests/
│   ├── FrameCodecTests.swift
│   ├── HttpCodecTests.swift
│   ├── BencodeTests.swift
│   ├── DHTMessageTests.swift
│   └── ConnectionAuthTests.swift
└── Packages/                               # (empty, SPM deps resolved by Xcode)
```

**Dependencies (Swift Package Manager):**
- `WebRTC` — Google's WebRTC iOS SDK (`stasel/WebRTC` SPM wrapper or official pod)
- `GRDB.swift` — SQLite wrapper (or use raw C SQLite API)
- No other external dependencies; CryptoKit covers Ed25519 + SHA1

### 1.2 Identity Module

Port the identity system using iOS CryptoKit:

```swift
import CryptoKit

struct AntseedIdentity {
    let privateKey: Curve25519.Signing.PrivateKey
    var publicKey: Curve25519.Signing.PublicKey { privateKey.publicKey }
    var peerId: String { publicKey.rawRepresentation.hexString }  // 64 hex chars

    static func loadOrCreate() -> AntseedIdentity {
        // Check iOS Keychain for existing key
        // If not found, generate new and store in Keychain
    }

    func sign(_ data: Data) -> Data {
        try! privateKey.signature(for: data).rawRepresentation
    }
}
```

**Keychain storage** — Use `SecItemAdd`/`SecItemCopyMatching` with
`kSecAttrService = "com.antseed.identity"`. The raw 32-byte private key is
stored as `kSecClassGenericPassword`.

**Compatibility note:** CryptoKit uses RFC 8032 Ed25519, same as `@noble/ed25519`.
Signatures are interoperable — verify with test vectors from the Node.js side.

### 1.3 Cross-Platform Test Vectors

Generate test vectors from the Node.js codebase (identity signing, frame
encoding, HTTP codec) and include them as JSON fixtures in the Xcode test
target. This ensures byte-level compatibility.

---

## Phase 2: Binary Protocol Layer (Week 2)

### 2.1 Frame Codec

Reimplement `encodeFrame` / `decodeFrame` from
`packages/node/src/p2p/message-protocol.ts`:

```swift
struct FramedMessage {
    let type: MessageType       // UInt8 enum
    let messageId: UInt32
    let payload: Data
}

// 9-byte header: type(1) + messageId(4 BE) + payloadLength(4 BE)
let FRAME_HEADER_SIZE = 9
let MAX_PAYLOAD_SIZE = 64 * 1024 * 1024  // 64 MiB

func encodeFrame(_ msg: FramedMessage) -> Data { ... }
func decodeFrame(_ data: Data) -> (FramedMessage, Int)? { ... }
```

Port `FrameDecoder` (streaming partial-frame buffering):

```swift
class FrameDecoder {
    private var buffer = Data()
    func feed(_ chunk: Data) -> [FramedMessage] { ... }
    func reset() { buffer = Data() }
}
```

### 2.2 HTTP Codec

Port request/response binary encoding from
`packages/node/src/proxy/request-codec.ts`:

```swift
func encodeHttpRequest(_ req: SerializedHttpRequest) -> Data { ... }
func decodeHttpResponse(_ data: Data) -> SerializedHttpResponse { ... }
func decodeHttpResponseChunk(_ data: Data) -> SerializedHttpResponseChunk { ... }
```

Buyer only needs:
- **Encode:** HttpRequest, HttpRequestChunk, HttpRequestEnd
- **Decode:** HttpResponse, HttpResponseChunk, HttpResponseEnd, HttpResponseError

### 2.3 Message Type Enum

```swift
enum MessageType: UInt8 {
    case handshakeInit = 0x01
    case handshakeAck = 0x02
    case ping = 0x10
    case pong = 0x11
    case httpRequest = 0x20
    case httpResponse = 0x21
    case httpResponseChunk = 0x22
    case httpResponseEnd = 0x23
    case httpResponseError = 0x24
    case httpRequestChunk = 0x25
    case httpRequestEnd = 0x26
    case disconnect = 0xF0
    case error = 0xFF
}
```

### 2.4 Unit Tests

Test against cross-platform fixtures:
- Frame encode/decode round-trip
- HTTP request encode matches Node.js output byte-for-byte
- HTTP response decode of Node.js-encoded payloads
- Streaming frame decoder with partial chunks
- Edge cases: empty body, max payload size, multi-frame feed

---

## Phase 3: BEP5 DHT Discovery (Week 3-4)

This is the most complex component. Implement a BEP5
(BitTorrent DHT) client in Swift for peer discovery.

### 3.1 Bencode Encoder/Decoder

BEP5 uses Bencoding for KRPC messages:

```swift
enum BencodeValue {
    case string(Data)           // Length-prefixed byte string
    case integer(Int64)         // i<number>e
    case list([BencodeValue])   // l<values>e
    case dictionary([(Data, BencodeValue)])  // d<key-value pairs>e (sorted keys)
}

func bencode(_ value: BencodeValue) -> Data { ... }
func bdecode(_ data: Data) -> (BencodeValue, Int)? { ... }
```

### 3.2 KRPC Message Protocol

Implement the four BEP5 KRPC message types over UDP:

| Query | Purpose | Buyer needs |
|-------|---------|-------------|
| `ping` | Liveness check | Yes |
| `find_node` | Routing table population | Yes |
| `get_peers` | Find peers for infohash | Yes (core discovery) |
| `announce_peer` | Register as peer | No (sellers only) |

```swift
struct KRPCMessage {
    let transactionId: Data     // "t" field
    let type: String            // "q", "r", or "e"
    let query: String?          // Method name for queries
    let args: [Data: BencodeValue]?
    let response: [Data: BencodeValue]?
}
```

### 3.3 Routing Table (K-Buckets)

- 160-bit node ID space (SHA1 of peer ID)
- 160 k-buckets, k=8 nodes per bucket
- Bucket split on insert when full + own-bucket
- Least-recently-seen eviction with ping check
- Refresh stale buckets periodically (15 min)

```swift
class DHTRoutingTable {
    let ownId: Data  // 20-byte SHA1 node ID
    var buckets: [KBucket]  // 160 buckets

    func addNode(_ node: DHTNode) { ... }
    func findClosest(_ target: Data, count: Int = 8) -> [DHTNode] { ... }
    func removeStale() { ... }
}
```

### 3.4 DHT Client

```swift
class DHTClient {
    private let socket: NWConnection  // UDP via Network.framework
    private let routingTable: DHTRoutingTable
    private let identity: AntseedIdentity

    func bootstrap(nodes: [(String, UInt16)]) async throws { ... }
    func findPeers(topic: String) async throws -> [PeerEndpoint] { ... }

    // Internal
    private func getPeers(infohash: Data, from: DHTNode) async throws -> GetPeersResult { ... }
    private func findNode(target: Data, from: DHTNode) async throws -> [DHTNode] { ... }
    private func iterativeLookup(target: Data) async throws -> [DHTNode] { ... }
}
```

**Topic → Infohash mapping** (must match Node.js):
```swift
func topicToInfoHash(_ topic: String) -> Data {
    // SHA1 of the UTF-8 topic string
    Insecure.SHA1.hash(data: Data(topic.utf8))
}
```

**Bootstrap flow:**
1. Send `find_node` to bootstrap nodes (`dht1.antseed.com:6881`, `dht2.antseed.com:6881`)
2. Populate routing table from responses
3. Iterative lookup for own node ID (populates nearby buckets)
4. Ready for `get_peers` queries

**UDP transport:** Use `Network.framework` (`NWConnection` with `.udp` protocol)
for iOS-friendly UDP. This handles Wi-Fi/cellular transitions gracefully.

### 3.5 Peer Metadata Fetch

After DHT returns `(host, port)` endpoints, fetch metadata:

```
GET http://{host}:{metadataPort}/metadata
```

Decode the binary metadata format (matching Node.js encoding):
- Version (1 byte)
- PeerId (32 bytes)
- Region (length-prefixed string)
- Timestamp (8 bytes, big-endian ms)
- Provider count + provider entries
- Pricing matrix
- Ed25519 signature (64 bytes)

Verify signature over the metadata body using the embedded peerId as public key.
Reject if timestamp is older than 30 minutes (staleness check).

### 3.6 Tests

- Bencode round-trip for all value types
- KRPC message encode/decode
- Topic-to-infohash matches Node.js SHA1 output
- Routing table insertion, bucket splitting, closest-node lookup
- Metadata binary decode against Node.js-encoded fixtures

---

## Phase 4: WebRTC Connection Layer (Week 4-5)

### 4.1 Signaling Client

TCP connection to seller's signaling port, exchanging JSON-line messages:

```swift
class SignalingClient {
    private var connection: NWConnection  // TCP via Network.framework

    func connect(host: String, port: UInt16) async throws { ... }
    func sendHello(auth: ConnectionAuthEnvelope) async throws { ... }
    func sendSDP(_ sdp: String) async throws { ... }
    func sendICECandidate(_ candidate: String) async throws { ... }
    func receiveMessages() -> AsyncStream<SignalingMessage> { ... }
}
```

**Connection auth envelope** (must match Node.js):
```swift
struct ConnectionAuthEnvelope: Codable {
    let peerId: String
    let ts: Int64           // Unix milliseconds
    let nonce: String       // 16-byte random hex
    let sig: String         // Ed25519 sign("hello|{peerId}|{ts}|{nonce}")
}
```

### 4.2 WebRTC Connection

Wrap Google's WebRTC iOS SDK:

```swift
class WebRTCPeerConnection: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    private let peerConnection: RTCPeerConnection
    private var dataChannel: RTCDataChannel?
    private let frameDecoder = FrameDecoder()

    var onFrame: ((FramedMessage) -> Void)?
    var onStateChange: ((ConnectionState) -> Void)?

    func createOffer() async throws -> RTCSessionDescription { ... }
    func setRemoteAnswer(_ sdp: RTCSessionDescription) async throws { ... }
    func addICECandidate(_ candidate: RTCIceCandidate) async throws { ... }
    func send(_ data: Data) { dataChannel?.sendData(RTCDataBuffer(data: data, isBinary: true)) }
    func close() { ... }
}
```

**ICE Configuration:**
```swift
let iceServers = [
    RTCIceServer(urlStrings: ["stun:stun1.l.google.com:19302"]),
    RTCIceServer(urlStrings: ["stun:stun2.l.google.com:19302"]),
]
```

### 4.3 Connection Manager

Manages outbound connection pool (buyer is initiator-only):

```swift
class ConnectionManager {
    private var connections: [String: ManagedConnection] = [:]

    func getOrCreate(peer: PeerInfo) async throws -> ManagedConnection { ... }
    func close(peerId: String) { ... }
    func closeAll() { ... }
}
```

**Outbound connection flow:**
1. Open TCP to seller's signaling endpoint
2. Send "hello" with Ed25519-signed auth envelope
3. Receive seller's "welcome" (verify their signature)
4. Create RTCPeerConnection, generate SDP offer
5. Exchange SDP + ICE candidates via TCP signaling
6. DataChannel opens → connection ready
7. Start keepalive pings (every 10s)
8. Wire FrameDecoder to DataChannel's `onMessage`

### 4.4 Keepalive

```swift
class KeepaliveManager {
    // Send Ping (0x10) every 10s
    // Expect Pong (0x11) within 5s
    // Mark connection dead after 3 missed pongs
}
```

### 4.5 TCP Fallback

If WebRTC fails (e.g., symmetric NAT), fall back to raw TCP:
- Reuse the signaling TCP connection as the data transport
- Send "intro" instead of "hello"
- Same frame protocol over TCP stream

---

## Phase 5: Request Execution & Routing (Week 5-6)

### 5.1 ProxyMux (Buyer Side)

Port the buyer side of `packages/node/src/proxy/proxy-mux.ts`:

```swift
class ProxyMux {
    private var pendingRequests: [String: RequestContext] = [:]

    func sendRequest(_ request: SerializedHttpRequest,
                     onResponse: @escaping (SerializedHttpResponse, Bool) -> Void,
                     onChunk: @escaping (ResponseChunk) -> Void) { ... }

    func handleFrame(_ frame: FramedMessage) { ... }
    func cancelRequest(_ requestId: String) { ... }
}
```

**Upload flow:**
- Body ≤ 512 KiB → single HttpRequest frame
- Body > 512 KiB → HttpRequest (empty body, `x-antseed-upload: chunked` header) +
  HttpRequestChunk frames (8 KiB each) + HttpRequestEnd

**Response flow:**
- Non-streaming: single HttpResponse → resolve
- Streaming (`x-antseed-streaming: 1`): HttpResponse header + HttpResponseChunk* +
  HttpResponseEnd → accumulate and resolve

### 5.2 RequestExecutor

High-level API matching `AntseedNode.sendRequest` / `sendRequestStream`:

```swift
class RequestExecutor {
    func sendRequest(peer: PeerInfo, request: SerializedHttpRequest) async throws -> SerializedHttpResponse
    func sendRequestStream(peer: PeerInfo, request: SerializedHttpRequest) -> AsyncThrowingStream<StreamEvent, Error>
}

enum StreamEvent {
    case responseStart(SerializedHttpResponse, streaming: Bool)
    case chunk(Data)
    case complete(SerializedHttpResponse)
}
```

**Timeouts** (matching Node.js):
- Non-streaming: 30s total
- Streaming: 90s initial, 60s idle (resets per chunk), 5 min absolute

### 5.3 Default Router

Port from `packages/node/src/routing/default-router.ts`:

```swift
protocol PeerRouter {
    func selectPeer(for request: SerializedHttpRequest, from peers: [PeerInfo]) -> PeerInfo?
    func recordResult(peer: PeerInfo, success: Bool, latencyMs: Double, tokens: Int)
}

class DefaultRouter: PeerRouter {
    let minReputation: Double = 50
    // Score = price(0.35) + capacity(0.25) + latency(0.25) + reputation(0.15)
    // Latency: EMA with alpha=0.3
}
```

### 5.4 BuyerNode (Top-Level)

```swift
@Observable
class BuyerNode {
    let identity: AntseedIdentity
    private let dht: DHTClient
    private let connectionManager: ConnectionManager
    private let executor: RequestExecutor
    private let router: DefaultRouter
    private let metering: MeteringDB

    var state: NodeState = .stopped  // stopped, starting, running, stopping

    func start() async throws { ... }
    func stop() async throws { ... }
    func discoverPeers(service: String?) async throws -> [PeerInfo] { ... }
    func sendMessage(to peer: PeerInfo, prompt: String, model: String) async throws -> String { ... }
    func sendMessageStream(to peer: PeerInfo, prompt: String, model: String) -> AsyncThrowingStream<String, Error> { ... }
}
```

---

## Phase 6: Metering & Storage (Week 6)

### 6.1 SQLite Database

Use GRDB.swift (or raw SQLite C API) for local metering:

```sql
CREATE TABLE metering_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    service TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    latency_ms REAL,
    timestamp INTEGER NOT NULL,
    success INTEGER NOT NULL
);

CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    total_requests INTEGER DEFAULT 0,
    total_input_tokens INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0
);
```

WAL mode for concurrency. Database stored in app's Documents directory.

### 6.2 Token Counter

Simple approximation (matching Node.js `TokenCounter`):
- ~4 chars per token for English text
- Track input + output tokens per request

---

## Phase 7: Chat UI (Week 6-7)

### 7.1 Main Chat View

SwiftUI chat interface:

- **Service picker** at top — select model (e.g., `claude-sonnet-4-5-20250929`)
- **Message list** — scrollable, auto-scroll to bottom on new messages
- **Input bar** — text field + send button
- **Streaming** — tokens appear in real-time as they arrive
- **Markdown rendering** — render AI responses as markdown (use `AttributedString` or
  a lightweight markdown renderer)
- **Connection status** — badge showing node state, connected peer count

### 7.2 Peer Browser

- **Discovery view** — trigger `discoverPeers()`, show results in a list
- **Peer detail** — services offered, pricing, reputation, latency
- **Connect/disconnect** — manage active connections
- **Auto-select** — router picks best peer automatically, or user pins a peer

### 7.3 Settings

- **Identity** — show peer ID, export/import option
- **Bootstrap nodes** — configure custom DHT bootstrap nodes
- **Preferences** — default model, auto-connect on launch, theme

### 7.4 App Lifecycle

- `BuyerNode.start()` on app launch (or first chat)
- `BuyerNode.stop()` on app background (after grace period)
- Reconnect on app foreground if needed
- Store last-known peers for faster reconnection

---

## Phase 8: Integration Testing & Polish (Week 7-8)

### 8.1 End-to-End Testing

- Start a Node.js seller node locally
- iOS app discovers it via DHT (or direct connection for testing)
- Send a real AI request and verify response
- Test streaming responses
- Test connection recovery after network interruption

### 8.2 iOS-Specific Concerns

- **Background execution:** Use `BGAppRefreshTask` for periodic DHT maintenance;
  active connections terminate when backgrounded (iOS limitation)
- **Network transitions:** Handle Wi-Fi → cellular gracefully; WebRTC ICE restart
  may be needed; `NWPathMonitor` to detect changes
- **Battery:** DHT routing table refresh interval increased on battery
  (30 min instead of 15 min)
- **App Transport Security:** Allow cleartext for local/dev HTTP metadata fetch
  (add exception in Info.plist); production sellers should use HTTPS

### 8.3 Monorepo Integration

- `apps/ios-buyer/` is standalone Xcode project (not managed by pnpm)
- Add to root `.gitignore`: Xcode derived data, build products
- Cross-reference protocol test vectors from `packages/node/` via symlink or
  copy script
- CI: Add Xcode build step (macOS runner) if available

---

## Dependency Summary

| Node.js Dependency | iOS Replacement | Effort |
|---|---|---|
| `@noble/ed25519` | `CryptoKit` (Curve25519.Signing) | Low — API maps 1:1 |
| `better-sqlite3` | `GRDB.swift` or raw SQLite3 C API | Low — SQLite is built into iOS |
| `node-datachannel` | Google WebRTC iOS SDK (`WebRTC.framework`) | Medium — different API surface |
| `bittorrent-dht` | Custom Swift BEP5 implementation | High — ~1500 lines of new code |
| `ethers` (EVM wallet) | Deferred to v2 | N/A |
| `keytar` | iOS Keychain (`Security.framework`) | Low |

## Risk Assessment

| Risk | Mitigation |
|---|---|
| BEP5 DHT implementation complexity | Well-specified protocol (BEP5 spec); buyer only needs `get_peers` + `find_node`, not `announce_peer` |
| WebRTC SDK size (~15 MB) | Acceptable for iOS app; no alternative for P2P data channels |
| Ed25519 signature compatibility | Validate with cross-platform test vectors in Phase 1 |
| iOS background restrictions | Accept that connections drop on background; fast reconnect on foreground |
| NAT traversal on cellular | WebRTC ICE handles most cases; TURN server may be needed for symmetric NAT |

## MVP Scope

The MVP delivers:
1. Generate/persist Ed25519 identity
2. Discover peers via BEP5 DHT
3. Connect to sellers via WebRTC (with TCP fallback)
4. Send AI requests and receive streaming responses
5. Chat UI with model selection
6. Local metering (token tracking)
7. Default router (price + reputation + latency scoring)

**Explicitly out of scope for MVP:**
- Payment protocol (escrow, receipts, USDC)
- Provider-side functionality (selling)
- Push notifications
- iPad / macOS Catalyst support
- App Store submission

# @antseed/web-sdk

Browser buyer SDK for AntSeed. Connects to unmodified sellers over WebRTC
DataChannels (signaled through an [@antseed/relay](../../apps/relay)) and pays
per request with in-browser EIP-712 signatures. No native modules; the only
runtime dependency is ethers.

```ts
import { AntseedWebClient } from '@antseed/web-sdk';

const client = new AntseedWebClient({
  relayUrl: 'https://relay.example.com',
  privateKey: buyerHotWalletKey,        // peerId = its EVM address
});

const sellers = await client.sellers();
const session = await client.connect(sellers[0].peerId);

const response = await session.request(
  {
    path: '/v1/messages',
    provider: 'anthropic',
    headers: { accept: 'text/event-stream' },
    body: JSON.stringify({ model: 'claude-sonnet-5', stream: true, messages: [...] }),
  },
  { onChunk: (data, done) => render(new TextDecoder().decode(data)) },
);
```

## Architecture

This package contains only the browser-specific pieces: relay signaling
(`hello` envelope, SDP offer, trickle ICE), the `RTCPeerConnection`
transport, keepalive, and an in-memory channel store. Everything else is
shared code, not a reimplementation:

- **@antseed/protocol** — wire format: message types, frame/HTTP/payment
  codecs, EIP-712 payment signatures, connection auth. Same modules
  @antseed/node runs.
- **@antseed/buyer-core** — the buyer machinery: `BuyerRequestHandler`,
  `BuyerPaymentManager`, `BuyerPaymentNegotiator`, `ProxyMux`/`PaymentMux`.
  The exact classes behind the node/CLI buyer proxy, wired here to a WebRTC
  DataChannel and `MemoryChannelStore`.

So 402 negotiation, ReserveAuth/AuthAck, NeedAuth cost validation, cumulative
SpendingAuth metadata, streaming, and chunked uploads behave identically to
the node buyer. One browser-specific override: uploads chunk above 192 KiB
(not 512 KiB) to stay under the ~256 KiB SCTP message ceiling browsers
negotiate with libdatachannel sellers. Defaults target Base mainnet; override
`payment.*` for other chains.

The relay bridge is closed as soon as the DataChannel opens — it is only
needed for signaling, and holding it would consume the relay's per-IP bridge
slots. There is no re-signaling path; a dropped DataChannel means a fresh
`connect()`.

## Known limitation: large non-streamed responses

Chunking currently protects the upload direction only. A seller sends a
non-streamed response body as a single DataChannel message, and browsers cap
received SCTP messages at ~256 KiB — a larger response (e.g. base64 image
output) will kill the DataChannel. Until seller-side response chunking
exists, prefer streaming (`accept: text/event-stream`) for potentially large
responses.

## Prerequisites for paying sellers

The buyer address must have USDC deposited in AntseedDeposits (directly or
via the gasless EIP-3009 sweep). Deposit UX is out of scope for this SDK.

## Testing

`vitest run` covers byte-for-byte parity with `@antseed/node` (hello
envelope, frame codec, EIP-712 signatures, metadata hashing) and an
end-to-end suite that drives the real `@antseed/node` seller listener through
a real relay instance, with `node-datachannel/polyfill` standing in for the
browser's `RTCPeerConnection`.

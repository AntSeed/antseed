# @antseed/buyer-core

The transport-agnostic buyer machinery, extracted from `@antseed/node` (which
re-exports everything from its original paths, so existing consumers are
unaffected): `BuyerRequestHandler`, `BuyerPaymentManager`,
`BuyerPaymentNegotiator`, `BuyerFreeUsageManager`, the
`ProxyMux`/`PaymentMux`/`VerificationMux` frame multiplexers, pricing and
channel accounting, unit-billing request/response normalization, and the
read-only Deposits/Channels EVM clients.

Depends only on `@antseed/protocol`, `@antseed/api-adapter`, `ethers`, and
`tokenx` — no sqlite, no sockets, no Node-specific APIs.

The environment plugs in through small structural interfaces
(`src/interfaces.ts`, `src/channel-store-types.ts`):

- `BuyerConnection` — `state`, `stateChange` events, `send(bytes)`. Satisfied
  by `@antseed/node`'s `PeerConnection`.
- `BuyerChannelStore` — the channel bookkeeping surface. Satisfied by
  `@antseed/node`'s sqlite `ChannelStore`.
- `BuyerIdentity`, `BuyerPeerView`, `ResponseAuthSink`, `ResponseAuthSampler`
  — identity, peer knowledge, and optional verification persistence.

Implementations don't import this package; compatibility is structural.

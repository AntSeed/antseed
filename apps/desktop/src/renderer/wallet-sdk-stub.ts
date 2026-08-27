/**
 * Build-time stub for browser-wallet SDKs.
 *
 * The Fun checkout SDK statically imports wagmi's connector factories, whose
 * bodies lazily `import()` the actual wallet SDKs (MetaMask, WalletConnect,
 * Coinbase, …) — ~7 MB of chunks for wallet UI the desktop app never shows
 * (`showWalletConnect: false`, zero connectors in the wagmi config, no
 * extension wallets in Electron). Aliasing those packages here (see
 * vite.config.ts) drops the chunks from the bundle. The factories that would
 * consume these modules are never invoked, so this stub is never executed.
 */
export default {};

/** Named exports demanded statically by @wagmi/connectors — all inside
    never-loaded lazy chunks or never-invoked connector factories. Values
    are inert. */
export class CoinbaseWalletSDK {}
export class MetaMaskSDK {}
export const ProviderInterface = undefined;
export const SDKProvider = undefined;
export const RpcSchema = undefined;
export const z = undefined;

export {
  CONNECT_VERSION,
  type ScopeId,
  type ConnectRequest,
  type ConnectResponse,
  type ConnectManifest,
  type ConnectSigner,
  type ScopeAccount,
  type AutoDepositState,
} from './types.js';
export { SCOPES, isScopeId, type ScopeDef } from './scopes.js';
export { parseRequestLink, ConnectRequestError } from './request-link.js';
export { buildSignedMessage } from './message.js';
export {
  signConnectResponse,
  verifyConnectResponse,
  resolveScopeValues,
  ConnectResponseError,
} from './response.js';
export { parseManifest, ConnectManifestError } from './manifest.js';
export {
  encodeResponseFragment,
  decodeResponseFragment,
  buildFragmentUrl,
} from './fragment.js';

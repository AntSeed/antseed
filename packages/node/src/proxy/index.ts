export { ProxyMux } from './proxy-mux.js';
export { encodeHttpRequest, decodeHttpRequest, encodeHttpResponse, decodeHttpResponse, encodeHttpResponseChunk, decodeHttpResponseChunk } from './request-codec.js';
export { detectProviderFromHeaders, detectProviderFromPath, resolveProvider } from './provider-detection.js';
export {
  createStreamingAdapter,
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  transformRequest,
  transformResponse,
  type TargetProtocolSelection,
  type ServiceApiRequestTransformOptions,
  type ServiceApiRequestTransformResult,
  type ServiceApiResponseTransformOptions,
  type ServiceApiStreamTransformOptions,
  type StreamingResponseAdapter,
} from './service-api-adapter.js';

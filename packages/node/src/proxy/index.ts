export { ProxyMux } from './proxy-mux.js';
export { encodeHttpRequest, decodeHttpRequest, encodeHttpResponse, decodeHttpResponse, encodeHttpResponseChunk, decodeHttpResponseChunk } from './request-codec.js';
export { detectProviderFromHeaders, detectProviderFromPath, resolveProvider } from './provider-detection.js';
export {
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
  transformOpenAIResponsesRequestToOpenAIChat,
  transformOpenAIChatResponseToOpenAIResponses,
  type TargetProtocolSelection,
  type AnthropicToOpenAIRequestTransformResult,
  type ResponsesToOpenAIRequestTransformResult,
} from './service-api-adapter.js';

export { ProxyMux } from './proxy-mux.js';
export { encodeHttpRequest, decodeHttpRequest, encodeHttpResponse, decodeHttpResponse, encodeHttpResponseChunk, decodeHttpResponseChunk } from './request-codec.js';
export { detectProviderFromHeaders, detectProviderFromPath, resolveProvider, IDLEAI_PROVIDER_HEADER } from './provider-detection.js';
export {
  detectRequestModelApiProtocol,
  inferProviderDefaultModelApiProtocols,
  selectTargetProtocolForRequest,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
  transformOpenAIResponsesRequestToOpenAIChat,
  transformOpenAIChatResponseToOpenAIResponses,
  type TargetProtocolSelection,
  type AnthropicToOpenAIRequestTransformResult,
  type ResponsesToOpenAIRequestTransformResult,
} from './model-api-adapter.js';

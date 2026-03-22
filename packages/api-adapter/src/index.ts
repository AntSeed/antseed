export {
  createOpenAIChatToAnthropicStreamingAdapter,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
  type AnthropicToOpenAIRequestTransformResult,
} from './anthropic.js';

export {
  createOpenAIChatToResponsesStreamingAdapter,
  createOpenAIResponsesToChatStreamingAdapter,
  transformOpenAIChatRequestToOpenAIResponses,
  transformOpenAIChatResponseToOpenAIResponses,
  transformOpenAIResponsesRequestToOpenAIChat,
  transformOpenAIResponsesResponseToOpenAIChat,
  type ChatToResponsesRequestTransformResult,
  type ResponsesToOpenAIRequestTransformResult,
} from './openai-responses.js';

export {
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  type TargetProtocolSelection,
} from './detect.js';

export {
  type StreamingResponseAdapter,
} from './utils.js';

export {
  type SerializedHttpRequest,
  type SerializedHttpResponse,
  type SerializedHttpResponseChunk,
  type ServiceApiProtocol,
  WELL_KNOWN_SERVICE_API_PROTOCOLS,
  isKnownServiceApiProtocol,
} from './types.js';

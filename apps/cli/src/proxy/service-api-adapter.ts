export {
  createOpenAIChatToAnthropicStreamingAdapter,
  createOpenAIChatToResponsesStreamingAdapter,
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
  transformOpenAIResponsesRequestToOpenAIChat,
  transformOpenAIChatResponseToOpenAIResponses,
} from '@antseed/api-adapter'

export type {
  AnthropicToOpenAIRequestTransformResult,
  ResponsesToOpenAIRequestTransformResult,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
  ServiceApiProtocol,
  StreamingResponseAdapter,
  TargetProtocolSelection,
} from '@antseed/api-adapter'

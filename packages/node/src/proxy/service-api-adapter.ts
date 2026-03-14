// Re-export everything from @antseed/api-adapter for backward compatibility.
// The adapter source now lives in packages/api-adapter.
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
  type TargetProtocolSelection,
  type AnthropicToOpenAIRequestTransformResult,
  type ResponsesToOpenAIRequestTransformResult,
  type StreamingResponseAdapter,
} from '@antseed/api-adapter';

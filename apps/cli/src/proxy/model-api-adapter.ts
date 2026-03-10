// Re-export from the canonical implementation in @antseed/node.
// The CLI previously maintained its own copy; this file now exists
// only to preserve local import paths for buyer-proxy and tests.
export {
  type ModelApiProtocol,
  type TargetProtocolSelection,
  type AnthropicToOpenAIRequestTransformResult,
  type ResponsesToOpenAIRequestTransformResult,
  detectRequestModelApiProtocol,
  inferProviderDefaultModelApiProtocols,
  selectTargetProtocolForRequest,
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIChatResponseToAnthropicMessage,
  transformOpenAIResponsesRequestToOpenAIChat,
  transformOpenAIChatResponseToOpenAIResponses,
} from '@antseed/node'

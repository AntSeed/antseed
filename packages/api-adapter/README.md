# @antseed/api-adapter

HTTP-level format translation between LLM API protocols. Converts requests and responses between Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses — without any network calls.

## Supported Protocols

| Protocol | Identifier |
|---|---|
| Anthropic Messages | `anthropic-messages` |
| OpenAI Chat Completions | `openai-chat-completions` |
| OpenAI Responses | `openai-responses` |
| OpenAI Completions (legacy) | `openai-completions` |

## Transform Matrix

OpenAI Chat Completions is the hub format. All transforms go through it.

```
anthropic-messages  ⟷  openai-chat-completions
openai-responses    ⟷  openai-chat-completions
```

## Usage

### Detect what protocol an incoming request speaks

```ts
import { detectRequestServiceApiProtocol } from '@antseed/api-adapter';

const protocol = detectRequestServiceApiProtocol(request);
// → 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses' | null
```

### Select a target protocol given what a provider supports

```ts
import { selectTargetProtocolForRequest } from '@antseed/api-adapter';

const selection = selectTargetProtocolForRequest('anthropic-messages', ['openai-chat-completions']);
// → { targetProtocol: 'openai-chat-completions', requiresTransform: true }

const passthrough = selectTargetProtocolForRequest('anthropic-messages', ['anthropic-messages']);
// → { targetProtocol: 'anthropic-messages', requiresTransform: false }

const incompatible = selectTargetProtocolForRequest('openai-responses', ['anthropic-messages']);
// → null  (no compatible transform exists)
```

### Transform a request before forwarding to a provider

```ts
import {
  transformAnthropicMessagesRequestToOpenAIChat,
  transformOpenAIResponsesRequestToOpenAIChat,
} from '@antseed/api-adapter';

// Buyer sent an Anthropic request; provider only speaks OpenAI Chat
const result = transformAnthropicMessagesRequestToOpenAIChat(incomingRequest);
if (result) {
  const { request, streamRequested, requestedModel } = result;
  // forward `request` to the provider
}
```

### Transform a non-streaming response back to the original protocol

```ts
import {
  transformOpenAIChatResponseToAnthropicMessage,
  transformOpenAIChatResponseToOpenAIResponses,
} from '@antseed/api-adapter';

// Provider returned an OpenAI Chat response; buyer expects Anthropic
const adapted = transformOpenAIChatResponseToAnthropicMessage(providerResponse, {
  streamRequested: false,
  fallbackModel: 'claude-sonnet',
});
```

### Adapt a streaming response incrementally

For streaming responses, create an adapter once per request and feed it chunks as they arrive.

```ts
import { createOpenAIChatToAnthropicStreamingAdapter } from '@antseed/api-adapter';

const adapter = createOpenAIChatToAnthropicStreamingAdapter({ fallbackModel: 'claude-sonnet' });

// On first response headers:
const startResponse = adapter.adaptStart(providerResponse);
// startResponse.headers['content-type'] === 'text/event-stream'

// On each incoming SSE chunk:
const outChunks = adapter.adaptChunk(incomingChunk);
// outChunks is an array of SerializedHttpResponseChunk in Anthropic SSE format
```

The same pattern applies for `createOpenAIChatToResponsesStreamingAdapter`.

## API Reference

### Protocol detection & routing

```ts
detectRequestServiceApiProtocol(request): ServiceApiProtocol | null
inferProviderDefaultServiceApiProtocols(providerName): ServiceApiProtocol[]
selectTargetProtocolForRequest(requestProtocol, supportedProtocols): TargetProtocolSelection | null
```

`inferProviderDefaultServiceApiProtocols` maps well-known provider names (`'anthropic'`, `'claude-code'`, `'claude-oauth'`, `'openai'`, `'local-llm'`) to their default protocols.

### Anthropic Messages ↔ OpenAI Chat Completions

```ts
transformAnthropicMessagesRequestToOpenAIChat(request): AnthropicToOpenAIRequestTransformResult | null
transformOpenAIChatResponseToAnthropicMessage(response, options): SerializedHttpResponse
createOpenAIChatToAnthropicStreamingAdapter(options): StreamingResponseAdapter
```

### OpenAI Responses ↔ OpenAI Chat Completions

```ts
transformOpenAIResponsesRequestToOpenAIChat(request): ResponsesToOpenAIRequestTransformResult | null
transformOpenAIChatResponseToOpenAIResponses(response, options): SerializedHttpResponse
createOpenAIChatToResponsesStreamingAdapter(options): StreamingResponseAdapter
```

### Types

```ts
interface SerializedHttpRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface SerializedHttpResponse {
  requestId: string;
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface SerializedHttpResponseChunk {
  requestId: string;
  data: Uint8Array;
  done: boolean;
}

interface StreamingResponseAdapter {
  adaptStart(response: SerializedHttpResponse): SerializedHttpResponse;
  adaptChunk(chunk: SerializedHttpResponseChunk): SerializedHttpResponseChunk[];
}
```

## File Structure

```
src/
  utils.ts            Shared helpers: encode/decode, SSE parsing, toStringContent
  detect.ts           Protocol detection and target selection
  anthropic.ts        Anthropic Messages ↔ OpenAI Chat transforms + streaming adapter
  openai-responses.ts OpenAI Responses ↔ OpenAI Chat transforms + streaming adapter
  types.ts            Shared types (SerializedHttpRequest/Response, ServiceApiProtocol)
  index.ts            Public re-exports
```

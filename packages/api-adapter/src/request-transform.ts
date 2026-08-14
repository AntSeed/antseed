import type { SerializedHttpRequest, ServiceApiProtocol } from './types.js';
import {
  normalizeAnthropicMessagesRequestBody,
  normalizeOpenAIChatRequestBody,
  normalizeOpenAIResponsesRequestBody,
  createCanonicalRequestTranslationContext,
  renderCanonicalRequestToAnthropicMessagesBody,
  renderCanonicalRequestToOpenAIChatBody,
  renderCanonicalRequestToOpenAIResponsesBody,
  type CanonicalLlmRequest,
  type CanonicalRequestTranslationContext,
} from './canonical.js';
import { encodeJson, parseJsonObject } from './utils.js';

export interface ServiceApiRequestTransformResult {
  request: SerializedHttpRequest;
  streamRequested: boolean;
  requestedModel: string | null;
  translationContext: CanonicalRequestTranslationContext;
}

export interface ServiceApiRequestTransformOptions {
  from: ServiceApiProtocol;
  to: ServiceApiProtocol;
  streamRequested?: boolean;
}

const CLIENT_STREAM_REQUESTED_HEADER = 'x-antseed-client-stream-requested';

type RequestNormalizer = (body: Record<string, unknown>) => CanonicalLlmRequest;
type RequestRenderer = (
  request: CanonicalLlmRequest,
  options: ServiceApiRequestTransformOptions,
  translationContext: CanonicalRequestTranslationContext,
) => Record<string, unknown>;

const REQUEST_NORMALIZERS: Partial<Record<ServiceApiProtocol, RequestNormalizer>> = {
  'anthropic-messages': normalizeAnthropicMessagesRequestBody,
  'openai-chat-completions': normalizeOpenAIChatRequestBody,
  'openai-responses': normalizeOpenAIResponsesRequestBody,
};

const REQUEST_RENDERERS: Partial<Record<ServiceApiProtocol, RequestRenderer>> = {
  'anthropic-messages': (request, _options, translationContext) =>
    renderCanonicalRequestToAnthropicMessagesBody(request, { translationContext }),
  'openai-chat-completions': (request, options, translationContext) => renderCanonicalRequestToOpenAIChatBody(
    request,
    {
      translationContext,
      toolCallContent: options.from === 'openai-responses' ? null : undefined,
      groupAssistantToolCallsWithPreviousMessage: options.from === 'anthropic-messages',
    },
  ),
  'openai-responses': (request, options, translationContext) => renderCanonicalRequestToOpenAIResponsesBody(
    request,
    {
      translationContext,
      includeMetadata: options.from !== 'anthropic-messages',
      includeUser: options.from !== 'anthropic-messages',
    },
  ),
};

const TARGET_PATHS: Partial<Record<ServiceApiProtocol, string>> = {
  'anthropic-messages': '/v1/messages',
  'openai-chat-completions': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
};

export function transformRequest(
  request: SerializedHttpRequest,
  options: ServiceApiRequestTransformOptions,
): ServiceApiRequestTransformResult | null {
  const normalize = REQUEST_NORMALIZERS[options.from];
  const path = TARGET_PATHS[options.to];
  if (!normalize || !path) return null;

  const body = parseJsonObject(request.body);
  if (!body) return null;
  if (options.from !== options.to
    && options.from === 'openai-responses'
    && responsesConversionIssue(body)) {
    return null;
  }

  const normalized = normalize(body);
  const translationContext = createCanonicalRequestTranslationContext(normalized);
  const streamRequested = options.streamRequested ?? normalized.stream;
  if (options.from === options.to) {
    return {
      request,
      streamRequested,
      requestedModel: normalized.model,
      translationContext,
    };
  }

  const render = REQUEST_RENDERERS[options.to];
  if (!render) return null;
  const requestForRender = streamRequested === normalized.stream
    ? normalized
    : { ...normalized, stream: streamRequested };
  const transformedBody = render(requestForRender, options, translationContext);
  const transformedHeaders = headersForTargetProtocol(request.headers, options.to);
  if (options.to === 'openai-responses') {
    transformedBody.stream = true;
    transformedHeaders[CLIENT_STREAM_REQUESTED_HEADER] = streamRequested ? 'true' : 'false';
  }

  return {
    request: {
      ...request,
      path,
      headers: transformedHeaders,
      body: encodeJson(transformedBody),
    },
    streamRequested,
    requestedModel: normalized.model,
    translationContext,
  };
}

export function requestTransformFailureReason(
  request: SerializedHttpRequest,
  options: ServiceApiRequestTransformOptions,
): string | null {
  if (!REQUEST_NORMALIZERS[options.from]) return `unsupported source protocol ${options.from}`;
  if (!TARGET_PATHS[options.to] || !REQUEST_RENDERERS[options.to]) return `unsupported target protocol ${options.to}`;
  const body = parseJsonObject(request.body);
  if (!body) return 'request body is not a JSON object';
  if (options.from === 'openai-responses' && options.from !== options.to) {
    return responsesConversionIssue(body);
  }
  return null;
}

function responsesConversionIssue(body: Record<string, unknown>): string | null {
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isConvertibleResponsesTool(tool)) {
        const type = tool && typeof tool === 'object' && !Array.isArray(tool)
          ? String((tool as Record<string, unknown>).type ?? 'missing')
          : typeof tool;
        return `unsupported Responses tool declaration type=${type}`;
      }
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isConvertibleResponsesToolHistoryItem(item)) {
        const type = item && typeof item === 'object' && !Array.isArray(item)
          ? String((item as Record<string, unknown>).type ?? 'missing')
          : typeof item;
        return `unsupported Responses tool history type=${type}`;
      }
    }
  }
  return null;
}

function isConvertibleResponsesTool(tool: unknown): boolean {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
  const entry = tool as Record<string, unknown>;
  const type = entry.type;
  if (type === 'function' || type === 'custom' || type === 'local_shell' || type === 'shell') return true;
  if (type === 'namespace') {
    return typeof entry.name === 'string'
      && Array.isArray(entry.tools)
      && entry.tools.every((nested) => Boolean(nested)
        && typeof nested === 'object'
        && !Array.isArray(nested)
        && (nested as Record<string, unknown>).type === 'function');
  }
  return type === 'web_search' && entry.external_web_access === false;
}

function isConvertibleResponsesToolHistoryItem(item: unknown): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
  const type = (item as Record<string, unknown>).type;
  if (typeof type !== 'string' || !type.includes('call')) return true;
  return type === 'function_call'
    || type === 'function_call_output'
    || type === 'custom_tool_call'
    || type === 'custom_tool_call_output'
    || type === 'local_shell_call'
    || type === 'local_shell_call_output'
    || type === 'shell_call'
    || type === 'shell_call_output';
}

function headersForTargetProtocol(
  headers: Record<string, string>,
  targetProtocol: ServiceApiProtocol,
): Record<string, string> {
  const transformedHeaders: Record<string, string> = { ...headers };
  for (const headerName of Object.keys(transformedHeaders)) {
    const lower = headerName.toLowerCase();
    if (lower === 'anthropic-beta') delete transformedHeaders[headerName];
    if (targetProtocol !== 'anthropic-messages' && lower === 'anthropic-version') {
      delete transformedHeaders[headerName];
    }
  }

  if (targetProtocol === 'anthropic-messages' && !hasHeader(transformedHeaders, 'anthropic-version')) {
    transformedHeaders['anthropic-version'] = '2023-06-01';
  }
  transformedHeaders['content-type'] = 'application/json';
  return transformedHeaders;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === normalizedName);
}

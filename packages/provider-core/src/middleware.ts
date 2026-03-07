export type MiddlewarePosition =
  | 'system-prepend'   // Prepend to Anthropic system field; or inject system-role msg at top of OpenAI messages
  | 'system-append'    // Append to Anthropic system field; or at end of OpenAI system messages
  | 'prepend'          // Insert as first element of messages array
  | 'append';          // Insert as last element of messages array

export interface ProviderMiddleware {
  /** Markdown content to inject. */
  content: string;
  position: MiddlewarePosition;
  /** Role for 'prepend'/'append' positions. Default: 'user'. */
  role?: string;
  /** If set, only inject for requests targeting one of these model IDs. Applies to all models when omitted. */
  models?: string[];
}

/**
 * Inject middleware content into an already-parsed request body.
 * Handles both Anthropic format (top-level `system` string) and
 * OpenAI format (system role inside `messages` array).
 *
 * @param format - 'anthropic' (default) for Anthropic-style requests, 'openai' for
 *                 OpenAI-compatible requests where system prompts live inside `messages`.
 */
export function applyMiddleware(
  body: Record<string, unknown>,
  middlewares: ProviderMiddleware[],
  format: 'anthropic' | 'openai' = 'anthropic',
): Record<string, unknown> {
  if (!middlewares.length) return body;

  let result: Record<string, unknown> = { ...body };

  for (const mw of middlewares) {
    if (mw.position === 'system-prepend' || mw.position === 'system-append') {
      result = applySystemMiddleware(result, mw, format);
    } else {
      result = applyMessagesMiddleware(result, mw);
    }
  }

  return result;
}

function applySystemMiddleware(
  body: Record<string, unknown>,
  mw: ProviderMiddleware,
  format: 'anthropic' | 'openai',
): Record<string, unknown> {
  const prepend = mw.position === 'system-prepend';

  if (format !== 'openai') {
    // Anthropic format: top-level `system` string or array of content blocks
    if (typeof body.system === 'string') {
      return {
        ...body,
        system: prepend
          ? `${mw.content}\n\n${body.system}`
          : `${body.system}\n\n${mw.content}`,
      };
    }

    if (Array.isArray(body.system)) {
      const block = { type: 'text', text: mw.content };
      return {
        ...body,
        system: prepend
          ? [block, ...body.system]
          : [...body.system, block],
      };
    }

    // No system field yet — create one
    return { ...body, system: mw.content };
  }

  // OpenAI format: system prompt lives inside the messages array
  const messages = Array.isArray(body.messages) ? [...(body.messages as unknown[])] : [];
  const systemMsg = { role: 'system', content: mw.content };
  if (prepend) {
    // Insert before existing system messages (at index 0)
    messages.unshift(systemMsg);
  } else {
    // Insert after the last existing system message, or at the end
    const lastSystem = messages.reduceRight<number>(
      (acc, msg, i) => acc === -1 && (msg as Record<string, unknown>).role === 'system' ? i : acc,
      -1,
    );
    if (lastSystem === -1) {
      messages.push(systemMsg);
    } else {
      messages.splice(lastSystem + 1, 0, systemMsg);
    }
  }
  return { ...body, messages };
}

function applyMessagesMiddleware(
  body: Record<string, unknown>,
  mw: ProviderMiddleware,
): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? [...(body.messages as unknown[])] : [];
  const injected = { role: mw.role ?? 'user', content: mw.content };
  if (mw.position === 'prepend') {
    messages.unshift(injected);
  } else {
    messages.push(injected);
  }
  return { ...body, messages };
}

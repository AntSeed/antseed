export const WELL_KNOWN_MODEL_API_PROTOCOLS = [
  'anthropic-messages',
  'openai-chat-completions',
  'openai-completions',
  'openai-responses',
] as const;

export type ModelApiProtocol = (typeof WELL_KNOWN_MODEL_API_PROTOCOLS)[number];

const MODEL_API_PROTOCOL_SET = new Set<string>(WELL_KNOWN_MODEL_API_PROTOCOLS);

export function isKnownModelApiProtocol(value: string): value is ModelApiProtocol {
  return MODEL_API_PROTOCOL_SET.has(value);
}

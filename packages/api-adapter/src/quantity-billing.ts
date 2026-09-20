import { extractImageRequestFacts, extractProviderResponseFacts, extractRequestBodyFields, parseJsonObject } from './utils.js';

export interface QuantityBillingRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface QuantityBillingRequestFacts {
  attributes: Record<string, string>;
  maxQuantity: number;
  estimatedPromptTokens?: number;
}

export interface QuantityBillingAdapter {
  readonly pricingAttributes: readonly string[];
  captureRequest(request: QuantityBillingRequest): QuantityBillingRequestFacts;
  measureResponse(response: { statusCode: number; body: Uint8Array }): number;
}

const imagePricingAttributes = ['model', 'size', 'quality', 'resolution'] as const;

function successfulBody(response: { statusCode: number; body: Uint8Array }): Record<string, unknown> | null {
  if (response.statusCode < 200 || response.statusCode >= 300) return null;
  const parsed = parseJsonObject(response.body);
  return parsed && !parsed.error ? parsed : null;
}

const imageAdapter: QuantityBillingAdapter = {
  pricingAttributes: imagePricingAttributes,
  captureRequest(request) {
    const parsed = extractRequestBodyFields(request.headers, request.body);
    if (!parsed) throw new Error('Quantity billing requires a readable request body');
    if (parsed.n !== undefined && ((typeof parsed.n !== 'number' && typeof parsed.n !== 'string')
      || !/^[1-9]\d*$/.test(String(parsed.n)) || !Number.isSafeInteger(Number(parsed.n)))) {
      throw new Error('Image quantity must be a positive safe integer');
    }
    const facts = extractImageRequestFacts({ path: request.path, method: request.method, body: parsed });
    const attributes: Record<string, string> = {};
    for (const key of imagePricingAttributes) {
      if (facts[key] !== undefined) attributes[key] = facts[key];
    }
    return { attributes, maxQuantity: facts.requestedImages ?? 1,
      ...(facts.promptTokens !== undefined ? { estimatedPromptTokens: facts.promptTokens } : {}) };
  },
  measureResponse(response) {
    const parsed = successfulBody(response);
    return parsed ? extractProviderResponseFacts(parsed).outputImages ?? 0 : 0;
  },
};

const chatAdapter: QuantityBillingAdapter = {
  pricingAttributes: [],
  captureRequest(request) {
    const parsed = extractRequestBodyFields(request.headers, request.body);
    if (parsed?.stream === true) throw new Error('Quantity billing does not support streaming chat requests');
    return { attributes: {}, maxQuantity: 1 };
  },
  measureResponse(response) {
    const parsed = successfulBody(response);
    return parsed && Array.isArray(parsed.choices) && parsed.choices.some(choice => choice && typeof choice === 'object'
      && choice.message && typeof choice.message === 'object') ? 1 : 0;
  },
};

const routingAdapter: QuantityBillingAdapter = {
  pricingAttributes: [],
  captureRequest() { return { attributes: {}, maxQuantity: 1 }; },
  measureResponse(response) {
    const parsed = successfulBody(response);
    return parsed?.version === 1 && Array.isArray(parsed.recommendations) && parsed.recommendations.length > 0 ? 1 : 0;
  },
};

export function getQuantityBillingAdapter(protocol: string): QuantityBillingAdapter | undefined {
  switch (protocol) {
    case 'openai-images': return imageAdapter;
    case 'openai-chat-completions': return chatAdapter;
    case 'antseed-routing': return routingAdapter;
    default: return undefined;
  }
}

export function validateQuantityBillingConditions(protocol: string, model: { components: readonly { match?: Record<string, string> }[] }): string[] {
  const adapter = getQuantityBillingAdapter(protocol);
  if (!adapter) return ['Unsupported quantity billing adapter'];
  return model.components.flatMap((component, index) => Object.keys(component.match ?? {})
    .filter(key => !adapter.pricingAttributes.includes(key))
    .map(key => `components[${index}].match.${key} is unsupported for ${protocol}`));
}

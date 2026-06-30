import type { ServiceApiProtocol } from './types.js';
import { registerAnthropicStreamingAdapters } from './anthropic.js';
import { registerOpenAIResponsesStreamingAdapters } from './openai-responses.js';
import type { StreamingResponseAdapter } from './utils.js';

export interface ServiceApiStreamTransformOptions {
  from: ServiceApiProtocol;
  to: ServiceApiProtocol;
  fallbackModel?: string | null;
}

type StreamAdapterFactory = (options: { fallbackModel?: string | null }) => StreamingResponseAdapter;
export type StreamAdapterRegistrar = (
  from: ServiceApiProtocol,
  to: ServiceApiProtocol,
  factory: StreamAdapterFactory,
) => void;

interface StreamAdapterEdge {
  from: ServiceApiProtocol;
  to: ServiceApiProtocol;
  factory: StreamAdapterFactory;
}

const STREAM_ADAPTER_EDGES: StreamAdapterEdge[] = [];

const register: StreamAdapterRegistrar = (from, to, factory) => {
  STREAM_ADAPTER_EDGES.push({ from, to, factory });
};

registerAnthropicStreamingAdapters(register);
registerOpenAIResponsesStreamingAdapters(register);

export function createStreamingAdapter(
  options: ServiceApiStreamTransformOptions,
): StreamingResponseAdapter | null {
  if (options.from === options.to) return null;
  const adapterOptions = { fallbackModel: options.fallbackModel ?? null };
  const direct = findDirectEdge(options.from, options.to);
  if (direct) return direct(adapterOptions);

  const path = findStreamPath(options.from, options.to);
  if (!path) return null;
  return composeStreamingAdapters(path.map((factory) => factory(adapterOptions)));
}

function findDirectEdge(from: ServiceApiProtocol, to: ServiceApiProtocol): StreamAdapterFactory | null {
  return STREAM_ADAPTER_EDGES.find((edge) => edge.from === from && edge.to === to)?.factory ?? null;
}

function findStreamPath(from: ServiceApiProtocol, to: ServiceApiProtocol): StreamAdapterFactory[] | null {
  const queue: Array<{ protocol: ServiceApiProtocol; path: StreamAdapterFactory[] }> = [
    { protocol: from, path: [] },
  ];
  const visited = new Set<ServiceApiProtocol>([from]);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    for (const edge of STREAM_ADAPTER_EDGES) {
      if (edge.from !== current.protocol || visited.has(edge.to)) continue;
      const path = [...current.path, edge.factory];
      if (edge.to === to) return path;
      visited.add(edge.to);
      queue.push({ protocol: edge.to, path });
    }
  }

  return null;
}

function composeStreamingAdapters(adapters: StreamingResponseAdapter[]): StreamingResponseAdapter {
  return {
    adaptStart(response) {
      return adapters.reduce((current, adapter) => adapter.adaptStart(current), response);
    },
    adaptChunk(chunk) {
      return adapters.reduce(
        (chunks, adapter) => chunks.flatMap((currentChunk) => adapter.adaptChunk(currentChunk)),
        [chunk],
      );
    },
  };
}

import type { Model, StreamOptions } from '@mariozechner/pi-ai';

export const DEFAULT_MAX_TOKENS = 16_384;

export function resolveRequestMaxTokens(
  model: Pick<Model<any>, 'maxTokens'>,
  options?: Pick<StreamOptions, 'maxTokens'>,
): number {
  const requested = Number(options?.maxTokens);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.floor(requested);
  }

  const modelMaxTokens = Number(model.maxTokens);
  if (Number.isFinite(modelMaxTokens) && modelMaxTokens > 0) {
    return Math.floor(modelMaxTokens);
  }

  return DEFAULT_MAX_TOKENS;
}

type ModelLike = {
  provider?: string;
  id?: string;
};

export async function streamSimple(): Promise<never> {
  throw new Error('streamSimple is not available in the desktop renderer shim');
}

export function getProviders(): string[] {
  return [];
}

export function getModels(): Array<Record<string, unknown>> {
  return [];
}

export function getModel(provider: string, id: string): Record<string, unknown> {
  return {
    provider,
    id,
    name: id,
    reasoning: false,
    input: ['text'],
    contextWindow: 0,
    maxTokens: 0,
    cost: { input: 0, output: 0 },
  };
}

export async function complete(): Promise<{ stopReason: 'stop' }> {
  return { stopReason: 'stop' };
}

export function StringEnum(values: string[], options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'string',
    enum: [...values],
    ...options,
  };
}

export function modelsAreEqual(left: ModelLike | null | undefined, right: ModelLike | null | undefined): boolean {
  if (!left || !right) return false;
  return left.provider === right.provider && left.id === right.id;
}

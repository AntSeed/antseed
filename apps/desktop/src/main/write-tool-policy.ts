import {
  createWriteTool,
  type WriteOperations,
  type WriteToolInput,
  type WriteToolOptions,
} from '@mariozechner/pi-coding-agent';

export const MAX_DIRECT_WRITE_CHARS = 8_000;

export function buildDirectWriteLimitMessage(contentLength: number): string {
  return [
    `Direct write payload too large (${contentLength} chars).`,
    `To avoid provider-side tool-call truncation, keep write content at or below ${MAX_DIRECT_WRITE_CHARS} chars.`,
    'For larger files, create a short stub first and then use edit in small chunks.',
  ].join(' ');
}

export function createManagedWriteTool(
  cwd: string,
  options?: WriteToolOptions & { maxChars?: number },
): ReturnType<typeof createWriteTool> {
  const maxChars = Math.max(1, options?.maxChars ?? MAX_DIRECT_WRITE_CHARS);
  const operations: WriteOperations | undefined = options?.operations;
  const baseTool = createWriteTool(cwd, operations ? { operations } : undefined);

  return {
    ...baseTool,
    description:
      `Write small files or short full rewrites (up to ${maxChars} chars). `
      + 'For larger files, create a short stub and then use edit in small chunks.',
    async execute(
      toolCallId: string,
      params: WriteToolInput,
      signal?: AbortSignal,
      onUpdate?: Parameters<typeof baseTool.execute>[3],
    ) {
      const typedParams = params as WriteToolInput;
      if (typedParams.content.length > maxChars) {
        throw new Error(buildDirectWriteLimitMessage(typedParams.content.length));
      }
      return baseTool.execute(toolCallId, typedParams, signal, onUpdate);
    },
  };
}

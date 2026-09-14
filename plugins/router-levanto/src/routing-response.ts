const MAX_RESPONSE_BYTES = 256 * 1024;

export async function readRoutingJson(response: Response, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const reader = response.body?.getReader();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Routing response aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    if (!reader) {
      const parsed: unknown = await Promise.race([response.json(), aborted]);
      if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_RESPONSE_BYTES) throw new Error('Routing response exceeds 256 KiB');
      return parsed;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Routing response exceeds 256 KiB');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

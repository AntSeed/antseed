import { describe, expect, it, vi } from 'vitest';
import { readRoutingJson } from './routing-response.js';

describe('bounded routing responses', () => {
  it('reads chunked JSON including split multibyte characters', async () => {
    const bytes = new TextEncoder().encode('{"model":"模型"}');
    const response = new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }));
    expect(await readRoutingJson(response, new AbortController().signal)).toEqual({ model: '模型' });
  });

  it('rejects oversized chunked content and cancels the stream', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); }, cancel }));
    await expect(readRoutingJson(response, new AbortController().signal)).rejects.toThrow('256 KiB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts a body that never completes, even if stream cancellation stalls', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const controller = new AbortController();
    const pending = readRoutingJson(new Response(new ReadableStream({ cancel })), controller.signal);
    controller.abort(new Error('host deadline'));
    await expect(pending).rejects.toThrow('host deadline');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects malformed JSON and already-cancelled reads', async () => {
    await expect(readRoutingJson(new Response('{'), new AbortController().signal)).rejects.toThrow(SyntaxError);
    await expect(readRoutingJson(new Response('{}'), AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
  });
});

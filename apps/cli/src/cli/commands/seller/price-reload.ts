import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Provider } from '@antseed/node';
import { resolveConfigPath } from '../../../config/loader.js';

type Pricing = Record<string, Provider['pricing']>;

export function watchSellerPrices(configPath: string, options: {
  initialPricing: Pricing;
  readPricing: () => Promise<Pricing>;
  applyPricing: (pricing: Pricing) => Promise<void>;
  onReload: () => void;
  onError: (error: unknown) => void;
  debounceMs?: number;
  pollIntervalMs?: number;
}): { close: () => Promise<void> } {
  const path = resolveConfigPath(configPath);
  let current = structuredClone(options.initialPricing);
  let closed = false;
  let dirty = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let lastFailure: string | undefined;

  const reload = (): void => {
    if (closed) return;
    dirty = true;
    if (running) return;
    running = (async () => {
      while (dirty && !closed) {
        dirty = false;
        try {
          const pricing = await options.readPricing();
          lastFailure = undefined;
          if (closed || isDeepStrictEqual(current, pricing)) continue;
          await options.applyPricing(pricing);
          current = structuredClone(pricing);
          options.onReload();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!closed && message !== lastFailure) options.onError(error);
          lastFailure = message;
        }
      }
    })().finally(() => { running = undefined; });
  };

  const schedule = (): void => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(reload, options.debounceMs ?? 200);
    timer.unref();
  };

  try {
    watcher = watch(dirname(path), (_event, filename) => {
      if (filename === null || filename.toString() === basename(path)) schedule();
    });
    watcher.on('error', (error) => {
      options.onError(error);
      watcher?.close();
    });
    watcher.unref();
  } catch (error) {
    options.onError(error);
  }
  const poll = setInterval(reload, options.pollIntervalMs ?? 5_000);
  poll.unref();
  schedule();

  return {
    async close() {
      closed = true;
      watcher?.close();
      clearTimeout(timer);
      clearInterval(poll);
      await running;
    },
  };
}

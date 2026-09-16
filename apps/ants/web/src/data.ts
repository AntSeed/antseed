import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from './format';

/**
 * Per-key in-memory cache with request de-duplication. Pages fetch lazily
 * when opened; navigating back shows the last result instantly and
 * revalidates in the background when it is older than `staleMs`. Finished
 * jobs call `invalidateAll()` so every mounted consumer refetches.
 */

interface Entry {
  data: unknown;
  at: number;
}

let generation = 0;
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Set<(clear: boolean) => void>();

/** Clear visible account data only across identity changes; otherwise revalidate in place. */
export function invalidateAll({ clear = false }: { clear?: boolean } = {}): void {
  generation++;
  inflight.clear();
  if (clear) cache.clear();
  else for (const entry of cache.values()) entry.at = 0;
  for (const listener of listeners) listener(clear);
}

export function invalidatePrefix(prefix: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const listener of listeners) listener(false);
}

export interface PageData<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
  refresh: () => void;
}

interface State<T> {
  key: string | null;
  data: T | null;
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
}

function readCache<T>(key: string | null): State<T> {
  const hit = key !== null ? cache.get(key) : undefined;
  if (hit) return { key, data: hit.data as T, error: null, loading: false, updatedAt: hit.at };
  return { key, data: null, error: null, loading: key !== null, updatedAt: null };
}

export function usePageData<T>(key: string | null, fetcher: () => Promise<T>, staleMs = 60_000): PageData<T> {
  const [state, setState] = useState<State<T>>(() => readCache<T>(key));
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(key);
  keyRef.current = key;
  const mountedRef = useRef(true);
  const retryCount = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback((k: string) => {
    const startedGeneration = generation;
    setState((prev) => (prev.key === k ? { ...prev, loading: true, error: null } : { ...readCache<T>(k), loading: true }));
    let promise = inflight.get(k) as Promise<T> | undefined;
    if (!promise) {
      const started = fetcherRef.current();
      promise = started;
      inflight.set(k, started);
      started
        .then((data) => {
          if (startedGeneration === generation) cache.set(k, { data, at: Date.now() });
        })
        .catch(() => undefined)
        .finally(() => {
          if (inflight.get(k) === started) inflight.delete(k);
        });
    }
    promise.then(
      (data) => {
        if (!mountedRef.current || keyRef.current !== k || startedGeneration !== generation) return;
        setState({ key: k, data, error: null, loading: false, updatedAt: Date.now() });
      },
      (error: unknown) => {
        if (!mountedRef.current || keyRef.current !== k || startedGeneration !== generation) return;
        setState((prev) => ({ ...(prev.key === k ? prev : readCache<T>(k)), key: k, loading: false, error: describeError(error) }));
      },
    );
  }, []);

  useEffect(() => {
    if (key === null) {
      setState(readCache<T>(null));
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setState(readCache<T>(key));
      if (Date.now() - hit.at < staleMs) return;
    }
    load(key);
  }, [key, load, staleMs]);

  useEffect(() => {
    const listener = (clear: boolean) => {
      if (keyRef.current !== null) {
        // Keep the shell mounted, but do not display the previous wallet's balances.
        if (clear && keyRef.current !== 'config') setState(readCache<T>(keyRef.current));
        load(keyRef.current);
      }
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [load]);

  const refresh = useCallback(() => {
    if (keyRef.current !== null) load(keyRef.current);
  }, [load]);

  useEffect(() => {
    retryCount.current = 0;
  }, [key]);

  useEffect(() => {
    if (!state.error) {
      if (!state.loading) retryCount.current = 0;
      return;
    }
    if (key === null || retryCount.current >= 2 || !/rate limit|network error|HTTP 5\d\d|timeout/i.test(state.error)) return;
    const timer = window.setTimeout(() => {
      retryCount.current += 1;
      load(key);
    }, 25_000 * (retryCount.current + 1));
    return () => window.clearTimeout(timer);
  }, [key, state.error, state.loading, load]);

  const view = state.key === key ? state : readCache<T>(key);
  return { data: view.data, error: view.error, loading: view.loading, updatedAt: view.updatedAt, refresh };
}

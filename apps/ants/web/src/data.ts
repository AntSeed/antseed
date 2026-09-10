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

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();

export function invalidateAll(): void {
  cache.clear();
  for (const listener of listeners) listener();
}

export function invalidatePrefix(prefix: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const listener of listeners) listener();
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback((k: string) => {
    setState((prev) => (prev.key === k ? { ...prev, loading: true, error: null } : { ...readCache<T>(k), loading: true }));
    let promise = inflight.get(k) as Promise<T> | undefined;
    if (!promise) {
      const started = fetcherRef.current();
      promise = started;
      inflight.set(k, started);
      started
        .then((data) => {
          cache.set(k, { data, at: Date.now() });
        })
        .catch(() => undefined)
        .finally(() => {
          if (inflight.get(k) === started) inflight.delete(k);
        });
    }
    promise.then(
      (data) => {
        if (!mountedRef.current || keyRef.current !== k) return;
        setState({ key: k, data, error: null, loading: false, updatedAt: Date.now() });
      },
      (error: unknown) => {
        if (!mountedRef.current || keyRef.current !== k) return;
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
    const listener = () => {
      if (keyRef.current !== null) load(keyRef.current);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [load]);

  const refresh = useCallback(() => {
    if (keyRef.current !== null) load(keyRef.current);
  }, [load]);

  const view = state.key === key ? state : readCache<T>(key);
  return { data: view.data, error: view.error, loading: view.loading, updatedAt: view.updatedAt, refresh };
}

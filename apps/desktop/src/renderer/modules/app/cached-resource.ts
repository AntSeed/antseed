import { useEffect, useSyncExternalStore } from 'react';

export type CachedResourceSnapshot<T> = {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
};

type Listener = () => void;

type CachedResourceOptions<T> = {
  load: () => Promise<T>;
  pollMs?: number;
};

export type CachedResource<T> = {
  getSnapshot: () => CachedResourceSnapshot<T>;
  subscribe: (listener: Listener) => () => void;
  activate: () => () => void;
  refresh: () => Promise<T | null>;
  setData: (data: T) => void;
};

export function createCachedResource<T>({ load, pollMs }: CachedResourceOptions<T>): CachedResource<T> {
  let snapshot: CachedResourceSnapshot<T> = {
    data: null,
    loading: false,
    refreshing: false,
    error: null,
  };
  let inFlight: Promise<T | null> | null = null;
  let activeCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<Listener>();

  function publish(next: CachedResourceSnapshot<T>): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  async function refresh(): Promise<T | null> {
    if (inFlight) return inFlight;
    publish({
      ...snapshot,
      loading: snapshot.data === null,
      refreshing: snapshot.data !== null,
      error: null,
    });
    inFlight = load()
      .then((data) => {
        publish({ data, loading: false, refreshing: false, error: null });
        return data;
      })
      .catch((error: unknown) => {
        publish({
          ...snapshot,
          loading: false,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function activate(): () => void {
    activeCount += 1;
    if (activeCount === 1) {
      void refresh();
      if (pollMs) timer = setInterval(() => { void refresh(); }, pollMs);
    }
    return () => {
      activeCount = Math.max(0, activeCount - 1);
      if (activeCount === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activate,
    refresh,
    setData(data) {
      publish({ data, loading: false, refreshing: false, error: null });
    },
  };
}

export function useCachedResource<T>(resource: CachedResource<T>, active = true): CachedResourceSnapshot<T> {
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => {
    if (!active) return undefined;
    return resource.activate();
  }, [active, resource]);
  return snapshot;
}

import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export function resolveRetainedUpdate<T>(current: T, next: SetStateAction<T>): T {
  return typeof next === 'function'
    ? (next as (value: T) => T)(current)
    : next;
}

export function writeRetainedState<TCache extends object, K extends keyof TCache>(
  cache: TCache,
  key: K,
  value: TCache[K],
): TCache[K] {
  cache[key] = value;
  return value;
}

/**
 * Keeps page-local state in a renderer-lifetime cache so lazy-unmounted views
 * remount with their previous draft/filter/form values. Pass `cloneInitialValue`
 * for mutable cached values such as Sets so component state cannot mutate the
 * retained object in place.
 */
export function useRetainedState<TCache extends object, K extends keyof TCache>(
  cache: TCache,
  key: K,
  cloneInitialValue?: (value: TCache[K]) => TCache[K],
): [TCache[K], Dispatch<SetStateAction<TCache[K]>>] {
  const [value, setValueState] = useState<TCache[K]>(() => {
    const cachedValue = cache[key];
    return cloneInitialValue ? cloneInitialValue(cachedValue) : cachedValue;
  });

  const setValue = useCallback<Dispatch<SetStateAction<TCache[K]>>>((next) => {
    setValueState((current) => writeRetainedState(cache, key, resolveRetainedUpdate(current, next)));
  }, [cache, key]);

  return [value, setValue];
}

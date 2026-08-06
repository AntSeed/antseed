import { useMemo, useRef, useSyncExternalStore } from 'react';
import { getUiStateRef, subscribe } from '../../core/store';
import type { RendererUiState } from '../../core/state';

export function shallowEqual<T>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) ||
    Array.isArray(right)
  ) {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;

  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
    if (!Object.is(leftRecord[key], rightRecord[key])) return false;
  }

  return true;
}

export function createSelectedSnapshotGetter<T>(
  selector: (state: RendererUiState) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
  getState: () => RendererUiState = getUiStateRef,
): () => T {
  let initialized = false;
  let previous: T;

  return () => {
    const next = selector(getState());
    if (initialized && isEqual(previous, next)) {
      return previous;
    }
    initialized = true;
    previous = next;
    return next;
  };
}

export function useUiSelector<T>(
  selector: (state: RendererUiState) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector);
  const isEqualRef = useRef(isEqual);
  selectorRef.current = selector;
  isEqualRef.current = isEqual;

  const getSelectedSnapshot = useMemo(
    () => createSelectedSnapshotGetter(
      (state) => selectorRef.current(state),
      (left, right) => isEqualRef.current(left, right),
    ),
    [],
  );

  return useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedSnapshot);
}

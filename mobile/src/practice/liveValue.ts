import { useSyncExternalStore } from 'react';

// A value that changes many times a second (the live pitch), held outside React state so that
// only the small components showing it re-render -- not the whole practice screen with its score
// view and wood. Every live reading used to redraw everything, 8+ times a second.
export interface LiveValue<T> {
  get: () => T;
  set: (value: T) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createLiveValue<T>(initial: T): LiveValue<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useLiveValue<T>(store: LiveValue<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

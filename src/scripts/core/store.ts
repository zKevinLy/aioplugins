// A tiny observable value. Components share state through stores instead of
// reaching into each other's DOM.

export type Listener<T> = (value: T) => void;

export interface Store<T> {
  get(): T;
  set(next: T): void;
  update(change: (current: T) => T): void;
  /** Subscribes to future changes; returns an unsubscribe function. */
  subscribe(listener: Listener<T>): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<Listener<T>>();

  const store: Store<T> = {
    get: () => value,
    set(next) {
      value = next;
      for (const listener of [...listeners]) listener(value);
    },
    update(change) {
      store.set(change(value));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };

  return store;
}

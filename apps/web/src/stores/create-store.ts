import { useSyncExternalStore } from "react";

/**
 * A tiny store that lives OUTSIDE React.
 *
 * Why not just useState/context? Flashes and toasts change often and concern one small part of the
 * screen. If that state lived in a context, every consumer would re-render on every change. Here a
 * component subscribes with a SELECTOR and re-renders only when its own slice changes: when one
 * flag row flashes, the other rows do not render at all.
 *
 * `useSyncExternalStore` is React's official hook for reading such a store safely.
 */
export function createStore<State>(initial: State) {
  let state = initial;
  const listeners = new Set<() => void>();

  const get = () => state;
  const set = (next: State | ((current: State) => State)) => {
    const value = typeof next === "function" ? (next as (current: State) => State)(state) : next;
    if (Object.is(value, state)) return;
    state = value;
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  /** Read a slice. The selector must return a stable value (a primitive, or the same object) when nothing changed. */
  function use<Slice>(selector: (state: State) => Slice): Slice {
    return useSyncExternalStore(
      subscribe,
      () => selector(state),
      () => selector(initial),
    );
  }

  return { get, set, subscribe, use, reset: () => set(initial) };
}

import { createStore } from "./create-store";

/** Why a row is flashing. It decides the colour: ember = a live update arrived; ink = you did it; danger = killed. */
export type FlashKind = "remote" | "local" | "kill";

export interface Flash {
  /** Changes on every flash, so the animation restarts even if the same row flashes twice. */
  id: number;
  kind: FlashKind;
  /** Shown as the "updated just now" tag until it expires. */
  tagUntil: number;
}

/** How long the mono "updated just now" tag stays after the colour has faded. */
export const TAG_MS = 6000;

const store = createStore<Readonly<Record<string, Flash>>>({});
let counter = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Mark a flag as just changed. The row that shows it flashes; no other row re-renders. */
export function flash(flagId: string, kind: FlashKind) {
  const entry: Flash = { id: ++counter, kind, tagUntil: Date.now() + TAG_MS };
  store.set((current) => ({ ...current, [flagId]: entry }));

  clearTimeout(timers.get(flagId));
  timers.set(
    flagId,
    setTimeout(() => {
      timers.delete(flagId);
      store.set((current) => {
        if (current[flagId]?.id !== entry.id) return current;
        const { [flagId]: _gone, ...rest } = current;
        return rest;
      });
    }, TAG_MS),
  );
}

/** The current flash for one flag, or undefined. Selecting by id is what keeps other rows still. */
export const useFlash = (flagId: string): Flash | undefined => store.use((state) => state[flagId]);

export function resetFlashes() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  store.reset();
}

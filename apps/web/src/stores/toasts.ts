import { createStore } from "./create-store";

export type ToastTone = "neutral" | "live" | "danger";

export interface Toast {
  id: number;
  title: string;
  detail?: string;
  tone: ToastTone;
}

const DURATION_MS = 4500;
const MAX_VISIBLE = 4;

const store = createStore<readonly Toast[]>([]);
let counter = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function dismissToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  store.set((current) => current.filter((t) => t.id !== id));
}

/** Show a short message. It removes itself; hovering the stack pauses that (see Toaster). */
export function toast(title: string, options: { detail?: string; tone?: ToastTone } = {}): number {
  const entry: Toast = { id: ++counter, title, tone: options.tone ?? "neutral", ...(options.detail ? { detail: options.detail } : {}) };
  // Newest last; drop the oldest if the stack is full so it never grows off the screen.
  store.set((current) => [...current, entry].slice(-MAX_VISIBLE));
  scheduleDismiss(entry.id);
  return entry.id;
}

function scheduleDismiss(id: number) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => dismissToast(id), DURATION_MS));
}

/** Hovering or focusing the stack stops the countdown, so a message can be read without racing it. */
export function pauseToasts() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

export function resumeToasts() {
  for (const t of store.get()) scheduleDismiss(t.id);
}

export const useToasts = () => store.use((state) => state);

export function resetToasts() {
  pauseToasts();
  store.reset();
}

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom is a pretend browser and leaves out several APIs the UI libraries call. These are the
// smallest stand-ins that let components mount; they do not try to imitate real behaviour.

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// A fake matchMedia that behaves like the real one for "prefers-reduced-motion": `matches` is
// live, and listeners are told when it changes. Motion reads the value once and then relies on
// the change event, so a fake that never fires it would make reduced-motion tests lie.
let reducedMotion = false;
const listeners = new Set<() => void>();

/** Simulates the visitor switching the operating system's "reduce motion" setting. */
export function setReducedMotion(value: boolean) {
  reducedMotion = value;
  for (const listener of [...listeners]) listener();
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => {
    const isMotionQuery = query.includes("prefers-reduced-motion");
    return {
      get matches() {
        return isMotionQuery ? reducedMotion : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => void (isMotionQuery && listeners.add(listener)),
      removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
      addListener: (listener: () => void) => void (isMotionQuery && listeners.add(listener)),
      removeListener: (listener: () => void) => void listeners.delete(listener),
      dispatchEvent: vi.fn(),
    };
  },
});

class Observer {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = () => [];
}
vi.stubGlobal("IntersectionObserver", Observer);
vi.stubGlobal("ResizeObserver", Observer);

Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn(() => false);
Element.prototype.releasePointerCapture = vi.fn();

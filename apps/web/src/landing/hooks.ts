import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** A mouse or trackpad. False on phones and tablets, where hover effects and a custom cursor make no sense. */
export const useFinePointer = () => useMedia("(hover: hover) and (pointer: fine)");

/** Wide enough for the pinned, side-by-side layouts. */
export const useDesktop = () => useMedia("(min-width: 768px)");

/**
 * True while the element is on screen AND the tab is visible. Every looping demo on the landing
 * page is gated on this, so nothing ticks for a section nobody is looking at.
 */
export function useActive<T extends Element>(margin = "0px"): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let inView = false;
    const apply = () => setActive(inView && !document.hidden);
    const observer = new IntersectionObserver(
      (entries) => {
        inView = entries.some((entry) => entry.isIntersecting);
        apply();
      },
      { rootMargin: margin },
    );
    observer.observe(el);
    document.addEventListener("visibilitychange", apply);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", apply);
    };
  }, [margin]);

  return [ref, active];
}

/** Becomes true the first time the element comes near the viewport, and stays true. */
export function useNear<T extends Element>(margin = "600px"): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: margin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [margin, near]);

  return [ref, near];
}

/**
 * Types `text` one character at a time while `running`. Returns how many characters are shown.
 * `instant` (reduced motion) shows everything at once.
 */
export function useTyped(text: string, running: boolean, options: { cps?: number; instant?: boolean } = {}): number {
  const { cps = 38, instant = false } = options;
  const [typed, setTyped] = useState({ text, count: 0 });
  // A new text starts again from zero. Adjusting during render avoids one frame of the old count.
  if (typed.text !== text) setTyped({ text, count: 0 });
  const count = typed.text === text ? typed.count : 0;

  useEffect(() => {
    if (instant || !running || count >= text.length) return;
    const timer = setTimeout(() => setTyped({ text, count: count + 1 }), 1000 / cps);
    return () => clearTimeout(timer);
  }, [text, count, running, cps, instant]);

  return instant ? text.length : count;
}

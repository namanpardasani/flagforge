import { useEffect, useRef } from "react";

/**
 * Pauses looping animations inside an element while it cannot be seen: either scrolled out of
 * view or in a background tab. It sets `data-paused="true"`, and one CSS rule (styles/index.css)
 * pauses every animation underneath. Nothing re-renders; the browser just stops doing the work.
 *
 * Why it matters: a shimmer left running offscreen still wakes the compositor 60 times a second,
 * which costs battery for something nobody is looking at.
 */
export function useOffscreenPause<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let inView = true;
    const apply = () => {
      el.dataset["paused"] = String(!inView || document.hidden);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        inView = entries.some((e) => e.isIntersecting);
        apply();
      },
      { rootMargin: "64px" },
    );
    observer.observe(el);
    document.addEventListener("visibilitychange", apply);
    apply();

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", apply);
    };
  }, []);

  return ref;
}

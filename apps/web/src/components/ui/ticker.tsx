import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { duration, easeOut } from "@/motion";

interface TickerProps {
  value: number;
  /** Minimum digits, zero-padded ("06"). Keeps the width steady as the number changes. */
  pad?: number;
  className?: string;
}

const format = (n: number, pad: number) => String(Math.round(n)).padStart(pad, "0");

/**
 * A number that counts to its new value instead of jumping.
 *
 * The in-between numbers are written straight into the DOM node on each frame; React is not asked
 * to re-render sixty times a second for a counter. Digits are tabular (equal width) and padded, so
 * the text around the number never shifts while it runs. With reduced motion it simply jumps.
 */
export function Ticker({ value, pad = 2, className }: TickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  const reduced = useReducedMotion();

  useEffect(() => {
    const node = ref.current;
    const from = shown.current;
    shown.current = value;
    if (!node || from === value) return;
    if (reduced) {
      node.textContent = format(value, pad);
      return;
    }
    const controls = animate(from, value, {
      duration: duration.base,
      ease: easeOut,
      onUpdate: (latest) => {
        node.textContent = format(latest, pad);
      },
    });
    return () => controls.stop();
  }, [value, pad, reduced]);

  return (
    <span ref={ref} className={cn("font-mono tabular-nums", className)}>
      {format(value, pad)}
    </span>
  );
}

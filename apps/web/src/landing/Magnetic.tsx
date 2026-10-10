import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import type { PointerEvent, ReactNode } from "react";
import { useFinePointer } from "./hooks";

/**
 * Wraps a button so it leans towards the cursor while hovered and springs back when left.
 * Transform only, driven by motion values (no renders while moving). Does nothing on touch or
 * with reduced motion.
 */
export function Magnetic({ children, strength = 0.28, className }: { children: ReactNode; strength?: number; className?: string }) {
  const fine = useFinePointer();
  const reduced = useReducedMotion();
  const enabled = fine && !reduced;
  const x = useSpring(useMotionValue(0), { stiffness: 320, damping: 22, mass: 0.6 });
  const y = useSpring(useMotionValue(0), { stiffness: 320, damping: 22, mass: 0.6 });

  const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    if (!enabled) return;
    const box = event.currentTarget.getBoundingClientRect();
    x.set((event.clientX - (box.left + box.width / 2)) * strength);
    y.set((event.clientY - (box.top + box.height / 2)) * strength);
  };
  const release = () => {
    x.set(0);
    y.set(0);
  };

  return (
    // The outer span stays put and listens; only the inner one moves. If the moving element
    // measured itself, its own shift would change the measurement and it would jitter.
    <span onPointerMove={onPointerMove} onPointerLeave={release} className={className ?? "inline-block"}>
      <motion.span style={{ x, y }} className="inline-block">
        {children}
      </motion.span>
    </span>
  );
}

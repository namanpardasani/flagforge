import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { spring } from "./tokens";

/**
 * Wraps the app once. `reducedMotion="user"` makes every motion component respect the operating
 * system's "reduce motion" setting: movement (transform and layout animation) is switched off,
 * while opacity fades remain, so the interface still communicates change without travelling.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={spring.snappy}>
      {children}
    </MotionConfig>
  );
}

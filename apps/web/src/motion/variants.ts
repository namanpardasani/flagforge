import type { Variants } from "motion/react";
import { duration, easeOut, spring, staggerStep } from "./tokens";

/**
 * Reusable variants. A variant is a named pose ("hidden", "show", "exit"); a parent can switch all
 * its children between poses at once. Every variant here changes ONLY transform and opacity.
 */

/** Content rising a few pixels into place. The default way anything appears. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: duration.base, ease: easeOut } },
  exit: { opacity: 0, y: -4, transition: { duration: duration.instant, ease: easeOut } },
};

/** Put on a parent: its children (using fadeUp etc.) appear one after another. */
export const stagger = (step: number = staggerStep, delay = 0): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: step, delayChildren: delay } },
  exit: { transition: { staggerChildren: step / 2, staggerDirection: -1 } },
});

/** Popovers and dialogs: a small scale so they feel attached to what opened them. */
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.97 },
  show: { opacity: 1, scale: 1, transition: spring.snappy },
  exit: { opacity: 0, scale: 0.98, transition: { duration: duration.instant, ease: easeOut } },
};

/** Side panels and drawers arriving from the right edge. */
export const slideInRight: Variants = {
  hidden: { opacity: 0, x: 24 },
  show: { opacity: 1, x: 0, transition: spring.gentle },
  exit: { opacity: 0, x: 16, transition: { duration: duration.quick, ease: easeOut } },
};

/** Route changes: quick and quiet, because navigation happens constantly. */
export const page: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: duration.quick, ease: easeOut } },
  exit: { opacity: 0, transition: { duration: duration.instant, ease: easeOut } },
};

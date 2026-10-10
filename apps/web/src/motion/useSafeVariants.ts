import { useReducedMotion, type Variants } from "motion/react";
import { duration } from "./tokens";

/** Opacity-only stand-in used when the visitor asked for less motion. */
const fadeOnly: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: duration.quick } },
  exit: { opacity: 0, transition: { duration: duration.instant } },
};

/** Picks the calm version of a variant when reduced motion is on. */
export function useSafeVariants(variants: Variants): Variants {
  return useReducedMotion() ? fadeOnly : variants;
}

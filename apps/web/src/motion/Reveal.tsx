import { motion, useReducedMotion, type HTMLMotionProps, type Variants } from "motion/react";
import { useSafeVariants } from "./useSafeVariants";
import { fadeUp, stagger } from "./variants";

type RevealProps = Omit<HTMLMotionProps<"div">, "variants" | "initial" | "animate" | "exit"> & {
  /** Which pose set to use. Defaults to fadeUp. */
  variants?: Variants;
  /** Animate only the first time it scrolls into view, instead of on mount. */
  whenInView?: boolean;
};

/**
 * The reduced-motion wrapper. Use this instead of writing `initial`/`animate` by hand:
 * it applies a named variant and automatically swaps it for a plain fade when the visitor
 * prefers reduced motion. Inside a <RevealGroup> it inherits the parent's timing instead.
 */
export function Reveal({ variants = fadeUp, whenInView = false, ...props }: RevealProps) {
  const safe = useSafeVariants(variants);
  return (
    <motion.div
      variants={safe}
      initial="hidden"
      exit="exit"
      {...(whenInView ? { whileInView: "show", viewport: { once: true, margin: "-10% 0px" } } : { animate: "show" })}
      {...props}
    />
  );
}

type RevealGroupProps = Omit<HTMLMotionProps<"div">, "variants" | "initial" | "animate" | "exit"> & {
  /** Seconds between children. Ignored (children appear together) under reduced motion. */
  step?: number;
  delay?: number;
};

/** Staggers its <RevealItem> children. */
export function RevealGroup({ step, delay, ...props }: RevealGroupProps) {
  const reduced = useReducedMotion();
  return <motion.div variants={stagger(reduced ? 0 : step, reduced ? 0 : delay)} initial="hidden" animate="show" exit="exit" {...props} />;
}

/** A child of <RevealGroup>: it has no initial/animate of its own, so the group drives it. */
export function RevealItem({ variants = fadeUp, ...props }: Omit<HTMLMotionProps<"div">, "variants"> & { variants?: Variants }) {
  return <motion.div variants={useSafeVariants(variants)} {...props} />;
}

import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/cn";
import { duration } from "@/motion";
import { useFlash, type FlashKind } from "@/stores/flash";

// A live update from elsewhere is the "big moment": ember, fading over 1.2s. Your own change is a
// brief acknowledgement. A production kill is marked in the danger colour.
const look: Record<FlashKind, { className: string; from: number; seconds: number }> = {
  remote: { className: "bg-ember", from: 0.3, seconds: 1.2 },
  local: { className: "bg-ink", from: 0.1, seconds: 0.6 },
  kill: { className: "bg-danger", from: 0.28, seconds: 0.8 },
};

/**
 * A colour wash over a row that just changed. Place it inside a `relative` container.
 * Only opacity animates. It reads the flash store by flag id, so when one flag changes only its
 * own row re-renders.
 */
export function RowFlash({ flagId }: { flagId: string }) {
  const current = useFlash(flagId);
  return (
    <AnimatePresence>
      {current && (
        <motion.span
          key={current.id}
          aria-hidden
          data-flash={current.kind}
          initial={{ opacity: look[current.kind].from }}
          animate={{ opacity: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: look[current.kind].seconds, ease: "easeOut" }}
          className={cn("pointer-events-none absolute inset-0", look[current.kind].className)}
        />
      )}
    </AnimatePresence>
  );
}

/** The mono "updated just now" tag that stays a few seconds after a live update arrives. */
export function UpdatedTag({ flagId, className }: { flagId: string; className?: string }) {
  const current = useFlash(flagId);
  const show = current?.kind === "remote";
  return (
    <AnimatePresence>
      {show && (
        <motion.span
          key="tag"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: duration.quick }}
          className={cn("caption whitespace-nowrap text-ember", className)}
        >
          updated just now
        </motion.span>
      )}
    </AnimatePresence>
  );
}

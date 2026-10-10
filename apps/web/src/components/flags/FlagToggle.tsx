import { AnimatePresence, motion } from "motion/react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { duration, easeOut, spring } from "@/motion";

interface FlagToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Read by screen readers, e.g. "Instant payouts in Production". */
  label: string;
  disabled?: boolean;
  /** Show the "on" / "off" text beside the switch. */
  showStatus?: boolean;
  className?: string;
}

/**
 * The flag switch.
 *
 * Accessibility comes from Radix Switch: it is a real `role="switch"` button, so Tab reaches it and
 * Space or Enter flips it, with no extra key handling here.
 *
 * Three small animations, each using only transform or opacity:
 *  - the thumb slides on a tight spring (interruptible: flip it twice quickly and it reverses);
 *  - "on" is an ember layer fading in over the track (the track colour itself never animates);
 *  - the bloom: when it turns ON, a soft ember disc expands from behind the thumb and fades out.
 *    It plays only on a real off-to-on change, never on first render.
 */
export function FlagToggle({ checked, onCheckedChange, label, disabled, showStatus = false, className }: FlagToggleProps) {
  const [bloom, setBloom] = useState(0);
  const previous = useRef(checked);

  useEffect(() => {
    if (checked && !previous.current) setBloom((n) => n + 1);
    previous.current = checked;
  }, [checked]);

  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <SwitchPrimitive.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
        className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-xs border bg-sunken disabled:opacity-40", checked ? "border-ember" : "border-hairline")}
      >
        <motion.span aria-hidden initial={false} animate={{ opacity: checked ? 1 : 0 }} transition={{ duration: duration.instant }} className="absolute inset-0 rounded-[1px] bg-ember" />

        <AnimatePresence>
          {bloom > 0 && (
            <motion.span
              key={bloom}
              aria-hidden
              data-bloom
              initial={{ opacity: 0.6, scale: 0.3 }}
              animate={{ opacity: 0, scale: 1.7 }}
              transition={{ duration: 0.55, ease: easeOut }}
              onAnimationComplete={() => setBloom(0)}
              className="pointer-events-none absolute -right-2.5 top-1/2 size-10 -translate-y-1/2 bg-[radial-gradient(circle,var(--color-ember)_0%,transparent_68%)]"
            />
          )}
        </AnimatePresence>

        <SwitchPrimitive.Thumb asChild>
          <motion.span
            initial={false}
            animate={{ x: checked ? 18 : 2 }}
            transition={spring.snappy}
            className={cn("relative block size-3.5 rounded-[1px]", checked ? "bg-canvas" : "bg-muted")}
          />
        </SwitchPrimitive.Thumb>
      </SwitchPrimitive.Root>

      {showStatus && (
        // Fixed width so the row does not shift between "on" and "off".
        <span aria-hidden className="relative inline-block w-6 font-mono text-xs">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={checked ? "on" : "off"}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: duration.instant }}
              className={cn("block", checked ? "text-ink" : "text-faint")}
            >
              {checked ? "on" : "off"}
            </motion.span>
          </AnimatePresence>
        </span>
      )}
    </span>
  );
}

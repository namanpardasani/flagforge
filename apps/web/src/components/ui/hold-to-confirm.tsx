import { animate, motion, useMotionValue, useTransform, type AnimationPlaybackControls, type MotionValue } from "motion/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { easeOut } from "@/motion";

export const HOLD_MS = 700;

interface HoldToConfirmProps {
  onConfirm: () => void;
  children: ReactNode;
  /** Shown while the ring is filling. */
  holdingLabel?: string;
  tone?: "danger" | "ink";
  holdMs?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * A button that only fires after being HELD. Used for anything that changes Production, so a
 * stray click or a stray Enter can never flip a live flag.
 *
 *  - Hold with the mouse, a finger, or by keeping Space or Enter down.
 *  - A ring fills while held. Let go early and it rewinds; nothing happens.
 *  - It fires once, when the ring completes.
 *
 * `progress` is a MotionValue (0 to 1): a number Motion can animate WITHOUT re-rendering React.
 * The ring reads it directly, so the fill runs at full frame rate with zero component renders.
 */
export function HoldToConfirm({ onConfirm, children, holdingLabel = "Keep holding", tone = "danger", holdMs = HOLD_MS, disabled, className }: HoldToConfirmProps) {
  const progress = useMotionValue(0);
  const controls = useRef<AnimationPlaybackControls | null>(null);
  const [holding, setHolding] = useState(false);
  const [done, setDone] = useState(false);
  const hintId = useId();

  useEffect(() => () => controls.current?.stop(), []);

  const start = () => {
    if (disabled || done || holding) return;
    setHolding(true);
    controls.current?.stop();
    // Continue from wherever the ring is, so a quick release-and-press does not restart from zero.
    controls.current = animate(progress, 1, {
      duration: (holdMs / 1000) * (1 - progress.get()),
      ease: "linear",
      onComplete: () => {
        setDone(true);
        setHolding(false);
        onConfirm();
      },
    });
  };

  const cancel = () => {
    if (done || !holding) return;
    setHolding(false);
    controls.current?.stop();
    controls.current = animate(progress, 0, { duration: 0.08 + 0.22 * progress.get(), ease: easeOut });
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId); // keep receiving "up" even if the pointer drifts off
    start();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault(); // stop the browser's own click-on-Enter, which would bypass the hold
    if (!event.repeat) start();
  };
  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key === "Enter") cancel();
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled || done}
        aria-describedby={hintId}
        data-holding={holding}
        onPointerDown={onPointerDown}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={cancel}
        // A plain click must do nothing: only a completed hold confirms.
        onClick={(event) => event.preventDefault()}
        className={cn(
          "inline-flex h-8 shrink-0 select-none items-center gap-2.5 rounded-sm border px-3 text-sm font-medium disabled:opacity-40",
          tone === "danger" ? "border-danger/50 text-danger hover:bg-danger/10" : "border-line-strong text-ink hover:bg-raised",
          className,
        )}
      >
        <Ring progress={progress} />
        <span>{done ? "Done" : holding ? holdingLabel : children}</span>
      </button>
      {/* Outside the button, so it is read as a description and not as part of the button's name. */}
      <span id={hintId} className="sr-only">
        Press and hold for {(holdMs / 1000).toFixed(1)} seconds to confirm. Releasing early cancels.
      </span>
    </>
  );
}

const ARC = { stroke: "currentColor", strokeWidth: 2, fill: "none" } as const;

/**
 * The filling ring, drawn with rotation only (no stroke animation, per design/MOTION.md).
 * Two windows each show one half of the circle. A half-ring starts hidden on the opposite side
 * and rotates into view: the right window over the first half of the hold, the left over the second.
 */
function Ring({ progress }: { progress: MotionValue<number> }) {
  const first = useTransform(progress, [0, 0.5], [0, 180], { clamp: true });
  const second = useTransform(progress, [0.5, 1], [0, 180], { clamp: true });
  return (
    <span aria-hidden className="relative block size-[18px] shrink-0">
      <svg viewBox="0 0 18 18" className="absolute inset-0 opacity-25">
        <circle cx="9" cy="9" r="7" {...ARC} />
      </svg>
      <span className="absolute inset-y-0 right-0 w-1/2 overflow-hidden">
        <motion.span style={{ rotate: first }} className="absolute right-0 top-0 block size-[18px]">
          <svg viewBox="0 0 18 18">
            <path d="M9 16 A7 7 0 0 1 9 2" {...ARC} />
          </svg>
        </motion.span>
      </span>
      <span className="absolute inset-y-0 left-0 w-1/2 overflow-hidden">
        <motion.span style={{ rotate: second }} className="absolute left-0 top-0 block size-[18px]">
          <svg viewBox="0 0 18 18">
            <path d="M9 2 A7 7 0 0 1 9 16" {...ARC} />
          </svg>
        </motion.span>
      </span>
    </span>
  );
}

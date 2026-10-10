import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { easeOut } from "@/motion";
import { markBooted } from "./boot-session";

/** Counting time. With the wipe that follows, the whole sequence is about 1.2 seconds. */
const COUNT_MS = 850;
const WIPE_S = 0.4;

const STEPS = [
  { at: 0, text: "reading ruleset" },
  { at: 34, text: "hashing users into buckets" },
  { at: 68, text: "opening stream" },
] as const;

interface BootProps {
  /** The wipe has started: the hero can begin its own entrance underneath. */
  onReveal: () => void;
  /** The overlay is gone and can be unmounted. */
  onGone: () => void;
}

/**
 * Boot-sequence preloader. A fixed overlay, so it takes no space in the page and cannot shift the
 * layout. The page underneath is already rendered; this only covers it. Any key, a click or the
 * Skip button ends it early.
 */
export function Boot({ onReveal, onGone }: BootProps) {
  const [percent, setPercent] = useState(0);
  const [wiping, setWiping] = useState(false);
  const revealed = useRef(false);

  const finish = useCallback(() => {
    if (revealed.current) return;
    revealed.current = true;
    markBooted();
    setPercent(100);
    setWiping(true);
    onReveal();
  }, [onReveal]);

  useEffect(() => {
    const started = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const progress = Math.min(1, (now - started) / COUNT_MS);
      setPercent(Math.round(progress * 100));
      if (progress < 1) frame = requestAnimationFrame(tick);
      else finish();
    });
    window.addEventListener("keydown", finish);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", finish);
    };
  }, [finish]);

  return (
    <motion.div
      role="status"
      aria-label="Loading FlagForge"
      data-boot
      onClick={finish}
      initial={false}
      animate={{ y: wiping ? "-100%" : "0%" }}
      transition={{ duration: WIPE_S, ease: easeOut }}
      onAnimationComplete={() => wiping && onGone()}
      className="fixed inset-0 z-[80] flex flex-col justify-between border-b border-line-strong bg-canvas p-6 font-mono text-xs text-muted md:p-10"
    >
      <p className="caption text-faint">FlagForge / boot</p>
      <div className="space-y-1.5" aria-hidden>
        {STEPS.map((step) => (
          <p key={step.text} className={percent >= step.at ? undefined : "invisible"}>
            <span className="text-faint">&gt;</span> {step.text}
            <span className="text-faint"> {".".repeat(34 - step.text.length)} </span>
            <span className={percent >= step.at + 30 ? "text-ink" : "invisible"}>ok</span>
          </p>
        ))}
        <p className="pt-3 text-2xl text-ink md:text-4xl">
          forging flags... <span className="tabular-nums">{String(percent).padStart(3, " ")}%</span>
        </p>
      </div>
      <div className="flex items-center justify-between">
        <span className="caption text-faint">any key to skip</span>
        <button type="button" onClick={finish} className="caption text-muted hover:text-ink">
          Skip
        </button>
      </div>
    </motion.div>
  );
}

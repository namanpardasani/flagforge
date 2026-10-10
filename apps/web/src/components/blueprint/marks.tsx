import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** "FIG 0.1" style caption: a mono label that numbers a section like a figure in a manual. */
export function FigCaption({ index, label, className, ...props }: ComponentProps<"p"> & { index: string; label?: string }) {
  return (
    <p className={cn("caption flex items-center gap-2 text-faint", className)} {...props}>
      <span>FIG {index}</span>
      {label && (
        <>
          <span aria-hidden className="h-px w-4 bg-hairline" />
          <span className="text-muted">{label}</span>
        </>
      )}
    </p>
  );
}

/** One static film-grain layer over the whole viewport. Purely decorative, never animated. */
export function Grain() {
  return <div aria-hidden className="grain pointer-events-none fixed inset-0 z-[90]" />;
}

/** Faint drafting grid behind marketing surfaces. Do not use inside the dashboard. */
export function GridLines({ className }: { className?: string }) {
  return <div aria-hidden className={cn("grid-lines pointer-events-none absolute inset-0", className)} />;
}

/**
 * The small square that shows state.
 *  - `on` + `emphasis` (default): ember. Reserved for "live in the environment you are looking at".
 *  - `on` without emphasis: muted. On, but somewhere else (another environment's column).
 *  - off: faint.
 * Keeping ember this rare is what lets one glance answer "what is live right now?".
 */
export function LiveDot({ on = true, emphasis = true, className }: { on?: boolean; emphasis?: boolean; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-[1px]", !on ? "bg-faint" : emphasis ? "bg-ember" : "bg-muted", className)} />;
}

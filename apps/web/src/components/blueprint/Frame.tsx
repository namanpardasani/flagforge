import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const corners = ["-left-[5px] -top-[5px]", "-right-[5px] -top-[5px]", "-left-[5px] -bottom-[5px]", "-right-[5px] -bottom-[5px]"];

/** Four small registration crosses sitting exactly on a box's corners, like marks on a technical drawing. */
export function Crosshairs({ className }: { className?: string }) {
  return (
    <>
      {corners.map((position) => (
        <span key={position} aria-hidden className={cn("pointer-events-none absolute size-[9px]", position, className)}>
          <i className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-faint" />
          <i className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-faint" />
        </span>
      ))}
    </>
  );
}

type FrameProps = ComponentProps<"div"> & {
  /** Corner crosses. On by default; turn off for frames nested inside another frame. */
  marks?: boolean;
};

/**
 * The basic surface of the app: a hairline box with crosshair corners.
 * No shadow and no blur; depth comes from the line, not from light.
 * The crosses sit outside the box, so a Frame must not be placed inside `overflow-hidden`.
 */
export function Frame({ marks = true, className, children, ...props }: FrameProps) {
  return (
    <div className={cn("relative rounded-xs border border-hairline bg-raised/50", className)} {...props}>
      {marks && <Crosshairs />}
      {children}
    </div>
  );
}

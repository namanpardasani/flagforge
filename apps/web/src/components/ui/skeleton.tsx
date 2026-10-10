import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { useOffscreenPause } from "@/motion";

/**
 * A placeholder block with a light band sweeping across it.
 * The band is a child element moved with `transform: translateX`, not an animated
 * `background-position`, so the browser can run it on the compositor without repainting.
 */
export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return (
    <span aria-hidden className={cn("relative block overflow-hidden rounded-xs bg-raised", className)} {...props}>
      <span className="absolute inset-0 animate-sweep bg-[linear-gradient(90deg,transparent,var(--color-hairline),transparent)]" />
    </span>
  );
}

/**
 * Wrap a group of skeletons in this. It announces "loading" to screen readers once (instead of
 * once per block) and pauses every sweep inside while the group is offscreen or the tab is hidden.
 */
export function SkeletonGroup({ label = "Loading", className, children, ...props }: ComponentProps<"div"> & { label?: string }) {
  const ref = useOffscreenPause<HTMLDivElement>();
  return (
    <div ref={ref} role="status" aria-busy="true" aria-label={label} className={className} {...props}>
      {children}
    </div>
  );
}

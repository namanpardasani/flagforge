import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** A keyboard key, e.g. <Kbd>K</Kbd>. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-hairline bg-sunken px-1 font-mono text-2xs text-muted", className)}
      {...props}
    />
  );
}


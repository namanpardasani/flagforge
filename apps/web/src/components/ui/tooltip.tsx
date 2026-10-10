import { Tooltip as TooltipPrimitive } from "radix-ui";
import { useState, type ReactNode } from "react";

export const TooltipProvider = TooltipPrimitive.Provider;

interface TooltipProps {
  label: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** Set false to keep it closed (e.g. when the label is already visible next to the icon). */
  enabled?: boolean;
}

/**
 * Small label on hover or keyboard focus. Used for icon-only controls such as the collapsed sidebar.
 *
 * When disabled it is forced closed rather than left out. Returning the bare child instead would
 * change the element tree, so React would destroy and rebuild the child every time `enabled`
 * flipped: a link would lose keyboard focus the moment the sidebar collapsed.
 */
export function Tooltip({ label, children, side = "right", enabled = true }: TooltipProps) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipPrimitive.Root open={enabled && open} onOpenChange={setOpen}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={8}
          className="z-50 rounded-xs border border-hairline bg-raised px-2 py-1 text-xs text-ink data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:duration-150"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

import { Switch as SwitchPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/**
 * On/off control built on Radix Switch (keyboard, focus and `role="switch"` come from Radix).
 * Squared rather than pill-shaped, to match the 2-4px shape language.
 *
 * Motion: the thumb moves with `transform`, and "on" is an ember layer fading in with `opacity`.
 * The track colour itself never animates, which keeps to the transform-and-opacity-only rule.
 */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "group relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-xs border border-hairline bg-sunken disabled:opacity-40",
        "data-[state=checked]:border-ember",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className="absolute inset-0 rounded-[1px] bg-ember opacity-0 transition-opacity duration-150 ease-out-quart group-data-[state=checked]:opacity-100"
      />
      <SwitchPrimitive.Thumb className="relative block size-3 translate-x-[2px] rounded-[1px] bg-muted transition-transform duration-150 ease-out-quart data-[state=checked]:translate-x-[16px] data-[state=checked]:bg-canvas" />
    </SwitchPrimitive.Root>
  );
}

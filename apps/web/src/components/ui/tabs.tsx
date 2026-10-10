import { motion } from "motion/react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { spring } from "@/motion";
import { Ticker } from "./ticker";

export interface TabItem {
  value: string;
  label: string;
  /** Optional count shown in mono after the label. */
  count?: number;
}

interface TabsProps {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  /** Names the tab list for screen readers. */
  label: string;
  children?: ReactNode;
  className?: string;
}

/**
 * Tabs with an underline that slides between items.
 *
 * Roles, arrow-key navigation and focus handling come from Radix Tabs. The sliding underline is
 * the shared-layout idea from Watermelon UI's "continuous-tabs": the active tab renders an element
 * with a `layoutId`, and when another tab becomes active Motion animates the one element from the
 * old position to the new one (using transforms, so it never triggers layout work).
 */
export function Tabs({ items, value, onValueChange, label, children, className }: TabsProps) {
  // Each Tabs instance needs its own id, or two tab bars on one page would share an underline.
  const id = useId();
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={className}>
      <TabsPrimitive.List aria-label={label} className="relative flex gap-6 border-b border-hairline">
        {items.map((item) => {
          const active = item.value === value;
          return (
            <TabsPrimitive.Trigger
              key={item.value}
              value={item.value}
              className={cn("relative -mb-px flex h-9 items-center gap-2 text-sm", active ? "text-ink" : "text-muted hover:text-ink")}
            >
              {item.label}
              {item.count !== undefined && <Ticker value={item.count} className="text-2xs text-faint" />}
              {active && <motion.span layoutId={`${id}-underline`} transition={spring.layout} className="absolute inset-x-0 bottom-0 h-px bg-ember" />}
            </TabsPrimitive.Trigger>
          );
        })}
      </TabsPrimitive.List>
      {children}
    </TabsPrimitive.Root>
  );
}

export const TabsContent = TabsPrimitive.Content;

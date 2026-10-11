import { createContext, useContext } from "react";
import type { Flag } from "@/api/types";

/**
 * Turn a flag on or off in the current environment, through the Production safety check.
 * Outside Production it happens at once. In Production it opens the hold-to-confirm dialog first.
 */
export type GuardedToggle = (flag: Flag, enabled: boolean) => void;

export const FlagGuardContext = createContext<GuardedToggle | null>(null);

export function useGuardedToggle(): GuardedToggle {
  const toggle = useContext(FlagGuardContext);
  if (!toggle) throw new Error("useGuardedToggle must be used inside <FlagGuard>");
  return toggle;
}

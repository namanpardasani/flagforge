import { useContext } from "react";
import { ShellContext, type ShellState } from "./shell-context";

/** Sidebar, environment and palette state. Must be used under <ShellProvider>. */
export function useShell(): ShellState {
  const state = useContext(ShellContext);
  if (!state) throw new Error("useShell must be used inside <ShellProvider>");
  return state;
}

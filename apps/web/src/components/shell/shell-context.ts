import { createContext } from "react";
import type { EnvKey } from "@/api/types";

export interface ShellState {
  collapsed: boolean;
  toggleCollapsed: () => void;
  env: EnvKey;
  setEnv: (env: EnvKey) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
}

export const ShellContext = createContext<ShellState | null>(null);

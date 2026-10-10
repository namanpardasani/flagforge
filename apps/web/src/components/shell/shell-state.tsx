import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EnvKey } from "@/mocks/data";
import { ShellContext } from "./shell-context";

const ENVS: readonly EnvKey[] = ["dev", "staging", "prod"];

/** localStorage can throw (private mode, blocked storage), so every access is guarded. */
function read<T>(key: string, parse: (raw: string) => T | undefined, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (parse(raw) ?? fallback);
  } catch {
    return fallback;
  }
}
function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The preference just will not survive a reload.
  }
}

/** UI state shared across the shell: sidebar width, the chosen environment and the command palette. */
export function ShellProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => read("ff.sidebar", (v) => v === "collapsed", false));
  const [env, setEnvState] = useState<EnvKey>(() => read("ff.env", (v) => ENVS.find((e) => e === v), "prod"));
  const [paletteOpen, setPaletteOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      write("ff.sidebar", current ? "open" : "collapsed");
      return !current;
    });
  }, []);

  const setEnv = useCallback((next: EnvKey) => {
    write("ff.env", next);
    setEnvState(next);
  }, []);

  // Ctrl+K (Cmd+K on macOS) opens the palette from anywhere, even while typing in a field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); // browsers use Ctrl+K for the address bar
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo(
    () => ({ collapsed, toggleCollapsed, env, setEnv, paletteOpen, setPaletteOpen }),
    [collapsed, toggleCollapsed, env, setEnv, paletteOpen],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

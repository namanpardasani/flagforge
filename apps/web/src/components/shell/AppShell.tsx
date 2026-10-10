import { AnimatePresence, motion } from "motion/react";
import { useLocation, useOutlet } from "react-router";
import { Grain } from "@/components/blueprint/marks";
import type { Crumb } from "@/components/ui/breadcrumbs";
import { page, spring } from "@/motion";
import { CommandPalette } from "./CommandPalette";
import { useShell } from "./use-shell";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * The dashboard frame: sidebar, divider, top bar, and the page area.
 *
 * Three boxes move when the sidebar collapses (sidebar, divider, content). Each has Motion's
 * `layout` prop, so the browser lays them out at their final size immediately and Motion plays
 * the change as a transform. `layoutDependency={collapsed}` tells Motion to re-measure ONLY when
 * the sidebar toggles, instead of on every render.
 *
 * The divider is its own 1px element rather than a border on the sidebar: a border would be
 * stretched while its box is being scaled, but a box that only changes position stays crisp.
 */
export function AppShell({ crumbs }: { crumbs?: readonly Crumb[] }) {
  const { collapsed } = useShell();
  const location = useLocation();
  // useOutlet returns the current child route as an element. AnimatePresence keeps the OLD
  // element mounted until its exit animation finishes, then shows the new one.
  const outlet = useOutlet();

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-sm focus:border focus:border-ink focus:bg-raised focus:px-3 focus:py-1.5">
        Skip to content
      </a>

      <Sidebar />
      <motion.span aria-hidden layout layoutDependency={collapsed} transition={spring.layout} className="w-px shrink-0 bg-hairline" />

      <motion.div layout layoutDependency={collapsed} transition={spring.layout} className="min-w-0 flex-1">
        <motion.div layout="position" layoutDependency={collapsed} transition={spring.layout} className="flex h-dvh flex-col">
          <TopBar crumbs={crumbs} />
          <motion.main id="main" layoutScroll tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={location.pathname} variants={page} initial="hidden" animate="show" exit="exit" className="mx-auto w-full max-w-6xl px-6 py-8 lg:px-10">
                {outlet}
              </motion.div>
            </AnimatePresence>
          </motion.main>
        </motion.div>
      </motion.div>

      <CommandPalette />
      <Grain />
    </div>
  );
}

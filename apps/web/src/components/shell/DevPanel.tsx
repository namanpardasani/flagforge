import { Radio } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { setFailNextWrite, simulateRemoteChange } from "@/mocks/api";
import { toast } from "@/stores/toasts";
import { useShell } from "./use-shell";
import { useScope } from "./use-scope";

/**
 * Development-only controls for things that normally need a second person or a broken server.
 * Not rendered in a production build (see AppShell).
 */
export function DevPanel() {
  const { env } = useShell();
  const scope = useScope();
  const [open, setOpen] = useState(false);
  const [failNext, setFailNext] = useState(false);

  const simulate = () => {
    const change = simulateRemoteChange(scope.projectKey, env);
    if (!change) toast("Nothing to update", { detail: "This project has no flags." });
  };

  return (
    // Docked under the top bar on the right: clear of the toasts (bottom right) and of the sticky
    // "unsaved changes" bar at the bottom of the flag page.
    <aside aria-label="Developer tools" className="absolute right-4 top-14 z-30 flex flex-col items-end rounded-xs border border-dashed border-line-strong bg-canvas">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="caption flex h-7 items-center gap-2 px-2.5 text-muted hover:text-ink">
        <Radio className="size-3.5" strokeWidth={1.5} /> Dev
      </button>
      {open && (
        <div className="w-64 space-y-3 border-t border-dashed border-line-strong p-3">
          <div>
            <Button size="sm" onClick={simulate} className="w-full">
              Simulate remote update
            </Button>
            <p className="mt-1.5 text-xs leading-snug text-faint">Pretends a teammate changed a flag in {env}. The real version is driven by the SSE stream.</p>
          </div>
          <label className="flex items-start gap-2 text-xs leading-snug text-muted">
            <Checkbox
              className="mt-0.5"
              checked={failNext}
              onCheckedChange={(value) => {
                setFailNext(value === true);
                setFailNextWrite(value === true);
              }}
            />
            <span>Fail the next save (shows the optimistic change rolling back)</span>
          </label>
        </div>
      )}
    </aside>
  );
}

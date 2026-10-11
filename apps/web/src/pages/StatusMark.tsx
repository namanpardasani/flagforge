import type { Experiment } from "@/api/types";
import { LiveDot } from "@/components/blueprint/marks";

const STATUS_LABEL = { DRAFT: "Draft", RUNNING: "Running", STOPPED: "Stopped" } as const;

/** A small status mark. Ember only for RUNNING: that is the one that is live. */
export function StatusMark({ status }: { status: Experiment["status"] }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs text-muted">
      <LiveDot on={status === "RUNNING"} emphasis={status === "RUNNING"} className={status === "STOPPED" ? "bg-line-strong" : undefined} />
      {STATUS_LABEL[status]}
    </span>
  );
}

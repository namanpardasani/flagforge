import { describe, expect, it } from "vitest";
import { toAuditEntry } from "./adapters";

const row = (action: string, entityType: string, metadata: unknown) => ({ id: "a1", action, entityType, entityId: "e1", metadata, createdAt: "2026-10-11T10:00:00Z", actor: { name: "Mira Okafor" } });

describe("toAuditEntry", () => {
  it("describes experiment events by name, with the flag as the subject and the environment", () => {
    const meta = { name: "One-tap checkout", key: "one-tap-checkout", environmentKey: "prod", metricKey: "paid" };
    expect(toAuditEntry(row("experiment.created", "experiment", meta))).toMatchObject({ subject: "one-tap-checkout", env: "prod", detail: 'Created experiment "One-tap checkout"', actor: "Mira Okafor" });
    expect(toAuditEntry(row("experiment.started", "experiment", meta)).detail).toBe('Started experiment "One-tap checkout"');
    expect(toAuditEntry(row("experiment.stopped", "experiment", meta)).detail).toBe('Stopped experiment "One-tap checkout"');
    expect(toAuditEntry(row("experiment.deleted", "experiment", meta)).detail).toBe('Deleted experiment "One-tap checkout"');
  });

  it("describes scheduled changes: planned, applied, cancelled and failed", () => {
    const meta = { key: "checkout", environmentKey: "prod", runAt: "2026-10-12T09:00:00.000Z", change: { enabled: true, rolloutPercentage: 25 } };
    expect(toAuditEntry(row("flag.schedule_created", "flag", meta))).toMatchObject({ subject: "checkout", env: "prod", detail: "Scheduled for 12 Oct, 09:00 UTC: turn on, rollout 25%" });
    expect(toAuditEntry(row("flag.schedule_applied", "flag", meta)).detail).toBe("Scheduled change applied (planned for 12 Oct, 09:00 UTC)");
    expect(toAuditEntry(row("flag.schedule_cancelled", "flag", meta)).detail).toBe("Scheduled change cancelled (was for 12 Oct, 09:00 UTC)");
    expect(toAuditEntry(row("flag.schedule_failed", "flag", { ...meta, failure: "The person who scheduled this can no longer change flags" })).detail).toBe("Scheduled change failed: The person who scheduled this can no longer change flags");
    expect(toAuditEntry(row("flag.schedule_created", "flag", { key: "x" })).detail).toBe("Scheduled for later");
  });

  it("copes with missing metadata", () => {
    expect(toAuditEntry(row("experiment.started", "experiment", null))).toMatchObject({ subject: "e1", detail: "Started experiment experiment" });
  });

  it("still describes flag and API key events", () => {
    expect(toAuditEntry(row("flag.toggled", "flag", { key: "x", environmentKey: "dev", to: true })).detail).toBe("Turned on");
    expect(toAuditEntry(row("apikey.revoked", "api_key", { name: "worker", prefix: "ff_abc" }))).toMatchObject({ subject: "worker", detail: "Revoked key ff_abc…" });
  });
});

import type { ScheduledChange, ScheduledChangePatch } from "@/api/types";

/** "Turn on, rollout 25%" for a planned change, in the words someone would use. */
export function describePatch(patch: ScheduledChangePatch): string {
  const parts: string[] = [];
  if (patch.enabled !== undefined) parts.push(patch.enabled ? "Turn on" : "Turn off");
  if (patch.rolloutPercentage !== undefined) parts.push(`${parts.length ? "r" : "R"}ollout ${patch.rolloutPercentage}%`);
  if (patch.rules !== undefined) parts.push(`${parts.length ? "" : "Set "}${patch.rules.length} ${patch.rules.length === 1 ? "rule" : "rules"}`);
  return parts.join(", ") || "No change";
}

/** A planned moment shown in the viewer's own time zone, with the zone named so nobody has to guess. */
export function formatLocal(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
}

/** What a <input type="datetime-local"> needs as its smallest value: one minute from now, in local time. */
export function earliestLocal(now = new Date()): string {
  const soon = new Date(now.getTime() + 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
}

export interface ScheduleForm {
  /** Value of a datetime-local input: wall-clock time in the viewer's zone, no offset. */
  when: string;
  turn: "keep" | "on" | "off";
  /** Text of a number input; empty means "do not change the rollout". */
  rollout: string;
}

/** Turns the form into what the server wants, or says what is wrong. The server checks everything again. */
export function buildSchedule(form: ScheduleForm, now = new Date()): { ok: true; runAt: string; change: ScheduledChangePatch } | { ok: false; problem: string } {
  if (!form.when) return { ok: false, problem: "Choose when it should happen." };
  const at = new Date(form.when); // read as the viewer's local time
  if (Number.isNaN(at.getTime())) return { ok: false, problem: "That date and time is not valid." };
  if (at.getTime() < now.getTime() + 60_000) return { ok: false, problem: "Choose a time at least a minute from now." };
  if (at.getTime() > now.getTime() + 366 * 86_400_000) return { ok: false, problem: "Choose a time within the next year." };

  const change: ScheduledChangePatch = {};
  if (form.turn !== "keep") change.enabled = form.turn === "on";
  if (form.rollout.trim() !== "") {
    const percentage = Number(form.rollout);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) return { ok: false, problem: "Rollout must be a number from 0 to 100." };
    if (Math.abs(percentage * 100 - Math.round(percentage * 100)) > 1e-6) return { ok: false, problem: "Rollout can have at most two decimals." };
    change.rolloutPercentage = percentage;
  }
  if (Object.keys(change).length === 0) return { ok: false, problem: "Choose what should change: turn it on or off, or set a rollout." };
  return { ok: true, runAt: at.toISOString(), change };
}

export const statusLabel = (change: ScheduledChange) =>
  ({ PENDING: "Waiting", RUNNING: "Running now", APPLIED: "Applied", CANCELLED: "Cancelled", FAILED: "Failed" })[change.status];

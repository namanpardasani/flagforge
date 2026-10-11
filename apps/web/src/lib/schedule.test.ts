import { describe, expect, it } from "vitest";
import { buildSchedule, describePatch, earliestLocal } from "./schedule";

// A fixed "now", so the tests do not depend on the clock. Local time, as a datetime-local input is.
const now = new Date(2026, 9, 11, 12, 0, 0);
const at = (hours: number, minutes = 0) => {
  const t = new Date(now.getTime() + hours * 3_600_000 + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
};

describe("describePatch", () => {
  it("says it the way a person would", () => {
    expect(describePatch({ enabled: true })).toBe("Turn on");
    expect(describePatch({ enabled: false })).toBe("Turn off");
    expect(describePatch({ rolloutPercentage: 25 })).toBe("Rollout 25%");
    expect(describePatch({ enabled: true, rolloutPercentage: 10 })).toBe("Turn on, rollout 10%");
    expect(describePatch({ rules: [{}, {}] })).toBe("Set 2 rules");
    expect(describePatch({ enabled: false, rules: [{}] })).toBe("Turn off, 1 rule");
    expect(describePatch({})).toBe("No change");
  });
});

describe("buildSchedule", () => {
  it("turns the form into an exact moment and a change", () => {
    const result = buildSchedule({ when: at(24), turn: "on", rollout: "25" }, now);
    expect(result).toEqual({ ok: true, runAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(), change: { enabled: true, rolloutPercentage: 25 } });
  });

  it("leaves out what was not asked for", () => {
    expect(buildSchedule({ when: at(2), turn: "off", rollout: "" }, now)).toMatchObject({ ok: true, change: { enabled: false } });
    const onlyRollout = buildSchedule({ when: at(2), turn: "keep", rollout: "50" }, now);
    expect(onlyRollout).toMatchObject({ ok: true, change: { rolloutPercentage: 50 } });
    expect(onlyRollout.ok && "enabled" in onlyRollout.change).toBe(false);
  });

  it("accepts the edges of the rollout range, and two decimals", () => {
    for (const rollout of ["0", "100", "12.5", "0.01"]) expect(buildSchedule({ when: at(2), turn: "keep", rollout }, now).ok).toBe(true);
  });

  it("explains what is wrong, in this order: time, then change", () => {
    const problem = (form: Parameters<typeof buildSchedule>[0]) => {
      const result = buildSchedule(form, now);
      return result.ok ? null : result.problem;
    };
    expect(problem({ when: "", turn: "on", rollout: "" })).toBe("Choose when it should happen.");
    expect(problem({ when: "not a date", turn: "on", rollout: "" })).toBe("That date and time is not valid.");
    expect(problem({ when: at(0), turn: "on", rollout: "" })).toBe("Choose a time at least a minute from now."); // "now", to the minute
    expect(buildSchedule({ when: at(0, 1), turn: "on", rollout: "" }, now).ok).toBe(true); // exactly a minute is allowed
    expect(problem({ when: at(-5), turn: "on", rollout: "" })).toBe("Choose a time at least a minute from now.");
    expect(problem({ when: at(24 * 400), turn: "on", rollout: "" })).toBe("Choose a time within the next year.");
    expect(problem({ when: at(2), turn: "keep", rollout: "" })).toMatch(/Choose what should change/);
    expect(problem({ when: at(2), turn: "keep", rollout: "101" })).toBe("Rollout must be a number from 0 to 100.");
    expect(problem({ when: at(2), turn: "keep", rollout: "-1" })).toBe("Rollout must be a number from 0 to 100.");
    expect(problem({ when: at(2), turn: "keep", rollout: "lots" })).toBe("Rollout must be a number from 0 to 100.");
    expect(problem({ when: at(2), turn: "keep", rollout: "12.345" })).toBe("Rollout can have at most two decimals.");
  });

  it("the earliest time offered is one minute from now, in local time", () => {
    expect(earliestLocal(now)).toBe(at(0, 1));
  });
});

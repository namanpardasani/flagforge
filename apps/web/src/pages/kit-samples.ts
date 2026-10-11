import type { Flag, FlagState } from "@/api/types";

/** Fixed sample rows for the UI kit page only. The kit shows components, not anyone's real data. */
const on = (rolloutPercentage = 100): FlagState => ({ enabled: true, rolloutPercentage, rules: [] });
const off: FlagState = { enabled: false, rolloutPercentage: 100, rules: [] };

export const SAMPLE_FLAGS: readonly Flag[] = [
  { id: "sample-1", projectId: "sample", key: "route-optimizer-v2", name: "Route optimizer v2", description: "", updatedAt: "2026-10-10T11:42:00Z", states: { prod: on(25) } },
  { id: "sample-2", projectId: "sample", key: "carrier-rate-cache", name: "Carrier rate cache", description: "", updatedAt: "2026-10-09T16:05:00Z", states: { prod: on() } },
  { id: "sample-3", projectId: "sample", key: "instant-payouts", name: "Instant payouts", description: "", updatedAt: "2026-10-09T09:18:00Z", states: { prod: off } },
  { id: "sample-4", projectId: "sample", key: "bulk-label-print", name: "Bulk label print", description: "", updatedAt: "2026-10-08T14:31:00Z", states: { prod: off } },
];

import { z } from "zod";
import { setFlagStateSchema } from "../flags/targeting.js";

const id = z.string().min(1).max(64);

/** Not sooner than this: a change must not be due before the request has even finished. */
export const MIN_LEAD_MS = 60_000;
/** Not later than this: a year is already a long time to trust a guess about what the flag should do. */
export const MAX_LEAD_MS = 366 * 24 * 3_600_000;
/** How many changes may wait for one flag in one environment. Stops a script from filling the table. */
export const MAX_PENDING_PER_TARGET = 20;

export const createScheduledChangeSchema = z
  .object({
    // An absolute moment with its offset ("2026-10-12T09:00:00+02:00" or "...Z"). A time with no
    // offset would depend on the server's clock zone, so it is refused.
    runAt: z.iso.datetime({ offset: true }),
    // Exactly the body of a normal flag-state update, validated by the same schema.
    change: setFlagStateSchema,
  })
  .strict();

export const scheduleTargetParams = z.object({ workspaceId: id, projectId: id, flagId: id, environmentId: id });
export const scheduledListParams = z.object({ workspaceId: id, projectId: id });
export const scheduledChangeParams = z.object({ workspaceId: id, projectId: id, changeId: id });
export const scheduledListQuery = z.object({ status: z.enum(["pending", "history"]).default("pending"), flagId: id.optional() });

export type CreateScheduledChangeInput = z.infer<typeof createScheduledChangeSchema>;

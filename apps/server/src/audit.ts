import type { Prisma } from "../generated/prisma/client.js";

export interface AuditEntry {
  workspaceId: string;
  /** Null when the person who caused it no longer exists (e.g. a change they scheduled long ago). */
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Prisma.InputJsonValue;
}

/** Call inside the same transaction as the change it records, so both succeed or both fail. */
export async function writeAudit(tx: Prisma.TransactionClient, entry: AuditEntry) {
  await tx.auditLog.create({ data: entry });
}

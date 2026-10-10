import type { Prisma } from "../generated/prisma/client.js";

export interface AuditEntry {
  workspaceId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Prisma.InputJsonValue;
}

/** Call inside the same transaction as the change it records, so both succeed or both fail. */
export async function writeAudit(tx: Prisma.TransactionClient, entry: AuditEntry) {
  await tx.auditLog.create({ data: entry });
}

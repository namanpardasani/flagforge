import type { Role } from "../../generated/prisma/client.js";

const RANK: Record<Role, number> = { OWNER: 4, ADMIN: 3, MEMBER: 2, VIEWER: 1 };

/** True when `role` is at least as powerful as `min`. */
export function hasRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

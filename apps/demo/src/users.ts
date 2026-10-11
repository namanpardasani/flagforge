import type { EvaluationContext } from "@flagforge/sdk";

/**
 * Pretend customers of the demo shop. Each has a stable `key` (which decides their place in a
 * percentage rollout) and a few attributes (which targeting rules can match on).
 */
export interface DemoUser {
  id: string;
  name: string;
  context: EvaluationContext;
}

export const USERS: readonly DemoUser[] = [
  { id: "ingrid", name: "Ingrid", context: { key: "user-ingrid", attributes: { plan: "pro", country: "NO", depot: "OSL", tenureMonths: 14 } } },
  { id: "tomasz", name: "Tomasz", context: { key: "user-tomasz", attributes: { plan: "free", country: "PL", depot: "WAW", tenureMonths: 7 } } },
  { id: "saoirse", name: "Saoirse", context: { key: "user-saoirse", attributes: { plan: "pro", country: "IE", depot: "DUB", tenureMonths: 2 } } },
  { id: "kenji", name: "Kenji", context: { key: "user-kenji", attributes: { plan: "beta", country: "JP", depot: "BGO", tenureMonths: 30 } } },
];

export const findUser = (id: string | null) => USERS.find((user) => user.id === id);

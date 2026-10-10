import type { AttributeValue, Attributes, Condition } from "./types.js";

/** An array attribute (e.g. groups) is treated as "any element". Scalars are a list of one. */
function candidates(actual: AttributeValue): Array<string | number | boolean> {
  return Array.isArray(actual) ? actual : [actual];
}

/**
 * Does one condition match these attributes?
 * Rules worth knowing:
 *  - A MISSING attribute never matches, even for not_equals / not_in. "We know nothing about this
 *    user" must not accidentally satisfy a negative rule.
 *  - Types are never coerced: the number 5 does not equal the string "5".
 *  - Operators applied to the wrong type (e.g. gt on a string) simply do not match.
 */
export function matchCondition(condition: Condition, attributes: Attributes | undefined): boolean {
  // Own properties only: "constructor" or "__proto__" must not resolve to inherited Object members.
  const actual =
    attributes && Object.hasOwn(attributes, condition.attribute) ? attributes[condition.attribute] : undefined;
  if (actual === undefined) return false;
  const { operator, value } = condition;

  switch (operator) {
    case "equals":
      return !Array.isArray(value) && candidates(actual).some((a) => a === value);
    case "not_equals":
      return !Array.isArray(value) && !candidates(actual).some((a) => a === value);
    case "in":
      return Array.isArray(value) && candidates(actual).some((a) => value.some((v) => v === a));
    case "not_in":
      return Array.isArray(value) && !candidates(actual).some((a) => value.some((v) => v === a));
    case "contains":
      if (typeof value !== "string") return false;
      if (typeof actual === "string") return actual.includes(value);
      return Array.isArray(actual) && actual.includes(value);
    case "starts_with":
      return typeof actual === "string" && typeof value === "string" && actual.startsWith(value);
    case "ends_with":
      return typeof actual === "string" && typeof value === "string" && actual.endsWith(value);
    case "gt":
      return typeof actual === "number" && typeof value === "number" && actual > value;
    case "gte":
      return typeof actual === "number" && typeof value === "number" && actual >= value;
    case "lt":
      return typeof actual === "number" && typeof value === "number" && actual < value;
    case "lte":
      return typeof actual === "number" && typeof value === "number" && actual <= value;
    default:
      return false; // unknown operator from a newer server: fail closed
  }
}

import type { FlagConfig } from "@flagforge/core";
import type { ConfigSnapshot } from "./types.js";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isBps = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10000;

/**
 * Checks the shape of a config before we trust it. A bad response (proxy error page, truncated
 * body, version mismatch) must never replace a good cached config, so we throw instead.
 * Unknown operators are NOT rejected here: core fails closed on them, so a newer server stays usable.
 */
export function parseSnapshot(body: unknown): ConfigSnapshot {
  if (!isObject(body)) throw new Error("config is not an object");
  const env = body["environment"];
  if (!isObject(env) || typeof env["id"] !== "string" || typeof env["key"] !== "string") {
    throw new Error("config.environment is invalid");
  }
  const flags = body["flags"];
  if (!Array.isArray(flags)) throw new Error("config.flags is not an array");

  for (const f of flags) {
    if (!isObject(f) || typeof f["key"] !== "string" || typeof f["enabled"] !== "boolean") {
      throw new Error("a flag is malformed");
    }
    if (!isBps(f["fallthroughBps"]) || !Array.isArray(f["rules"])) throw new Error(`flag ${f["key"]} is malformed`);
    for (const r of f["rules"] as unknown[]) {
      if (!isObject(r) || typeof r["id"] !== "string" || !isBps(r["rolloutBps"]) || !Array.isArray(r["conditions"])) {
        throw new Error(`a rule in flag ${f["key"]} is malformed`);
      }
      for (const c of r["conditions"] as unknown[]) {
        if (!isObject(c) || typeof c["attribute"] !== "string" || typeof c["operator"] !== "string" || !("value" in c)) {
          throw new Error(`a condition in flag ${f["key"]} is malformed`);
        }
      }
    }
  }
  return { environment: { id: env["id"], key: env["key"] }, flags: flags as FlagConfig[] };
}

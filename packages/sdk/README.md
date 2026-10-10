# @flagforge/sdk

Server-side SDK for FlagForge. It downloads your flag configuration once, keeps it fresh in the
background, and evaluates flags **locally** (no network call per check).

```ts
import { FlagForgeClient, FileStorage } from "@flagforge/sdk";

const flags = new FlagForgeClient({
  apiKey: process.env.FLAGFORGE_API_KEY!, // environment key, starts with ff_. Server-side only.
  baseUrl: "https://flags.example.com",
  storage: new FileStorage("/var/cache/myapp/flags.json"), // optional: survive restarts during an outage
});

await flags.init(); // never throws; check the result if you care
if (flags.isEnabled("new-checkout", { key: user.id, attributes: { plan: user.plan } })) {
  // new code path
}
```

## How it behaves

| Situation | What happens |
|---|---|
| Normal | Config is cached in memory. A real-time stream (SSE) announces changes, so they arrive within moments (about 25ms on a local machine). Polling stays on as a safety net: every 30s normally, every 5 min while the stream is healthy, always with `If-None-Match` (unchanged = tiny 304 response). |
| Stream drops | Reconnects with exponential backoff and jitter. Every reconnect starts with the server's current version, so changes missed while disconnected are fetched immediately. Meanwhile polling returns to the normal rate. A silent connection (no heartbeat for 60s) is treated as dead and replaced. |
| Server says the stream is degraded | The server sends a `degraded` event when its own event feed is broken (e.g. it lost Redis). The stream stays open but is no longer trusted: polling returns to the normal rate (`status.streamDegraded`) until the server announces recovery with a fresh version. |
| Too many streams for one key (429) | The client keeps working through polling and keeps retrying the stream. |
| Server unreachable at startup | Falls back to the on-disk copy (`storage`), then `bootstrap`, then your default value. Polling keeps retrying and switches to live data when the server returns. |
| Server goes down later | Keeps serving the last known config (availability over freshness). Retries with exponential backoff and jitter. |
| Bad or garbled response | Ignored. A good cached config is never replaced by an invalid one. |
| API key revoked (401/403) | The server closes the key's streams at once. Streaming and polling stop (`status.fatal`), the last config keeps being served, an `error` event fires. |

`evaluate()` / `isEnabled()` never throw. `defaultValue` is used only when no decision can be made
(not ready, unknown flag, missing user key). A known flag that is simply off returns `false`.

## API

- `new FlagForgeClient({ apiKey, baseUrl, streaming?, pollIntervalMs?, streamPollIntervalMs?, streamIdleTimeoutMs?, requestTimeoutMs?, maxBackoffMs?, storage?, bootstrap?, allowInsecureHttp? })` (`streaming` defaults to true)
- `await client.init()` -> `{ ready, source: "network" | "storage" | "bootstrap" | "none" }`
- `client.isEnabled(flagKey, user, defaultValue = false)` -> `boolean`
- `client.evaluate(flagKey, user, defaultValue = false)` -> `{ value, reason, ruleId? }`
  (`reason`: `OFF`, `RULE_MATCH`, `FALLTHROUGH`, `FLAG_NOT_FOUND`, `NOT_READY`, `ERROR`)
- `client.allFlags(user)`, `client.refresh()`, `client.close()`
- `client.status` -> `{ ready, source, stream: "off" | "connecting" | "connected" | "disconnected", version?, consecutiveFailures, lastSuccessAt?, fatal }`
- `client.on("ready" | "update" | "error", listener)` returns an unsubscribe function

`user` is `{ key: string, attributes?: Record<string, string | number | boolean | string[]> }`.
`key` must be a stable id: it decides which percentage-rollout bucket the user is in.

## Safety notes

- Never put the API key in browser code. Anyone could read your targeting rules with it.
- Plain `http://` is refused for non-local hosts, so the key is not sent in clear text.
- Error messages never include the API key or request URL.
- `FileStorage` writes with mode `0600` because the cache contains your targeting rules.

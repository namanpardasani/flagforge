# FlagForge Notes

Running log of decisions, tradeoffs, failure answers, and interview Q&A.

## Environment (Day 1)
- Windows + WSL2 (Ubuntu), repo at ~/flagforge
- Node, npm, pnpm via nvm; Docker Desktop with WSL integration
- Postgres: postgres:17-bookworm (Postgres 18 failed in this environment)
- Redis: redis:7 (Redis 8 failed in this environment)
- Docker Desktop proxy set to "No proxy" to fix Docker Hub pull errors
- Ports bound to 127.0.0.1 only, so nothing on the network can reach the dev DB

## Decisions
| Decision | Why |
|---|---|
| Postgres volume at /var/lib/postgresql/data | Postgres 17 stores data there; the old path bypassed the named volume |
| Rollout bucket = hash(flagKey + userId) mod 10000 | Finer than mod 100, allows 12.5% rollouts |
| Server-side SDK first, browser SDK later | Browser code is public, so full targeting rules would leak |
| SSE vs Socket.IO for SDK streaming | **SSE.** Updates only flow server -> SDK, so a one-way stream is enough. SSE is a normal HTTP response that stays open: no extra dependency, no handshake, passes through proxies/load balancers, and any language can implement a client with a plain HTTP library. Socket.IO adds a custom protocol, a client library and sticky-session needs for two-way messaging we do not use. Trade-offs accepted: text only, one direction, and browsers cap SSE connections per host (irrelevant for server SDKs) |
| Tenant integrity | Nothing in the DB prevents an Environment pointing at a Project from another workspace (workspaceId and projectId are separate columns). This is enforced in application code plus tenant-isolation tests. Implemented: projects are always fetched by {id, workspaceId}, and a new Environment copies workspaceId from that verified project (never from the request body). Possible later hardening: a composite foreign key (projectId, workspaceId) -> Project(id, workspaceId) so the DB itself rejects mismatches (needs a schema change). |
| Auth tokens | Access JWT (HS256, 15 min, algorithm pinned) plus opaque refresh token (7 days, stored as SHA-256 hash, rotated on each use; reuse of an old token revokes all the user's tokens). Refresh uses an atomic updateMany so two simultaneous refreshes cannot both succeed |
| Login errors | Same 401 for unknown email and wrong password, with a dummy bcrypt compare so timing matches. Register returns 409 on duplicate email (accepted enumeration trade-off for usability) |
| Tests use a separate DB | flagforge_test, guarded by name (must end in _test), tables truncated between tests; dev DB is never touched by tests |
| Stream is a doorbell, not a data pipe | The stream only says "environment X is now at version N"; the SDK then refetches through the ETag endpoint. The database stays the single source of truth, so a lost, duplicated or reordered event cannot corrupt anything; the SDK only compares version numbers. Pushing full configs would duplicate state, bloat fan-out and complicate auth |
| Config versioning | Environment.configVersion is bumped by one atomic UPDATE ... RETURNING inside the same transaction as the change (so version and data commit together, and concurrent changes never share a number). A flag create/delete bumps every environment of the project; a toggle/targeting change bumps one; renames and no-op saves bump nothing. /sdk/v1/flags reads the version BEFORE the flags: if a change lands in between, the flags are newer than the label and the SDK just refetches once more (the other order could label old flags with a new version and lose the update) |
| Events are published after commit | A listener that refetches immediately must see the change. Publishing is best-effort (failures swallowed): the change is already committed, and SDKs fall back to polling |
| No lost updates around connect | The server subscribes to the bus BEFORE reading the current version, queues anything that arrives meanwhile, sends hello(version), then sends queued events newer than the hello. Every connection starts with a hello, so a reconnecting SDK learns about changes it missed |
| SDK catch-up | An in-flight fetch that started before a change commits can return stale data, so after an event the SDK keeps fetching (up to 6 times, backing off) until it has the announced version. Bursts are coalesced. Hello with a DIFFERENT (even older, e.g. DB restored) version also triggers a resync |
| Stream resource limits | Heartbeat comment every 25s (keeps proxies from closing idle connections; the SDK treats 60s of silence as dead). Max 50 streams per key and 2000 total (429 beyond that, SDK falls back to polling). Slow consumers (64KB unread) are dropped. Revoking a key closes its streams immediately via the bus; streams also re-check their key every 60s, so a missed event or another instance still drops them. Shutdown ends all streams so server.close() cannot hang |
| Polling is a safety net while streaming | 5-minute poll while the stream is healthy, normal poll while it is down. Setting pollIntervalMs to 0 disables polling entirely and relies on stream + reconnect resync |
| Measured propagation latency | Median 24-26ms from the management API call to the SDK seeing the change (3 runs of 25 changes each, one local machine, includes the HTTP request itself). This is localhost only; real networks and a hosted free-tier server will be slower |
| Verified on the real process | Started the actual server on the test DB, opened a live SSE stream with curl, saw hello + change + heartbeat events over a real socket, then sent SIGTERM: the server exited in 0.11s and the stream client was disconnected (no hang from open streams). Note for scripts: signal the node process, not the npx/tsx wrapper |
| SDK evaluates locally | The SDK downloads the whole environment config and evaluates in-process with @flagforge/core: zero network calls per flag check, and flags keep working if the server is down. Trade-off: changes reach SDKs on the next poll (30s default) until real-time push (Phase 8) |
| SDK availability over freshness | Server outage after a successful fetch: keep serving the last config. Startup outage: on-disk copy -> bootstrap -> caller's default. Invalid/garbled responses never replace a good config. 401/403 stop polling (a revoked key must not hammer the server) but the last config keeps serving |
| SDK polling | setTimeout chain (not setInterval) with +-10% jitter, exponential backoff capped at 5 min while failing, unref'd timer so polling never keeps a process alive, one in-flight request shared by concurrent refresh() calls |
| SDK safety | Refuses to send the API key over plain http to non-local hosts. Error messages never include the key or URL. FileStorage writes 0600 and atomically (temp file + rename). evaluate() never throws; defaultValue is used only when no decision is possible (a known OFF flag returns false) |
| Conditional GET is hand-written | Express's built-in ETag check never returns 304 when the client sends Cache-Control: no-cache, and Node's fetch adds that header automatically to any request with If-None-Match. Found by the end-to-end SDK test (the SDK's own stub server had hidden it). /sdk/v1/flags now computes a content ETag and compares If-None-Match itself (weak validators, lists, *) |
| Evaluation lives in packages/core | Pure, dependency-free functions (hash, condition matcher, evaluateFlag) shared by the server and every SDK, so they cannot disagree. A server test proves /evaluate equals running core locally on the downloaded config |
| Evaluation order | Kill switch (disabled -> false) -> rules in order, first match wins, each with its own rollout -> fallthrough rollout. Boolean flags only for now |
| Bucketing | bucket = murmur3("flagKey:userKey") mod 10000; user is IN a rollout when bucket < bps (exclusive). Pure-JS hash (no node:crypto) so browsers get identical results. Buckets are pinned in tests: changing the hash would reshuffle every user. Flag keys cannot contain ":" so key/user boundaries never collide. Verified against published test vectors and an independent Python implementation |
| Rollouts are monotonic | Same user, same flag, same bucket: raising 10% -> 20% only adds users. Different flags bucket independently |
| Missing attributes | A missing attribute never matches any operator, including not_equals/not_in ("unknown user" must not satisfy a negative rule). No type coercion (5 != "5"). Attribute lookup uses own properties only (no "constructor"/"__proto__" surprises) |
| Targeting storage | FlagState.rules is JSON in core's Rule shape, fallthroughBps an int (basis points, 12.5% = 1250). Management API speaks percentages (max 2 decimals); SDK payload speaks bps. Input is strictly validated (operator/value type pairs, max 20 rules, 10 conditions) and re-validated when read back |
| Targeting audit | flag.targeting_updated stores before/after rules and rollout; toggles stay a separate flag.toggled entry; no-op updates log nothing |
| SDK endpoints | GET /sdk/v1/flags (full config for local evaluation), POST /sdk/v1/evaluate, POST /sdk/v1/evaluate-all. All authenticated by API key; tenant/project/environment come from the key, never the request |
| Default environments | Creating a project also creates dev, staging and prod in the same transaction (a project never exists half-built). Environments are ordered by (createdAt, id) because rows inserted together can share a timestamp |
| API keys | Format ff_ + 192 random bits, one key per environment. Only the SHA-256 hash is stored (fast hash is fine because keys are random, unlike passwords). The full key is returned once at creation; lists show only a prefix. ADMIN+ manage keys. Revocation is immediate (checked on every request). The key itself identifies tenant + environment, so SDK calls need no workspace id and cannot cross tenants |
| Two auth schemes | User JWT for the dashboard/management API, API key for /sdk/*. Neither is accepted on the other's routes |
| Flags model | Boolean flags per project. FlagState holds one row per (flag, environment); no row means off, so new environments need no backfill. Flag key is unique per project and immutable. Flag/FlagState/AuditLog all carry workspaceId and every query filters on it |
| Flag permissions | Read: VIEWER+. Create/edit/toggle: MEMBER+. Delete flag and read audit log: ADMIN+ |
| Audit log | Each change writes an AuditLog row in the same DB transaction as the change (all or nothing). Toggles are logged only when the value really changes. actorId is SET NULL if the user is deleted, so history survives |
| Project/environment permissions | Read: VIEWER and up. Create/delete projects and environments: ADMIN and up (structure changes are rarer and riskier than flag edits, which MEMBER will get later) |
| Workspace permissions | Roles OWNER > ADMIN > MEMBER > VIEWER, enforced by requireWorkspaceRole middleware on the backend. Non-members get 404 (not 403) so other tenants' workspaces are invisible. Only OWNER grants/revokes/removes ADMIN; OWNER cannot be assigned, changed or removed (transfer is a later feature); members can leave. Member targets are looked up by (workspaceId, userId), so ids from other tenants are "not found" |

## Free-tier limits (checked 2026-10-09)
| Service | Limit | Implication |
|---|---|---|
| Neon (Postgres) | 0.5 GB storage, 100 CU-hours/month per project, scales to zero after 5 min idle, 6h restore window | Aggregate experiment events; first query after idle is slow |
| Upstash (Redis) | 256 MB, 500K commands/month, 10K cmds/sec | Run k6 against local Redis only; keep pub/sub and rate-limit commands lean |
| Render (backend) | 750 instance hours/month per workspace, sleeps after 15 min idle, cold start ~15s or longer | SSE drops on sleep; SDK must reconnect and resync; warm up before demos; keep a video |
| Vercel (frontend) | Hobby: 100 GB transfer, 1M edge requests, non-commercial only | Fine for a portfolio project |
| Fly.io | 7-day trial, then card required | Dropped |

## What happens if X fails (fill in as we build)
- Postgres down:
- Redis down:
- Server down (SDK side):

## Interview Q&A (fill in after each feature)

## Open items
- packages/core is consumed as TypeScript source (exports point at src/index.ts). Fine for tsx/Vitest/tsc; the production server build (node dist/...) must bundle it, e.g. with esbuild. Handle in the deploy phase.
- Rate limiting on /sdk and /auth is planned with Redis.
- The event bus is in-memory, so real-time works with ONE server instance. Phase 9 adds a Redis implementation of the EventBus interface so several instances can share events (until then, other instances' SDKs fall back to polling).
- On a free-tier host that sleeps when idle (Render), open streams drop when it sleeps; the SDK reconnects and resyncs via hello when it wakes.


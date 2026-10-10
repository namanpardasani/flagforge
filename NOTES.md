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
| SSE vs Socket.IO for SDK streaming | Decide in Week 2 |
| Tenant integrity | Nothing in the DB prevents an Environment pointing at a Project from another workspace (workspaceId and projectId are separate columns). This is enforced in application code plus tenant-isolation tests. |
| Auth tokens | Access JWT (HS256, 15 min, algorithm pinned) plus opaque refresh token (7 days, stored as SHA-256 hash, rotated on each use; reuse of an old token revokes all the user's tokens). Refresh uses an atomic updateMany so two simultaneous refreshes cannot both succeed |
| Login errors | Same 401 for unknown email and wrong password, with a dummy bcrypt compare so timing matches. Register returns 409 on duplicate email (accepted enumeration trade-off for usability) |
| Tests use a separate DB | flagforge_test, guarded by name (must end in _test), tables truncated between tests; dev DB is never touched by tests |

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
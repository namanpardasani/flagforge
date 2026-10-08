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

## Free-tier limits (verify and fill in)
| Service | Limit | Checked on |
|---|---|---|
| Neon (Postgres) | | |
| Upstash (Redis) | | |
| Render (backend) | | |
| Vercel (frontend) | | |

## What happens if X fails (fill in as we build)
- Postgres down:
- Redis down:
- Server down (SDK side):

## Interview Q&A (fill in after each feature)
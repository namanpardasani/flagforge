# FlagForge

A multi-tenant feature flag platform: put a release behind a flag, roll it out by percentage or by
targeting rules, and turn it off in one click. Changes reach running applications in real time.

Built as a portfolio project. Every design decision, with its reasoning and trade-offs, is written
down in [NOTES.md](NOTES.md).

![CI](https://github.com/namanpardasani/flagforge/actions/workflows/ci.yml/badge.svg)

## What it does

- **Flags per environment.** Each flag has its own state in dev, staging, prod, or environments you add.
- **Percentage rollouts.** A user's place in a rollout comes from a hash of the flag key and user
  key, so raising 20% to 30% only adds users and nobody flips back.
- **Targeting rules.** Match on user attributes (plan, country, and so on); the first matching rule decides.
- **Real-time updates.** A change reaches connected SDKs and open dashboards over Server-Sent
  Events, with polling as a safety net and a resync on every reconnect.
- **Server-side SDK.** Downloads the rules once and evaluates locally: a flag check is a function
  call, not a network request, and keeps working if FlagForge is unreachable.
- **Workspaces and roles.** Owner, admin, member and viewer, enforced on the server for every request.
  Tenants are isolated: every query is filtered by workspace.
- **Audit log.** Who changed what and where, written in the same transaction as the change.
- **Kill switch with a guard.** Any change in production needs a deliberate hold-to-confirm.

## How it fits together

```
 Dashboard (apps/web)          Your service
        |                            |  uses
        | REST + JWT                 v
        v                     SDK (packages/sdk) -- evaluates with --> packages/core
 API server (apps/server) <--- GET /sdk/v1/flags (ETag) ---|
        |       |          ---- SSE "version N" ---------->|
        |       +--> Redis: config cache, rate limits, pub/sub between instances (optional)
        v
   PostgreSQL: the single source of truth
```

The stream is a doorbell, not a data pipe: it only says "environment X is now at version N", and
the receiver fetches through the normal endpoint. A lost or repeated event cannot corrupt anything.

## Repository

| Path | What |
|---|---|
| `apps/server` | REST API: Express, TypeScript, Prisma, PostgreSQL, Redis |
| `apps/web` | Dashboard and landing page: React, Vite, Tailwind, TanStack Query, Motion |
| `apps/demo` | A small shop that uses the SDK, to watch a flag change live |
| `packages/core` | Pure evaluation logic (hashing, rules), shared by server and SDK so they cannot disagree |
| `packages/sdk` | Server-side SDK: local evaluation, streaming, polling, offline fallback |

## Run it locally

Needs Node 24, pnpm and Docker.

```bash
pnpm install
docker compose up -d                 # PostgreSQL 17 and Redis 7, bound to localhost only

cd apps/server
cp .env.example .env                 # then edit: database URLs and a long random JWT_ACCESS_SECRET
npx prisma generate
npx prisma migrate deploy            # creates the tables
npx tsx src/server.ts                # API on http://localhost:3000
```

In a second terminal:

```bash
cd apps/web
npx vite                             # dashboard on http://localhost:5173
```

Open http://localhost:5173, create an account, and follow the first-run setup. The landing page is
at http://localhost:5173/landing.

For the database URLs, `docker-compose.yml` creates the user `flagforge` and the database
`flagforge`. Tests need a second database whose name ends in `_test`:

```bash
docker exec flagforge-postgres createdb -U flagforge flagforge_test
```

### The demo shop

Create a flag with the key `one-tap-checkout` and an API key (API keys page) in the dashboard, then:

```bash
cd apps/demo
FLAGFORGE_API_KEY=ff_your_key npx tsx src/server.ts   # http://localhost:4000
```

Flip the flag in the dashboard and the checkout changes. See [apps/demo/README.md](apps/demo/README.md).

## Using the SDK

```ts
import { FlagForgeClient, FileStorage } from "@flagforge/sdk";

const flags = new FlagForgeClient({
  apiKey: process.env.FLAGFORGE_API_KEY!,
  baseUrl: "https://flags.example.com",
  storage: new FileStorage("./flags.cache.json"), // optional: survive a restart during an outage
});

await flags.init(); // never throws

if (flags.isEnabled("one-tap-checkout", { key: user.id, attributes: { plan: user.plan } })) {
  // new code path
}
```

More in [packages/sdk/README.md](packages/sdk/README.md).

## Tests

Each package has its own suite. The server tests run against a real PostgreSQL and Redis (the test
database is wiped between tests and must be named `*_test`); the web tests run the real API client
against an in-memory server that speaks the same wire format.

```bash
cd packages/core && npx vitest run
cd packages/sdk  && npx vitest run
cd apps/server   && npx vitest run     # needs docker compose up and TEST_DATABASE_URL / TEST_REDIS_URL
cd apps/web      && npx vitest run
cd apps/demo     && npx vitest run
```

CI runs all of them, plus typechecking, linting and a production build, on every push.

## Security notes

- Passwords are hashed with bcrypt; access tokens last 15 minutes; refresh tokens are single-use,
  stored only as hashes, and replaying an old one revokes the whole family.
- API keys are shown once and stored only as SHA-256 hashes.
- Non-members get 404, not 403, so the existence of other tenants' workspaces is not revealed.
- Rate limits use a token bucket in Redis (atomic Lua) with an in-memory fallback, so losing Redis
  never switches them off.
- Known limitations and what would be done before real users are listed under "Open items" in
  [NOTES.md](NOTES.md).

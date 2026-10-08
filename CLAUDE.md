# FlagForge: instructions for Claude Code

## What this is
FlagForge is a multi-tenant feature management and experimentation platform
(like a mini LaunchDarkly), built as a portfolio project. The owner is a
student who must be able to explain every part in interviews.

## Stack (do NOT change without asking)
- Monorepo with pnpm workspaces: apps/server, apps/web, packages/core, packages/sdk
- Backend: Node.js, Express, TypeScript (strict), Zod, Prisma, JWT, bcrypt
- Database: PostgreSQL 17 (postgres:17-bookworm). Cache: Redis 7.
- Frontend: React, TypeScript, Vite, Tailwind
- Do not upgrade Postgres or Redis versions.
- Do not touch Docker proxy settings.
- Everything must run on free tiers. No paid services.

## How to work
1. Before each feature, state the goal and explain the design briefly.
2. Work in small steps. One feature per prompt. Never dump the whole app.
3. Explain any new library or concept in simple words before using it.
4. Validate all external input with Zod.
5. Every tenant-owned query must filter by workspace_id.
   Permissions are enforced on the backend, never only in the UI.
6. Write tests for what you build, especially tenant isolation and permissions.
7. Never invent benchmark numbers. Only report numbers from real runs.
8. Do not recreate files that already exist. Do not run destructive commands
   (deleting volumes, force pushes) without asking first.
9. After finishing, summarize what changed and list 3 interview questions.

## Commands
- Start infra: docker compose up -d
- Check Postgres: docker exec flagforge-postgres pg_isready -U flagforge -d flagforge
- Check Redis: docker exec flagforge-redis redis-cli ping
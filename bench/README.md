# Benchmarks

Scripts that produce the numbers in [`docs/BENCHMARKS.md`](../docs/BENCHMARKS.md). Nothing here is
used by the application. Run everything against the **local** Docker services only: never against
Neon, Upstash or Render (the free tiers have monthly quotas).

```bash
docker compose up -d                 # PostgreSQL and Redis
pnpm bench:eval                      # 1. local evaluation speed (no server needed)
pnpm bench:server                    # leave running in terminal 1: bundled API, Redis on, rate limits off
pnpm bench:propagation               # 2. API call -> SDK value changed (1 and 50 SDKs)  [terminal 2]
pnpm bench:ramp                      # 3. load steps on GET /sdk/v1/flags (Node generator)
MODE=poll pnpm bench:ramp            #    the same for conditional polls (304)
pnpm bench:cache                     # 4. database reads with and without the Redis cache
pnpm bench:load                      # 3. the same load test with k6 (needs k6 installed)
pnpm bench:env                       # just print the environment record
```

Each script prints the machine and software it ran on first. Save the output with `| tee`, as the
files in `results/` were.

Settings: `FLIPS`, `CLIENTS` (propagation), `RATES`, `HOLD`, `MODE` (ramp), `REQUESTS` (cache),
`BASE_URL` (the server address; default `http://localhost:3070`).

How the numbers are measured, and why some are not comparable with others, is explained in
`docs/BENCHMARKS.md`. Short version: latency is counted from when a request was *due*, not when it
was sent, so a stalled sender cannot hide a slow server; the evaluation mean comes from timing a
whole batch while its percentiles come from timing each call.

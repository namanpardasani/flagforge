# Benchmarks

Measured on **one development laptop, on 2026-10-11**, with the server, PostgreSQL, Redis and the
load generator all on the same machine. Every number here comes from a real run whose raw output is
saved in [`bench/results/`](../bench/results). Nothing is estimated, rounded up or borrowed.

## Environment

| | |
|---|---|
| CPU | 11th Gen Intel Core i7-1165G7 @ 2.80 GHz (4 cores, 8 logical) |
| Memory | 7.6 GB (about 5 GB free during the runs) |
| OS | Ubuntu 26.04.1 LTS under WSL2 (WSL 3.0.1.0, kernel 6.18.40.1-microsoft-standard-WSL2) on Windows |
| Node.js | v24.21.0 |
| PostgreSQL | 17.11, `postgres:17-bookworm` in Docker (from `docker-compose.yml`) |
| Redis | 7.4.11, `redis:7` in Docker |
| Other load | Both containers idle before every run (PostgreSQL 0.0 to 0.3% CPU, Redis about 0.5%). The dev servers I had running earlier were stopped. The machine still ran the editor's background processes; load average was 1.5 to 1.7 before the runs |
| Server under test | The production **bundle** (`apps/server/dist/server.js`), one process, Redis on, rate limiting off (otherwise the benchmarks measure the limiter), started with `NODE_ENV=development`. Production mode refuses to start without a real email provider, and a benchmark must not send email. Nothing measured here behaves differently between the two settings |
| Generator | Node.js scripts in `bench/`. **k6 was not used**: it could not be installed in this environment, so the k6 script (`loadtest/sdk-config.js`) is written but has never been run |

## Results

| Metric | Result | How measured | Command to reproduce |
|---|---|---|---|
| Local flag evaluation, `evaluateFlag` in `packages/core` | **1.3 to 1.6 µs mean** per evaluation (about 620,000 to 780,000 per second on one core). Per call: p50 0.8 to 1.0 µs, p95 3.2 to 4.3 µs, p99 14.8 to 18.6 µs | 1,000,000 evaluations per run over 200,000 distinct users, after 200,000 warm-up calls; 5 runs, median run reported. Ruleset: 5 targeting rules (7 conditions) then a 20% rollout. Mean from timing the whole batch; percentiles from timing each call (including about 0.05 µs of timer cost). **Two sessions on the same day gave the ranges shown** (see below) | `pnpm bench:eval` |
| Same flag through the SDK, `client.evaluate` | **1.6 µs mean**; p50 1.0 µs, p95 4.0 to 4.1 µs, p99 17.7 to 18.4 µs | As above, through `FlagForgeClient` started from a bootstrap config (no network) | `pnpm bench:eval` |
| Update propagation, 1 connected SDK | **p50 24.9 ms, p95 32.6 ms, p99 39.7 ms, max 43.8 ms**; 0 of 100 flips missed | 100 flips through the real API (after 5 warm-ups). Clock starts before the request is sent and stops when `client.isEnabled` returns the new value. Polling was off in the SDK, so only the stream could deliver it. The API call alone took p50 22.4 ms | `pnpm bench:server`, then `pnpm bench:propagation` |
| Update propagation, 50 connected SDKs | **p50 44.3 ms, p95 88.6 ms, p99 114.2 ms, max 123.7 ms**; 0 of 5,000 deliveries missed. Slowest of the 50 per flip: p50 48.3 ms, p95 92.6 ms | As above, 50 `FlagForgeClient` instances, 100 flips. **All 50 clients run in the same Node process as the timer**, so they share one CPU core | `CLIENTS=50 pnpm bench:propagation` (default runs 1 and 50) |
| `GET /sdk/v1/flags` throughput, full response | **Stable at 3,000 requests/second**: p95 15.0 ms, p99 54.5 ms, 0 errors in 45,000 requests. Degrades at 4,000/s (p95 177.7 ms, p99 2.6 s, max 7.5 s, still 0 errors) | Fixed request rate in steps (100, 250, 500, 1,000, 1,500, 2,000, 3,000, 4,000/s), 15 s each, first 2 s discarded. Latency counted from when each request was due. 20 flags, 1,556-byte response, valid API key, Redis cache on. **Node generator, not k6** | `pnpm bench:server`, then `pnpm bench:ramp` |
| `GET /sdk/v1/flags` throughput, conditional poll (answered 304) | **Stable at 3,000 requests/second**: p95 8.6 ms, p99 17.3 ms, max 100 ms, 0 errors in 45,000. Degrades at 4,000/s (p95 159 ms, 3,583/s achieved). The 5,000/s step reached 4,449/s; at 6,000/s the generator itself was strained, so that step says nothing | As above with `If-None-Match`, which is what every SDK sends on each poll | `MODE=poll RATES=500,1000,2000,3000,4000,5000,6000 pnpm bench:ramp` |
| Database reads removed by the Redis cache | **99.9% fewer database operations** (3 against 3,000 for 1,000 requests); **99.86% fewer table scans** as counted by PostgreSQL itself (7 against 5,004) | 1,000 sequential `GET /sdk/v1/flags`, once with the cache on (starting empty) and once with it off. Counted two independent ways: operations issued by the server's Prisma client, and `pg_stat_user_tables` scans from PostgreSQL. `pg_stat_statements` would be the usual tool but the Docker image does not load it | `pnpm bench:cache` |
| k6 load test | **Not run** | The script exists: `loadtest/sdk-config.js` | `pnpm bench:load` (needs k6 installed) |

Raw output of every run: [`eval`](../bench/results/2026-10-11-eval.txt),
[`propagation`](../bench/results/2026-10-11-propagation.txt) (every flip's delay),
[`cache`](../bench/results/2026-10-11-cache.txt),
[`ramp, full`](../bench/results/2026-10-11-ramp-full.txt),
[`ramp, poll`](../bench/results/2026-10-11-ramp-poll.txt).

### The five evaluation runs (second session; the file above has the SDK table too)

```
packages/core evaluateFlag: 5 runs of 1,000,000 evaluations (after 200,000 warm-up calls each)
run | batch mean us | per-call mean | p50    | p95    | p99    | max us
  1 |         1.519 |         1.656 |  0.984 |  3.883 | 18.271 | 8370.584
  2 |         1.576 |         1.736 |  0.978 |  4.219 | 18.511 | 1755.655
  3 |         1.642 |         1.844 |  1.007 |  4.206 | 18.710 | 3300.905
  4 |         1.605 |         1.766 |  0.988 |  4.250 | 18.615 | 1606.162
  5 |         1.706 |         1.830 |  0.998 |  4.259 | 18.664 | 8696.521
median run (by batch mean): batch mean 1.605 us = 623,074 evaluations/second on one core
```

The **first session** (earlier the same day, output printed to the terminal but its file was
overwritten by this re-run) gave a median run of 1.279 µs batch mean, 0.823 µs p50, 3.216 µs p95 and
14.825 µs p99 for `core`, and 1.567 µs, 0.971 µs, 4.067 µs and 17.738 µs for the SDK. That 25%
spread between two sessions on one machine is real and is why the table shows ranges.

### The load ramps

```
Full response (200)                                       Conditional poll (304)
target | achieved | failed | p50 ms | p95 ms | p99 ms     target | achieved | failed | p50 ms | p95 ms | p99 ms
   100 |      100 |      0 |   13.4 |   14.8 |   15.3        500 |    499.9 |      0 |    4.1 |    5.5 |    6.2
   250 |    249.9 |      0 |    6.9 |    8.2 |    8.7       1000 |    999.9 |      0 |    3.4 |    5.1 |    6.3
   500 |    499.9 |      0 |    4.0 |    5.3 |    5.9       2000 |   1999.6 |      0 |    3.4 |    8.1 |   23.1
  1000 |    999.8 |      0 |    3.2 |    4.5 |    5.2       3000 |   2999.4 |      0 |    3.7 |    8.6 |   17.3
  1500 |   1499.7 |      0 |    3.4 |    6.1 |   13.1       4000 |   3583.3 |      0 |   19.4 |  159.0 | 3082.1
  2000 |   1999.8 |      0 |    3.2 |    4.9 |    7.4       5000 |   4448.8 |      0 |  920.2 | 1592.2 | 1724.0
  3000 |   2998.2 |      0 |    3.9 |   15.0 |   54.5       6000 |   4010.4 |      0 | 5033.3 | 7104.8 | 7317.9 (generator strained)
  4000 |   3984.0 |      0 |   35.0 |  177.7 | 2589.0
```

## Why some results look odd, and what they mean

- **The cache reduction is 99.9% because of how it is measured, not because it is magic.** After
  the first request fills the cache, a repeat request for the same key and environment never touches
  PostgreSQL, so 1,000 identical requests have a ceiling near 100%. Real traffic includes flag
  changes (each invalidates the cache) and key-cache expiries (60 s), so the real figure is lower and
  depends on how often flags change. The PostgreSQL-side count (5,004 scans for 3,000 operations)
  also shows each operation costs more than one table scan, so counting operations understates the
  saving.
- **Propagation is mostly the API call itself.** Sending the request and getting its response took
  22 ms at the median; the SDK had the new value 25 ms after the request was sent. The stream
  delivery, the SDK's refetch and the swap together added only about 2.5 ms on top. So "about
  25 ms" is the whole path *including* the API call, and the part specific to FlagForge's stream is
  small.
- **50 SDKs in one process is a pessimistic setup.** They compete for one core and each parses the
  new config. Fifty separate servers would each have their own core; the server-side work (one
  publish, 50 stream writes) is what this measures fairly.
- **The 100 requests/second step is slower than the 1,000/second step** (p50 13.4 ms against 3.2 ms).
  That is a cold-connection effect: at a low rate connections sit idle between requests and the
  first steps after warm-up still include JIT and socket set-up. It also makes the "baseline" for
  the degradation rule high, so the rule (p95 above three times the baseline) was lenient: the p99
  and maximum already rise at 3,000/s (p99 54 ms, max 301 ms on full responses), which is why I
  call 3,000/s the *last stable* step and not a comfortable one.
- **The server's ceiling is per-request work, not payload.** Conditional polls (no body) degrade at
  the same rate as full responses, so the limit is the single Node process doing key lookup, cache
  read and HTTP handling for each request, about 4,000 to 4,500 requests per second on this machine.
- **Evaluation numbers vary between sessions** (1.28 against 1.61 µs on the same machine, same code).
  Thermal state, other processes and CPU frequency account for it. The p99 and maximum (18 µs and
  up to 8.7 ms) are dominated by garbage collection and the operating system, not by flag logic.

## Limitations

- **One machine.** The server, PostgreSQL, Redis and the load generator share 4 physical cores, so
  every throughput figure is lower than the server would manage with the generator elsewhere.
- **Local network.** No internet latency, no TLS, no load balancer, no Render or Neon cold starts.
  A hosted free-tier deployment will be slower, and the free tiers add limits these runs never meet.
- **Synthetic data.** One workspace, one environment, 20 flags, one API key, 1,000 to 200,000 invented
  users. Real rulesets and traffic patterns differ.
- **The load generator is Node, not k6.** It is single-threaded; its own delay was measured and
  reported per step, and one step was discarded because of it.
- **Sample sizes are modest:** 100 flips per propagation scenario, 15-second load steps, 5 evaluation
  runs. Treat the second decimal digit as noise.
- **Propagation includes the API call** and (for 50 SDKs) client-side contention in one process.
- **Server mode:** `NODE_ENV=development` (see Environment).
- **Single process.** Multi-instance behaviour (Redis pub/sub between servers) was not benchmarked.

## Resume wording

I have not seen your resume, so these are wordings for the numbers rather than fills for your own
`XXX` placeholders. Each states what was measured and where.

- "Evaluates flags locally in the SDK in about **1.3 to 1.6 µs** per call (p95 under **5 µs**, over
  1,000,000 evaluations with a 5-rule ruleset) on a local development machine."
- "Propagates flag changes to a connected SDK in about **25 ms** at the median (**33 ms** p95) over
  server-sent events, measured from the API call to the SDK's in-memory value changing across 100 flips on a local
  development machine; **44 ms** median with 50 clients connected."
- "Sustained **3,000 requests/second** on the SDK config endpoint with p95 latency under **15 ms** and
  zero errors, degrading at 4,000/s, against local Docker PostgreSQL and Redis (single Node process,
  load generated on the same machine)."
- "Cut database reads on the SDK config endpoint by **99.9%** with a Redis cache (3 queries instead
  of 3,000 for 1,000 repeat requests)." Only use this with the qualifier "for repeat requests".

Wording to avoid: "k6" (it was not run), "production" for any of these numbers (they were measured
on one laptop), or any number from a single run without its range.

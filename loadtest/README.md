# Load tests

[k6](https://k6.io) scripts for the three hot paths:

| Scenario | Request | What it stands for |
|---|---|---|
| `sdkPoll` | `GET /sdk/v1/flags` with `If-None-Match` | Every SDK's routine "anything new?" check. Should be a 304 served from the Redis cache, with no database query |
| `sdkEvaluate` | `POST /sdk/v1/evaluate` | Server-side evaluation of one flag for one user |
| `dashboardRead` | `GET .../flags` with a user token | The dashboard loading a flag list. Reads PostgreSQL every time |

Each runs alone at a fixed request rate, one after another.

## Run

Local only. **Never point this at Neon, Upstash or Render**: the free tiers have monthly quotas
and this would burn through them.

```bash
docker compose up -d
cd apps/server
node build.mjs
# Rate limiting off (or the test measures the limiter); Redis on (or the cache is not exercised).
RATE_LIMIT_ENABLED=false REDIS_URL=redis://localhost:6379/1 LOG_LEVEL=warn NODE_ENV=production \
  node dist/server.js
```

In another terminal:

```bash
k6 run loadtest/flagforge.js                       # 200 requests/second per scenario, 20s each
k6 run -e RATE=1000 -e DURATION=30s loadtest/flagforge.js
```

`setup()` creates its own account, workspace, 20 flags and an API key through the public API, so
nothing needs preparing. It leaves a `load-...` workspace behind in the local database.

The thresholds in the script make k6 exit with an error if the 95th percentile is too slow, if
more than 1% of requests fail, or if k6 could not keep up the requested rate.

## Results

See "Load test results" in [NOTES.md](../NOTES.md). Numbers there are from real runs, with the
machine and settings stated. They describe one laptop, not a production deployment.

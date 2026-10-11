# FlagForge demo app

A pretend shop ("parcels.example") that uses the real FlagForge SDK. Open it beside the dashboard,
flip a flag, and watch the checkout change without reloading.

## Run it

1. Start the API (`apps/server`) and the dashboard (`apps/web`).
2. In the dashboard, create a flag with the key `one-tap-checkout`, then make an API key for one
   environment on the **API keys** page. Copy it: it is shown once.
3. Start the demo with that key:

   ```bash
   cd apps/demo
   FLAGFORGE_API_KEY=ff_your_key_here npx tsx src/server.ts
   ```

4. Open http://localhost:4000 next to the dashboard. Turn `one-tap-checkout` on in the environment
   the key belongs to. The checkout switches from the card form to "Pay in one tap".

Settings are environment variables; see `.env.example`.

## What it shows

| Try this in the dashboard | What happens here |
|---|---|
| Turn `one-tap-checkout` on or off | The checkout changes within moments; the row flashes |
| Set its rollout to 50% | Some of the four sample customers get it, some do not, and each keeps their answer |
| Add a rule: `plan` is `pro` | Ingrid and Saoirse (pro) get it; the "Why" column says a rule matched |
| Stop the API server | The demo keeps working from the last flags it had; the status says it is no longer live |
| Revoke the API key | The status turns to "api key rejected"; the last flags are still served |

## How it is put together

```
dashboard --> FlagForge API --(SSE: "version N")--> SDK (in this app's server)
                                                        |  evaluates locally, per customer
                                                        v
                                    this app's server --(SSE: decisions)--> the browser
```

- The API key and the SDK live in this app's **server**. A browser never receives the key or the
  targeting rules, only the answers ("on, because a rule matched").
- A flag check is a function call on data the SDK already holds. Serving a page makes no request
  to FlagForge.
- When the SDK reports an update, the server re-evaluates for each connected browser's customer
  and pushes the new answers over its own event stream.

## Files

| File | What |
|---|---|
| `src/server.ts` | Entry point: creates the SDK client, starts the HTTP server |
| `src/app.ts` | The HTTP server: page, event stream, health |
| `src/page.ts` | The page, its CSS and its browser script |
| `src/users.ts` | The four sample customers and their attributes |
| `src/config.ts` | Environment variables, validated at startup |

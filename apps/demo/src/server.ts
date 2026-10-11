import { FileStorage, FlagForgeClient } from "@flagforge/sdk";
import { createDemoApp } from "./app.js";
import { loadConfig } from "./config.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

// The same few lines any real service would write.
const flags = new FlagForgeClient({
  apiKey: config.FLAGFORGE_API_KEY,
  baseUrl: config.FLAGFORGE_URL,
  // Report who sees which checkout and who pays, so an experiment on the featured flag has data.
  sendEvents: true,
  // Survive a restart while FlagForge is unreachable: start from the last flags saved to disk.
  storage: new FileStorage(".flagforge-cache.json"),
});
flags.on("error", (error) => console.error(`[flagforge] ${error.message}`));

const started = await flags.init(); // never throws; `ready` says whether flags were loaded
console.log(started.ready ? `[flagforge] flags loaded from ${started.source}` : "[flagforge] no flags yet; serving defaults and retrying");

const app = createDemoApp({ flags, featuredFlag: config.FEATURED_FLAG });
app.server.listen(config.PORT, config.HOST, () => {
  console.log(`Demo shop: http://localhost:${config.PORT}  (featured flag: ${config.FEATURED_FLAG})`);
});

async function shutdown() {
  app.close();
  await flags.flush(); // do not lose the last few events
  flags.close();
  app.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

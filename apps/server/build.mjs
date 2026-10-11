// Builds the server into ONE file: dist/server.js.
//
// Why bundle at all: the workspace packages (@flagforge/core) are TypeScript source, and Node
// cannot run TypeScript from a dependency. Bundling compiles our own code, core included, into
// plain JavaScript. Packages from npm are left as normal imports and come from node_modules.
import { rm } from "node:fs/promises";
import { build } from "esbuild";
import pkg from "./package.json" with { type: "json" };

const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@flagforge/"));

await rm("dist", { recursive: true, force: true });
const result = await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external,
  sourcemap: true, // stack traces in production logs point at the original files
  metafile: true,
  logLevel: "warning",
});

const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`dist/server.js  ${(bytes / 1024).toFixed(0)} kB  (npm packages left external: ${external.length})`);

import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // "@/..." means "src/...", so imports do not turn into ../../../ chains.
    alias: { "@": path.resolve(root, "./src") },
  },
  server: {
    port: 5173,
    // The browser calls /api/... on this dev server, which forwards to the API. Same origin, so no
    // CORS setup is needed in development. In production set VITE_API_URL to the API's address.
    proxy: { "/api": { target: process.env["API_PROXY_TARGET"] ?? "http://localhost:3000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
    // Several tests measure real time (the 700ms hold, the boot count). Too many files at once
    // starves their timers on a busy machine, so run a few at a time and allow slow finds.
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});

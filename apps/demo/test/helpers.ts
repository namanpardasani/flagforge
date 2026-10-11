import type { AddressInfo } from "node:net";
import type { ClientStatus, EvaluationContext, EvaluationDetail } from "@flagforge/sdk";
import { createDemoApp, type DemoAppOptions, type FlagSource } from "../src/app.js";

/** A stand-in for the SDK client: tests decide what each user gets and when "the flags changed". */
export class FakeFlags implements FlagSource {
  decide: (user: EvaluationContext) => Record<string, EvaluationDetail> = () => ({});
  status: ClientStatus = { ready: true, source: "network", consecutiveFailures: 0, stream: "connected", streamDegraded: false, version: 1, fatal: false };
  #listeners = new Set<() => void>();

  allFlags(user: EvaluationContext) {
    return this.decide(user);
  }
  on(_event: "update", listener: () => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  /** What the SDK does when the flag configuration changes. */
  emitUpdate() {
    for (const listener of [...this.#listeners]) listener();
  }
  get listenerCount() {
    return this.#listeners.size;
  }
}

export async function start(options: Partial<DemoAppOptions> & { flags: FlagSource }) {
  const app = createDemoApp({ featuredFlag: "one-tap-checkout", heartbeatMs: 40, statusCheckMs: 20, ...options });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    app,
    url,
    async stop() {
      app.close();
      app.server.closeAllConnections();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    },
  };
}

export interface Viewer {
  status: number;
  /** Parsed `snapshot` events received so far. */
  snapshots: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any -- test data, shape asserted in tests
  /** Everything received, as raw text (heartbeats included). */
  raw: () => string;
  next: (count: number, timeoutMs?: number) => Promise<void>;
  closed: Promise<void>;
  close: () => void;
}

/** Opens the demo's event stream the way a browser would, and collects what arrives. */
export async function watch(url: string, user: string): Promise<Viewer> {
  const controller = new AbortController();
  const res = await fetch(`${url}/events?user=${encodeURIComponent(user)}`, { signal: controller.signal });
  const snapshots: unknown[] = [];
  let raw = "";
  const closed = (async () => {
    if (res.status !== 200 || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split("\n").find((line) => line.startsWith("data:"));
          if (block.includes("event: snapshot") && data) snapshots.push(JSON.parse(data.slice(5)));
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    status: res.status,
    snapshots,
    raw: () => raw,
    closed,
    close: () => controller.abort(),
    async next(count, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (snapshots.length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for snapshot ${count} (have ${snapshots.length})`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

export interface SseMessage {
  event?: string;
  id?: string;
  data?: string;
  /** Lines starting with ":" (our heartbeats). */
  comment?: string;
  retry?: string;
}

export interface OpenStream {
  status: number;
  headers: Headers;
  /** Every message received so far, in order (heartbeat comments included). */
  messages: SseMessage[];
  /** Messages that carry an event (not heartbeats). */
  events(): SseMessage[];
  /** Resolves with the next event-carrying message, or rejects after `timeoutMs`. */
  nextEvent(timeoutMs?: number): Promise<SseMessage>;
  /** Resolves when the server (or we) ended the stream. */
  closed: Promise<void>;
  close(): void;
  /** Version numbers from the `data` of received hello/change events. */
  versions(): number[];
}

export function parseBlock(block: string): SseMessage {
  const msg: SseMessage = {};
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) msg.comment = line.slice(1).trim();
    else if (line.startsWith("event:")) msg.event = line.slice(6).trim();
    else if (line.startsWith("id:")) msg.id = line.slice(3).trim();
    else if (line.startsWith("data:")) msg.data = (msg.data ? msg.data + "\n" : "") + line.slice(5).trim();
    else if (line.startsWith("retry:")) msg.retry = line.slice(6).trim();
  }
  return msg;
}

export async function openStream(url: string, apiKey?: string, extraHeaders: Record<string, string> = {}): Promise<OpenStream> {
  const controller = new AbortController();
  const headers: Record<string, string> = { Accept: "text/event-stream", ...extraHeaders };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers, signal: controller.signal });

  const messages: SseMessage[] = [];
  const waiters: Array<() => void> = [];
  let delivered = 0;
  const wake = () => waiters.splice(0).forEach((w) => w());

  const closed = (async () => {
    if (!res.body || res.status !== 200) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          messages.push(parseBlock(buffer.slice(0, index)));
          buffer = buffer.slice(index + 2);
          wake();
        }
      }
    } catch {
      // aborted or connection reset: treat as closed
    } finally {
      wake();
    }
  })();

  const events = () => messages.filter((m) => m.event !== undefined);
  return {
    status: res.status,
    headers: res.headers,
    messages,
    events,
    closed,
    close: () => controller.abort(),
    versions: () => events().map((m) => (JSON.parse(m.data ?? "{}") as { version: number }).version),
    async nextEvent(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const all = events();
        if (all.length > delivered) return all[delivered++]!;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timed out waiting for the next SSE event");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

/** Starts an Express app on a random local port. */
export async function listen(app: Express): Promise<{ url: string; server: Server; stop(): Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

import { ApiError, openStream } from "./client";

export type StreamStatus = "connecting" | "live" | "degraded" | "reconnecting";

export interface StreamHandlers {
  /** Sent at every (re)connection: the current version of each environment. */
  onHello: (versions: ReadonlyMap<string, number>) => void;
  onChange: (change: { environmentId: string; version: number }) => void;
  onStatus?: (status: StreamStatus) => void;
}

interface StreamOptions {
  /** No bytes (not even a heartbeat) for this long means the connection is dead. Server pings every 25s. */
  idleMs?: number;
  minRetryMs?: number;
  maxRetryMs?: number;
}

/** Reads "event:" / "data:" blocks out of a text stream. Blocks are separated by a blank line. */
export function createSseParser(onMessage: (event: string, data: string) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
        // Lines starting with ":" are heartbeats; "id:" and "retry:" are not needed here.
      }
      if (data.length > 0) onMessage(event, data.join("\n"));
    }
  };
}

/**
 * Keeps a live connection to one project's stream until `close()` is called.
 *
 * Why `fetch` and not the browser's EventSource: EventSource cannot send an Authorization header,
 * so the token would have to go in the URL (and into logs). Reading the response body by hand
 * lets the token travel in a header like every other request.
 *
 * Reconnecting: any end of the stream (network drop, server restart, the access token expiring,
 * 60 seconds of silence) leads to a new connection after a pause that doubles each time, with
 * some randomness so many tabs do not all return at once. The pause resets after a good
 * connection. Every new connection starts with a hello carrying current versions, which is how
 * the dashboard finds out what it missed while it was away.
 */
export function connectProjectStream(path: string, handlers: StreamHandlers, { idleMs = 60_000, minRetryMs = 1_000, maxRetryMs = 30_000 }: StreamOptions = {}): { close: () => void } {
  let closed = false;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let delay = minRetryMs;

  const status = (next: StreamStatus) => handlers.onStatus?.(next);

  const scheduleReconnect = () => {
    if (closed) return;
    status("reconnecting");
    const wait = delay * (0.75 + Math.random() * 0.5);
    delay = Math.min(maxRetryMs, delay * 2);
    retryTimer = setTimeout(() => void run(), wait);
  };

  const run = async () => {
    if (closed) return;
    controller = new AbortController();
    const { signal } = controller;
    const alive = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller?.abort(), idleMs);
    };

    try {
      const response = await openStream(path, signal);
      if (!response.body) throw new Error("no body");
      alive();

      const parse = createSseParser((event, data) => {
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          return; // a garbled message is ignored; the next hello puts things right
        }
        if (event === "hello") {
          const list = (payload as { environments?: unknown }).environments;
          if (!Array.isArray(list)) return;
          const versions = new Map<string, number>();
          for (const item of list as Array<{ environmentId?: unknown; version?: unknown }>) {
            if (typeof item.environmentId === "string" && typeof item.version === "number") versions.set(item.environmentId, item.version);
          }
          delay = minRetryMs; // a hello means the connection really works
          status("live");
          handlers.onHello(versions);
        } else if (event === "change") {
          const change = payload as { environmentId?: unknown; version?: unknown };
          if (typeof change.environmentId === "string" && typeof change.version === "number") handlers.onChange({ environmentId: change.environmentId, version: change.version });
        } else if (event === "degraded") {
          status("degraded");
        }
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        alive();
        parse(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      // Signed out, or no longer allowed to see this project: reconnecting cannot help.
      if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        closed = true;
      }
    } finally {
      clearTimeout(idleTimer);
    }
    scheduleReconnect();
  };

  status("connecting");
  void run();

  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(idleTimer);
      controller?.abort();
    },
  };
}

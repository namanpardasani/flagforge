import { FlagForgeError } from "./types.js";

/** What is sent to POST /sdk/v1/events. */
export type SdkEvent = { type: "exposure"; flagKey: string; userKey: string; value: boolean } | { type: "conversion"; metricKey: string; userKey: string };

export interface EventReporterOptions {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
  flushIntervalMs: number;
  requestTimeoutMs: number;
  /** Most events kept in memory. Beyond this the OLDEST are dropped, so memory cannot grow without limit. */
  maxQueue: number;
  onError: (error: FlagForgeError) => void;
}

/** The server accepts at most this many events in one request. */
const BATCH = 500;
/** How many (flag, user) pairs are remembered so the same exposure is not sent over and over. */
const SEEN_LIMIT = 20_000;

/**
 * Collects experiment events and sends them in batches, in the background.
 *
 * The rule that shapes everything here: a flag check must never wait for, or fail because of, the
 * network. So recording an event only appends to an in-memory list; a timer sends the list later.
 * If sending fails the events go back on the list for the next attempt, and if the list is full
 * the oldest are dropped and counted. Losing an event costs a little accuracy; blocking or
 * crashing the host application would cost far more.
 */
export class EventReporter {
  readonly #options: EventReporterOptions;
  #queue: SdkEvent[] = [];
  /** Exposures already reported, as "flag\0user" -> the value reported. Bounded; oldest forgotten first. */
  readonly #seen = new Map<string, boolean>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sending: Promise<void> | undefined;
  #stopped = false;
  #sent = 0;
  #dropped = 0;

  constructor(options: EventReporterOptions) {
    this.#options = options;
  }

  get stats() {
    return { queued: this.#queue.length, sent: this.#sent, dropped: this.#dropped };
  }

  /** "This user was shown this variant." Sent once per user per flag (again only if the value changes). */
  exposure(flagKey: string, userKey: string, value: boolean): void {
    if (this.#stopped) return;
    const key = `${flagKey}\0${userKey}`;
    if (this.#seen.get(key) === value) return;
    this.#seen.delete(key); // re-insert at the end, so the map drops the least recently added first
    this.#seen.set(key, value);
    if (this.#seen.size > SEEN_LIMIT) this.#seen.delete(this.#seen.keys().next().value!);
    this.#add({ type: "exposure", flagKey, userKey, value });
  }

  /** "This user did the thing being measured." */
  conversion(metricKey: string, userKey: string): void {
    if (this.#stopped) return;
    this.#add({ type: "conversion", metricKey, userKey });
  }

  #add(event: SdkEvent) {
    this.#queue.push(event);
    if (this.#queue.length > this.#options.maxQueue) {
      const excess = this.#queue.length - this.#options.maxQueue;
      this.#queue.splice(0, excess);
      this.#dropped += excess;
    }
    if (this.#queue.length >= BATCH) void this.flush(); // a full batch goes now, without waiting for the timer
    else this.#schedule();
  }

  #schedule() {
    if (this.#timer || this.#stopped || this.#options.flushIntervalMs <= 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#options.flushIntervalMs);
    this.#timer.unref?.(); // a pending flush must not keep the process alive
  }

  /** Sends everything queued now. Never rejects. Concurrent calls share one send. */
  flush(): Promise<void> {
    this.#sending ??= this.#flush().finally(() => {
      this.#sending = undefined;
    });
    return this.#sending;
  }

  async #flush(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, BATCH);
      const outcome = await this.#send(batch);
      if (outcome === "sent") {
        this.#sent += batch.length;
      } else if (outcome === "retry") {
        // Put the batch back at the FRONT (it is the oldest) and stop: the server is not answering.
        this.#queue.unshift(...batch);
        const excess = this.#queue.length - this.#options.maxQueue;
        if (excess > 0) {
          this.#queue.splice(0, excess);
          this.#dropped += excess;
        }
        this.#schedule();
        return;
      } else {
        // "drop": the server understood and refused (bad data, or a rejected key). Retrying cannot help.
        this.#dropped += batch.length;
        if (outcome === "stop") {
          this.#dropped += this.#queue.length;
          this.#queue = [];
          this.#stopped = true;
          return;
        }
      }
    }
  }

  async #send(events: SdkEvent[]): Promise<"sent" | "retry" | "drop" | "stop"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.requestTimeoutMs);
    try {
      const response = await this.#options.fetch(`${this.#options.baseUrl}/sdk/v1/events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });
      await response.arrayBuffer().catch(() => {}); // release the connection
      if (response.ok) return "sent";
      if (response.status === 401 || response.status === 403) {
        // Error messages never include the key or the URL.
        this.#options.onError(new FlagForgeError("events rejected: the API key is invalid or revoked", { status: response.status, fatal: true }));
        return "stop";
      }
      if (response.status === 429 || response.status >= 500) return "retry";
      this.#options.onError(new FlagForgeError(`events rejected by the server (${response.status})`, { status: response.status }));
      return "drop";
    } catch (cause) {
      this.#options.onError(new FlagForgeError("could not send events to FlagForge", { cause }));
      return "retry";
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Stops the timer and makes one last attempt to send what is queued. Nothing is recorded afterwards. */
  close(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const last = this.flush();
    this.#stopped = true;
    return last;
  }
}

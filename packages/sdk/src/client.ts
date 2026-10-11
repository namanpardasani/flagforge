import { evaluateFlag, type EvaluationContext, type FlagConfig } from "@flagforge/core";
import { EventReporter } from "./events.js";
import { parseSnapshot } from "./parse.js";
import { SseParser } from "./sse.js";
import {
  FlagForgeError,
  type ClientEvents,
  type ClientStatus,
  type ConfigSnapshot,
  type ConfigSource,
  type EvaluationDetail,
  type FlagForgeOptions,
  type StreamState,
} from "./types.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class FlagForgeClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #pollIntervalMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maxBackoffMs: number;
  readonly #streaming: boolean;
  readonly #streamPollIntervalMs: number;
  readonly #streamIdleTimeoutMs: number;
  readonly #options: FlagForgeOptions;
  readonly #fetch: typeof fetch;

  #flags = new Map<string, FlagConfig>();
  #snapshot: ConfigSnapshot | undefined;
  #etag: string | undefined;
  #version: number | undefined;
  #ready = false;
  #source: ConfigSource = "none";
  #lastSuccessAt: number | undefined;
  #failures = 0;
  #fatal = false;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inflight: Promise<boolean> | undefined;
  #abort: AbortController | undefined;
  #initPromise: Promise<{ ready: boolean; source: ConfigSource }> | undefined;

  readonly #events: EventReporter | undefined;

  #streamState: StreamState;
  #streamDegraded = false;
  #streamAbort: AbortController | undefined;
  readonly #sleepers = new Set<() => void>();
  #wantVersion = -1;
  #catchingUp = false;

  #listeners: { [K in keyof ClientEvents]: Set<ClientEvents[K]> } = {
    ready: new Set(),
    update: new Set(),
    error: new Set(),
  };

  constructor(options: FlagForgeOptions) {
    if (!options.apiKey) throw new Error("FlagForge: apiKey is required");
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new Error("FlagForge: baseUrl is not a valid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("FlagForge: baseUrl must be http(s)");
    if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname) && !options.allowInsecureHttp) {
      // The API key travels in a header; over plain http anyone on the network could read it.
      throw new Error("FlagForge: refusing to send the API key over plain http to a non-local host");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 300_000;
    this.#streaming = options.streaming ?? true;
    this.#streamPollIntervalMs = options.streamPollIntervalMs ?? 300_000;
    this.#streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 60_000;
    this.#streamState = this.#streaming ? "connecting" : "off";
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (options.sendEvents) {
      this.#events = new EventReporter({
        apiKey: this.#apiKey,
        baseUrl: this.#baseUrl,
        fetch: this.#fetch,
        flushIntervalMs: options.eventsFlushIntervalMs ?? 5_000,
        requestTimeoutMs: this.#requestTimeoutMs,
        maxQueue: options.maxQueuedEvents ?? 10_000,
        onError: (error) => this.#emit("error", error),
      });
    }
  }

  // ---- events -------------------------------------------------------------------------------

  /** Subscribe to "ready", "update" or "error". Returns a function that unsubscribes. */
  on<K extends keyof ClientEvents>(event: K, listener: ClientEvents[K]): () => void {
    this.#listeners[event].add(listener);
    return () => this.#listeners[event].delete(listener);
  }

  #emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>) {
    for (const listener of this.#listeners[event]) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch {
        // A buggy listener must never break flag evaluation or polling.
      }
    }
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  /**
   * Loads flags (network first, then storage, then bootstrap), starts background polling and, if
   * enabled, the real-time stream. Never rejects: check `ready` in the result. If it is false,
   * evaluations return your defaults until the first successful fetch, which keeps being retried.
   */
  init(): Promise<{ ready: boolean; source: ConfigSource }> {
    this.#initPromise ??= this.#init();
    return this.#initPromise;
  }

  async #init() {
    const ok = await this.refresh();
    if (!ok && !this.#ready) await this.#loadFallback();
    this.#schedule();
    if (this.#streaming && !this.#closed && !this.#fatal) void this.#streamLoop();
    return { ready: this.#ready, source: this.#source };
  }

  async #loadFallback() {
    try {
      const stored = await this.#options.storage?.load();
      if (stored) {
        this.#apply(stored.config, undefined); // no etag: force a full fetch next time
        this.#markReady("storage");
        return;
      }
    } catch {
      // storage is best-effort
    }
    if (this.#options.bootstrap) {
      try {
        this.#apply(parseSnapshot(this.#options.bootstrap), undefined);
        this.#markReady("bootstrap");
      } catch (err) {
        this.#emit("error", new FlagForgeError("bootstrap config is invalid", { cause: err }));
      }
    }
  }

  /** Fetches the config now. Resolves true on success (including "unchanged"), false on failure. */
  refresh(): Promise<boolean> {
    this.#inflight ??= this.#refresh().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #refresh(): Promise<boolean> {
    if (this.#closed) return false;
    try {
      await this.#fetchOnce();
      this.#failures = 0;
      this.#lastSuccessAt = Date.now();
      return true;
    } catch (err) {
      this.#failures++;
      const error =
        err instanceof FlagForgeError ? err : new FlagForgeError("could not reach FlagForge", { cause: err });
      if (error.fatal) this.#fatal = true;
      if (!this.#closed) this.#emit("error", error);
      return false;
    }
  }

  async #fetchOnce(): Promise<void> {
    const controller = new AbortController();
    this.#abort = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#requestTimeoutMs);

    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json" };
      if (this.#etag) headers["If-None-Match"] = this.#etag;

      let res: Response;
      try {
        res = await this.#fetch(`${this.#baseUrl}/sdk/v1/flags`, { headers, signal: controller.signal });
      } catch (err) {
        // Messages deliberately omit the URL and headers so the API key can never end up in logs.
        throw new FlagForgeError(timedOut ? "request timed out" : "network error", { cause: err });
      }

      if (res.status === 304) {
        this.#markReady("network"); // our cached copy is confirmed current
        return;
      }
      if (res.status === 401 || res.status === 403) {
        throw new FlagForgeError("API key was rejected (invalid or revoked)", { status: res.status, fatal: true });
      }
      if (!res.ok) throw new FlagForgeError(`unexpected response status ${res.status}`, { status: res.status });

      let snapshot: ConfigSnapshot;
      try {
        snapshot = parseSnapshot(await res.json());
      } catch (err) {
        throw new FlagForgeError("server returned an invalid configuration", { status: res.status, cause: err });
      }
      const changed = this.#apply(snapshot, res.headers.get("etag") ?? undefined);
      this.#markReady("network");
      if (changed) {
        this.#emit("update");
        this.#persist();
      }
    } finally {
      clearTimeout(timeout);
      if (this.#abort === controller) this.#abort = undefined;
    }
  }

  /** Swaps in a new config. Returns true when the flags actually differ from what we had. */
  #apply(snapshot: ConfigSnapshot, etag: string | undefined): boolean {
    const changed = !this.#snapshot || JSON.stringify(this.#snapshot) !== JSON.stringify(snapshot);
    this.#snapshot = snapshot;
    this.#flags = new Map(snapshot.flags.map((f) => [f.key, f])); // replaced in one step: no half-updated reads
    this.#etag = etag;
    this.#version = snapshot.version;
    return changed;
  }

  #markReady(source: ConfigSource) {
    const first = !this.#ready;
    this.#ready = true;
    this.#source = source;
    if (first) this.#emit("ready", source);
  }

  #persist() {
    const storage = this.#options.storage;
    if (!storage || !this.#snapshot) return;
    const stored = { ...(this.#etag ? { etag: this.#etag } : {}), savedAt: Date.now(), config: this.#snapshot };
    storage.save(stored).catch((err) => this.#emit("error", new FlagForgeError("could not save config cache", { cause: err })));
  }

  // ---- polling ------------------------------------------------------------------------------

  #schedule() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#closed || this.#fatal || this.#pollIntervalMs <= 0) return;
    // Healthy: poll on the interval, but only as a rare safety net while the stream is connected.
    // Failing: back off exponentially so we do not hammer a struggling server.
    // A stream the server flagged as degraded cannot be trusted to deliver every change, so it does not earn the slow rate.
    const streamTrusted = this.#streamState === "connected" && !this.#streamDegraded;
    const healthy = streamTrusted ? Math.max(this.#pollIntervalMs, this.#streamPollIntervalMs) : this.#pollIntervalMs;
    const base =
      this.#failures === 0
        ? healthy
        : Math.min(this.#maxBackoffMs, Math.max(this.#pollIntervalMs, 1000) * 2 ** Math.min(this.#failures, 10));
    const delay = base * (0.9 + Math.random() * 0.2); // jitter so a fleet of clients does not poll in lockstep
    this.#timer = setTimeout(async () => {
      await this.refresh();
      this.#schedule();
    }, delay);
    this.#timer.unref?.(); // polling alone must not keep the process alive
  }

  // ---- real-time stream ---------------------------------------------------------------------

  #setStream(state: StreamState) {
    if (state !== "connected") this.#streamDegraded = false; // a fresh connection starts trusted until the server says otherwise
    if (this.#streamState === state) return;
    this.#streamState = state;
    // Stream up -> poll rarely; stream down -> poll at the normal rate until it is back.
    this.#schedule();
  }

  async #streamLoop() {
    let attempt = 0;
    while (!this.#closed && !this.#fatal) {
      let connected = false;
      try {
        this.#setStream("connecting");
        await this.#runStream(() => {
          connected = true;
        });
      } catch (err) {
        if (this.#closed) break;
        const error = err instanceof FlagForgeError ? err : new FlagForgeError("stream error", { cause: err });
        if (error.fatal) this.#fatal = true;
        this.#emit("error", error);
      } finally {
        this.#setStream("disconnected");
      }
      if (this.#closed || this.#fatal) break;
      // A connection that worked resets the backoff, so a deploy-time restart reconnects quickly.
      attempt = connected ? 0 : attempt + 1;
      const base = Math.min(this.#maxBackoffMs, 1000 * 2 ** Math.min(attempt, 10));
      await this.#sleep(base * (0.9 + Math.random() * 0.2));
    }
    if (this.#fatal) this.#schedule(); // clears the poll timer
  }

  async #runStream(onConnected: () => void): Promise<void> {
    const controller = new AbortController();
    this.#streamAbort = controller;
    let reason: "timeout" | "idle" | undefined;
    const connectTimer = setTimeout(() => {
      reason = "timeout";
      controller.abort();
    }, this.#requestTimeoutMs);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        reason = "idle";
        controller.abort();
      }, this.#streamIdleTimeoutMs);
    };

    try {
      let res: Response;
      try {
        res = await this.#fetch(`${this.#baseUrl}/sdk/v1/stream`, {
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            Accept: "text/event-stream",
            ...(this.#version !== undefined ? { "Last-Event-ID": String(this.#version) } : {}),
          },
          signal: controller.signal,
        });
      } catch (err) {
        throw new FlagForgeError(reason === "timeout" ? "stream connect timed out" : "stream network error", { cause: err });
      }
      clearTimeout(connectTimer);

      if (res.status === 401 || res.status === 403) {
        throw new FlagForgeError("API key was rejected (invalid or revoked)", { status: res.status, fatal: true });
      }
      if (!res.ok || !res.body) throw new FlagForgeError(`stream rejected with status ${res.status}`, { status: res.status });

      this.#setStream("connected");
      onConnected();
      armIdle();

      const parser = new SseParser();
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return; // server closed the stream: the loop reconnects
          armIdle(); // any bytes, including heartbeats, prove the connection is alive
          for (const message of parser.push(value)) this.#onStreamMessage(message.event, message.data);
        }
      } catch (err) {
        if (this.#closed) return;
        throw new FlagForgeError(reason === "idle" ? "stream went silent" : "stream interrupted", { cause: err });
      }
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(idleTimer);
      if (this.#streamAbort === controller) this.#streamAbort = undefined;
      controller.abort(); // always release the connection
    }
  }

  #onStreamMessage(event: string | undefined, data: string | undefined) {
    if (event === "degraded") {
      if (!this.#streamDegraded) {
        this.#streamDegraded = true;
        this.#schedule(); // go back to polling at the normal rate
      }
      return;
    }
    if (event !== "hello" && event !== "change") return; // unknown events from newer servers are ignored
    if (event === "hello" && this.#streamDegraded) {
      // The server announced a fresh version after its feed recovered: the stream can be trusted again.
      this.#streamDegraded = false;
      this.#schedule();
    }
    let version: unknown;
    try {
      version = (JSON.parse(data ?? "") as { version?: unknown }).version;
    } catch {
      return;
    }
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return;

    // "change": only newer versions matter. "hello": any difference (even older, e.g. after a
    // database restore) means our copy is not what the server has, so resync.
    const known = this.#version;
    const needsSync = event === "hello" ? known !== version : known === undefined || version > known;
    if (!needsSync) return;
    this.#wantVersion = event === "hello" ? version : Math.max(this.#wantVersion, version);
    void this.#catchUp();
  }

  /**
   * Fetch until we have at least the version the stream announced. A fetch that was already in
   * flight when the change committed can return stale data, so one fetch is not always enough.
   */
  async #catchUp() {
    if (this.#catchingUp) return;
    this.#catchingUp = true;
    const target = this.#wantVersion;
    try {
      for (let attempt = 0; attempt < 6 && !this.#closed && !this.#fatal; attempt++) {
        const ok = await this.refresh();
        // Older servers report no version; one successful fetch is all we can do for them.
        if (ok && (this.#version === undefined || this.#version >= target)) return;
        await this.#sleep(Math.min(2000, 100 * 2 ** attempt));
      }
    } finally {
      this.#catchingUp = false;
      if (!this.#closed && this.#wantVersion > target) void this.#catchUp(); // another change arrived meanwhile
    }
  }

  /** A sleep that close() can interrupt, and that never keeps the process alive. */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.#closed) return resolve();
      const done = () => {
        clearTimeout(timer);
        this.#sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.#sleepers.add(done);
    });
  }

  /** Stops polling and the stream, and cancels requests in flight. Evaluation keeps working with the last config. */
  close(): void {
    this.#closed = true;
    void this.#events?.close(); // one last attempt to send queued events; never awaited here
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#abort?.abort();
    this.#streamAbort?.abort();
    for (const wake of [...this.#sleepers]) wake();
    if (this.#streaming) this.#streamState = "disconnected";
  }

  get status(): ClientStatus {
    return {
      ready: this.#ready,
      source: this.#source,
      ...(this.#lastSuccessAt !== undefined ? { lastSuccessAt: this.#lastSuccessAt } : {}),
      consecutiveFailures: this.#failures,
      stream: this.#streamState,
      streamDegraded: this.#streamDegraded,
      ...(this.#version !== undefined ? { version: this.#version } : {}),
      fatal: this.#fatal,
      events: this.#events?.stats ?? { queued: 0, sent: 0, dropped: 0 },
    };
  }

  // ---- evaluation (local, synchronous, never throws) ------------------------------------------

  /**
   * Decides one flag for one user using the cached config. `defaultValue` is returned only when
   * no decision can be made (not ready, unknown flag, bad input); a known flag that is simply off
   * returns false whatever the default is.
   */
  evaluate(flagKey: string, user: EvaluationContext, defaultValue = false): EvaluationDetail {
    if (!this.#ready) return { value: defaultValue, reason: "NOT_READY" };
    if (!user || typeof user.key !== "string" || user.key === "") return { value: defaultValue, reason: "ERROR" };
    const config = this.#flags.get(flagKey);
    if (!config) return { value: defaultValue, reason: "FLAG_NOT_FOUND" };
    try {
      const result = evaluateFlag(config, user);
      // Only a real decision is an exposure: defaults returned above (not ready, unknown flag) are not.
      this.#events?.exposure(flagKey, user.key, result.value);
      return result;
    } catch {
      return { value: defaultValue, reason: "ERROR" };
    }
  }

  isEnabled(flagKey: string, user: EvaluationContext, defaultValue = false): boolean {
    return this.evaluate(flagKey, user, defaultValue).value;
  }

  /**
   * Every flag's decision for one user, e.g. to hand to a front end.
   * Does NOT record exposures: listing every flag is not the same as the user being shown each
   * one. Call `evaluate` or `isEnabled` for the flag a user actually experiences.
   */
  allFlags(user: EvaluationContext): Record<string, EvaluationDetail> {
    const out: Record<string, EvaluationDetail> = {};
    for (const [key, config] of this.#flags) {
      try {
        out[key] = this.#ready && user && typeof user.key === "string" && user.key !== "" ? evaluateFlag(config, user) : this.evaluate(key, user);
      } catch {
        out[key] = { value: false, reason: "ERROR" };
      }
    }
    return out;
  }

  // ---- experiment events (only when `sendEvents` is on) -----------------------------------------

  /**
   * Records that a user did the thing an experiment measures, e.g. `track("checkout-completed", user)`.
   * Returns immediately; events are sent in batches in the background. Does nothing unless the
   * client was created with `sendEvents: true`. Never throws.
   */
  track(metricKey: string, user: EvaluationContext): void {
    if (typeof metricKey !== "string" || metricKey === "" || !user || typeof user.key !== "string" || user.key === "") return;
    this.#events?.conversion(metricKey, user.key);
  }

  /** Sends queued events now. Await it before a short-lived process exits. Never rejects. */
  flush(): Promise<void> {
    return this.#events?.flush() ?? Promise.resolve();
  }
}

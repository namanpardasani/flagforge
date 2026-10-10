import { evaluateFlag, type EvaluationContext, type FlagConfig } from "@flagforge/core";
import { parseSnapshot } from "./parse.js";
import {
  FlagForgeError,
  type ClientEvents,
  type ClientStatus,
  type ConfigSnapshot,
  type ConfigSource,
  type EvaluationDetail,
  type FlagForgeOptions,
} from "./types.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class FlagForgeClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #pollIntervalMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maxBackoffMs: number;
  readonly #options: FlagForgeOptions;
  readonly #fetch: typeof fetch;

  #flags = new Map<string, FlagConfig>();
  #snapshot: ConfigSnapshot | undefined;
  #etag: string | undefined;
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
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
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
   * Loads flags (network first, then storage, then bootstrap) and starts background polling.
   * Never rejects: check `ready` in the result. If it is false, evaluations return your defaults
   * until the first successful fetch, which polling keeps retrying in the background.
   */
  init(): Promise<{ ready: boolean; source: ConfigSource }> {
    this.#initPromise ??= this.#init();
    return this.#initPromise;
  }

  async #init() {
    const ok = await this.refresh();
    if (!ok && !this.#ready) await this.#loadFallback();
    this.#schedule();
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

  #schedule() {
    if (this.#closed || this.#fatal || this.#pollIntervalMs <= 0) return;
    // Healthy: poll on the interval. Failing: back off exponentially so we do not hammer a struggling server.
    const base =
      this.#failures === 0
        ? this.#pollIntervalMs
        : Math.min(this.#maxBackoffMs, Math.max(this.#pollIntervalMs, 1000) * 2 ** Math.min(this.#failures, 10));
    const delay = base * (0.9 + Math.random() * 0.2); // jitter so a fleet of clients does not poll in lockstep
    this.#timer = setTimeout(async () => {
      await this.refresh();
      this.#schedule();
    }, delay);
    this.#timer.unref?.(); // polling alone must not keep the process alive
  }

  /** Stops polling and cancels any request in flight. Evaluation keeps working with the last config. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#abort?.abort();
  }

  get status(): ClientStatus {
    return {
      ready: this.#ready,
      source: this.#source,
      ...(this.#lastSuccessAt !== undefined ? { lastSuccessAt: this.#lastSuccessAt } : {}),
      consecutiveFailures: this.#failures,
      fatal: this.#fatal,
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
      return evaluateFlag(config, user);
    } catch {
      return { value: defaultValue, reason: "ERROR" };
    }
  }

  isEnabled(flagKey: string, user: EvaluationContext, defaultValue = false): boolean {
    return this.evaluate(flagKey, user, defaultValue).value;
  }

  /** Every flag's decision for one user, e.g. to hand to a front end. */
  allFlags(user: EvaluationContext): Record<string, EvaluationDetail> {
    const out: Record<string, EvaluationDetail> = {};
    for (const key of this.#flags.keys()) out[key] = this.evaluate(key, user);
    return out;
  }
}

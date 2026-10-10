import type { EvaluationReason, FlagConfig } from "@flagforge/core";

/** Everything the server sends from GET /sdk/v1/flags. */
export interface ConfigSnapshot {
  environment: { id: string; key: string };
  /** Increases every time this environment's config changes. Absent on older servers. */
  version?: number;
  flags: FlagConfig[];
}

/** What gets persisted so a restart can survive a server outage. */
export interface StoredConfig {
  etag?: string;
  savedAt: number;
  config: ConfigSnapshot;
}

/** Plug in your own persistence (file, Redis, ...). Failures must never break the client. */
export interface ConfigStorage {
  load(): Promise<StoredConfig | null>;
  save(stored: StoredConfig): Promise<void>;
}

export interface FlagForgeOptions {
  /** Environment API key (starts with ff_). Keep it server-side. */
  apiKey: string;
  /** e.g. https://flags.example.com . Plain http is only allowed for localhost. */
  baseUrl: string;
  /** How often to re-check for changes. 0 turns polling off. Default 30000. */
  pollIntervalMs?: number;
  /** Give up on a single HTTP request after this long. Default 5000. */
  requestTimeoutMs?: number;
  /** Longest wait between retries while the server is failing. Default 300000 (5 min). */
  maxBackoffMs?: number;
  /** Used at startup when the network fails. */
  storage?: ConfigStorage;
  /** Last-resort flags if both network and storage are unavailable. */
  bootstrap?: ConfigSnapshot;
  /** Override for tests or non-standard runtimes. */
  fetch?: typeof fetch;
  /** Opt in to sending the API key over plain http to a non-local host. Do not do this in production. */
  allowInsecureHttp?: boolean;
  /**
   * Keep a real-time stream open so changes arrive within moments instead of at the next poll.
   * Polling stays on as a safety net. Default true.
   */
  streaming?: boolean;
  /** While the stream is healthy, poll this rarely (only a safety net). Default 300000 (5 min). */
  streamPollIntervalMs?: number;
  /** Reconnect if the stream is silent this long (the server sends heartbeats about every 25s). Default 60000. */
  streamIdleTimeoutMs?: number;
}

/** Why a value was returned. The first three come from @flagforge/core; the rest are SDK fallbacks. */
export type SdkReason = EvaluationReason | "FLAG_NOT_FOUND" | "NOT_READY" | "ERROR";

export interface EvaluationDetail {
  value: boolean;
  reason: SdkReason;
  ruleId?: string;
}

export type ConfigSource = "network" | "storage" | "bootstrap" | "none";

/** "off" means streaming is disabled. */
export type StreamState = "off" | "connecting" | "connected" | "disconnected";

export interface ClientStatus {
  ready: boolean;
  source: ConfigSource;
  /** Epoch ms of the last successful contact with the server. */
  lastSuccessAt?: number;
  consecutiveFailures: number;
  stream: StreamState;
  /** Version of the config currently being served, when the server reports one. */
  version?: number;
  /** True after a 401/403: polling has stopped until you create a new client. */
  fatal: boolean;
}

export type ClientEvents = {
  /** First time any config became available. */
  ready: (source: ConfigSource) => void;
  /** The flag configuration changed. */
  update: () => void;
  /** A fetch failed. The client keeps serving the last known config. */
  error: (error: FlagForgeError) => void;
};

export class FlagForgeError extends Error {
  readonly status?: number;
  readonly fatal: boolean;
  constructor(message: string, options: { status?: number; fatal?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FlagForgeError";
    if (options.status !== undefined) this.status = options.status;
    this.fatal = options.fatal ?? false;
  }
}

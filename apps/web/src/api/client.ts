import type { z } from "zod";

/**
 * The one place that talks HTTP to the FlagForge server.
 *
 * Tokens:
 *  - the ACCESS token (15 minutes) lives only in this module's memory. A script injected into the
 *    page cannot read it from storage, and it is gone when the tab closes;
 *  - the REFRESH token (7 days) is kept in localStorage so a reload does not sign you out. The
 *    server rotates it on every use and revokes the whole family if an old one is replayed.
 *
 * When a request comes back 401 the client refreshes ONCE and repeats the request ONCE. If that
 * also fails, the session is over: tokens are cleared and listeners are told.
 */

export class ApiError extends Error {
  constructor(
    /** HTTP status; 0 when the server could not be reached at all. */
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isOffline() {
    return this.status === 0;
  }
}

const REFRESH_KEY = "ff.refresh";

interface Settings {
  baseUrl: string;
  fetch: typeof fetch;
}
const settings: Settings = {
  // In development Vite proxies /api to the server (vite.config.ts). In production set VITE_API_URL.
  baseUrl: (import.meta.env["VITE_API_URL"] as string | undefined) ?? "/api",
  fetch: (...args) => globalThis.fetch(...args),
};
/** Tests point the client at an in-memory server. */
export function configureApi(next: Partial<Settings>) {
  Object.assign(settings, next);
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const sessionEndListeners = new Set<() => void>();

const storage = {
  get(): string | null {
    try {
      return window.localStorage.getItem(REFRESH_KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null) {
    try {
      if (token === null) window.localStorage.removeItem(REFRESH_KEY);
      else window.localStorage.setItem(REFRESH_KEY, token);
    } catch {
      // Storage blocked: the session just will not survive a reload.
    }
  },
};

export const tokens = {
  hasRefreshToken: () => storage.get() !== null,
  refreshToken: () => storage.get(),
  set(pair: { accessToken: string; refreshToken: string }) {
    accessToken = pair.accessToken;
    storage.set(pair.refreshToken);
  },
  clear() {
    accessToken = null;
    storage.set(null);
  },
  /** For the live stream, which builds its own request. */
  access: () => accessToken,
};

/** Called when the session can no longer be refreshed (expired, revoked, signed out elsewhere). */
export function onSessionEnd(listener: () => void): () => void {
  sessionEndListeners.add(listener);
  return () => sessionEndListeners.delete(listener);
}

function endSession() {
  tokens.clear();
  for (const listener of [...sessionEndListeners]) listener();
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await settings.fetch(`${settings.baseUrl}${path}`, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(0, "NETWORK", "Cannot reach the server. Check your connection and try again.");
  }
}

async function toError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = (body as { error?: { code?: unknown; message?: unknown; requestId?: unknown } } | undefined)?.error;
  const code = typeof error?.code === "string" ? error.code : `HTTP_${response.status}`;
  const fallback = response.status >= 500 ? "The server had a problem. Try again in a moment." : `Request failed (${response.status})`;
  return new ApiError(response.status, code, typeof error?.message === "string" ? error.message : fallback, typeof error?.requestId === "string" ? error.requestId : undefined);
}

async function exchangeRefreshToken(): Promise<boolean> {
  const refreshToken = storage.get();
  if (!refreshToken) return false;
  const response = await send("/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) {
    // 401 means the token is spent, expired or revoked: the session is over. Anything else
    // (server down, rate limited) is temporary, so the token is kept for the next attempt.
    if (response.status === 401 || response.status === 400) return false;
    throw await toError(response);
  }
  const pair = (await response.json()) as { accessToken?: unknown; refreshToken?: unknown };
  if (typeof pair.accessToken !== "string" || typeof pair.refreshToken !== "string") return false;
  tokens.set({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
  return true;
}

/**
 * Gets a fresh access token. Returns false when the session is over.
 *
 * Refresh tokens are single-use, so two refreshes must never run at once:
 *  - within this tab, every caller shares one in-flight promise;
 *  - across tabs, a Web Lock makes them take turns. Each reads the stored token only once it
 *    holds the lock, so the second tab uses the token the first one just received instead of
 *    replaying the spent one (which the server would treat as theft and revoke everything).
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
      return locks ? await locks.request("ff.refresh", exchangeRefreshToken) : await exchangeRefreshToken();
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

interface RequestOptions<Schema extends z.ZodType> {
  body?: unknown;
  /** Describes the response. The server is trusted but checked: a wrong shape is an error, not a crash later. */
  schema?: Schema;
  /** False for the sign-in routes, which have no token to send and must not trigger a refresh. */
  authenticated?: boolean;
  signal?: AbortSignal;
}

export async function request<Schema extends z.ZodType = z.ZodUndefined>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  { body, schema, authenticated = true, signal }: RequestOptions<Schema> = {},
): Promise<z.infer<Schema>> {
  const attempt = () => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (authenticated && accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    return send(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  };

  // No access token yet (first request after a reload): get one first instead of sending a
  // request that is certain to come back 401.
  if (authenticated && !accessToken && !(await refreshSession())) {
    endSession();
    throw new ApiError(401, "SESSION_EXPIRED", "Your session has ended. Sign in again.");
  }

  let response = await attempt();
  if (response.status === 401 && authenticated) {
    if (!(await refreshSession())) {
      endSession();
      throw new ApiError(401, "SESSION_EXPIRED", "Your session has ended. Sign in again.");
    }
    response = await attempt(); // once: a second 401 is reported, never looped on
    if (response.status === 401) {
      endSession();
      throw new ApiError(401, "SESSION_EXPIRED", "Your session has ended. Sign in again.");
    }
  }

  if (!response.ok) throw await toError(response);
  if (response.status === 204 || !schema) return undefined as z.infer<Schema>;

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiError(response.status, "BAD_RESPONSE", "The server sent something this app could not read.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError(response.status, "BAD_RESPONSE", "The server sent something this app did not expect.");
  return parsed.data;
}

/** Opens a raw authenticated response (the live stream). Refreshes once on 401, like `request`. */
export async function openStream(path: string, signal: AbortSignal): Promise<Response> {
  const attempt = () => send(path, { headers: { Accept: "text/event-stream", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, signal });
  if (!accessToken && !(await refreshSession())) {
    endSession();
    throw new ApiError(401, "SESSION_EXPIRED", "Your session has ended. Sign in again.");
  }
  let response = await attempt();
  if (response.status === 401) {
    if (!(await refreshSession())) {
      endSession();
      throw new ApiError(401, "SESSION_EXPIRED", "Your session has ended. Sign in again.");
    }
    response = await attempt();
  }
  if (!response.ok) throw await toError(response);
  return response;
}

/** Test helper: forget the tokens held in memory (listeners stay: they belong to long-lived modules). */
export function resetApiClient() {
  accessToken = null;
  refreshing = null;
}

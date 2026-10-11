import { ACTIVITY, FLAGS, PROJECTS, WORKSPACES, type Flag as SeedFlag, type TargetingRule as SeedRule } from "./seed";

/**
 * An in-memory stand-in for the FlagForge server, used only by tests.
 *
 * It is handed to the API client as its `fetch`, and it answers in the SERVER's wire format
 * (ids in URLs, `{ error: { code, message } }` bodies, single-use refresh tokens, an SSE stream),
 * so the tests exercise the real client, adapters and hooks end to end. Nothing here ships.
 */

type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
type Value = string | number | boolean | Array<string | number>;
interface WireRule {
  id: string;
  conditions: Array<{ attribute: string; operator: string; value: Value }>;
  rolloutPercentage: number;
}
interface WireState {
  environmentId: string;
  key: string;
  name: string;
  enabled: boolean;
  rules: WireRule[];
  rolloutPercentage: number;
  updatedAt: string | null;
}
interface WireFlag {
  id: string;
  projectId: string;
  key: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  environments: WireState[];
}
interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  actor: { id: string; name: string; email: string } | null;
}

export const TEST_USER = { id: "u_mira", name: "Mira Okafor", email: "mira@halden.example", password: "correct horse battery" };
const ENVS = [
  { key: "dev", name: "Development" },
  { key: "staging", name: "Staging" },
  { key: "prod", name: "Production" },
] as const;
const ORDER: Role[] = ["VIEWER", "MEMBER", "ADMIN", "OWNER"];

const envId = (projectId: string, key: string) => `${projectId}_${key}`;

function wireRule(rule: SeedRule): WireRule {
  const text = rule.value.trim();
  const value: Value = ["in", "not_in"].includes(rule.operator) ? text.split(",").map((part) => part.trim()) : ["gt", "gte", "lt", "lte"].includes(rule.operator) ? Number(text) : text;
  return { id: rule.id, conditions: [{ attribute: rule.attribute, operator: rule.operator, value }], rolloutPercentage: rule.rolloutPercentage };
}

function wireFlag(flag: SeedFlag): WireFlag {
  const project = PROJECTS.find((p) => p.key === flag.projectKey)!;
  return {
    id: flag.id,
    projectId: project.id,
    key: flag.key,
    name: flag.name,
    description: flag.description,
    createdAt: flag.updatedAt,
    updatedAt: flag.updatedAt,
    environments: ENVS.map((e) => ({
      environmentId: envId(project.id, e.key),
      key: e.key,
      name: e.name,
      enabled: flag.states[e.key].enabled,
      rules: flag.states[e.key].rules.map(wireRule),
      rolloutPercentage: flag.states[e.key].rolloutPercentage,
      updatedAt: null,
    })),
  };
}

/** The seed's activity lines, rebuilt as audit rows whose metadata produces the same sentences. */
function seedAudit(): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const entry of ACTIVITY) {
    const flag = FLAGS.find((f) => f.key === entry.subject);
    if (!flag) continue; // api-key entries are not flag history
    const base = { key: flag.key, ...(entry.env ? { environmentKey: entry.env } : {}) };
    const rollout = /^Rollout (\d+)% to (\d+)%$/.exec(entry.detail);
    const metadata: Record<string, unknown> =
      entry.action === "flag.toggled"
        ? { ...base, from: false, to: true }
        : entry.action === "flag.targeting_updated"
          ? rollout
            ? { ...base, before: { rules: [], fallthroughBps: Number(rollout[1]) * 100 }, after: { rules: [], fallthroughBps: Number(rollout[2]) * 100 } }
            : { ...base, before: { rules: [], fallthroughBps: 10000 }, after: { rules: [{}], fallthroughBps: 10000 } }
          : { ...base, projectId: PROJECTS.find((p) => p.key === flag.projectKey)!.id };
    rows.push({ id: entry.id, action: entry.action, entityType: "flag", entityId: flag.id, metadata, createdAt: entry.at, actor: { id: `u_${entry.actor}`, name: entry.actor, email: "someone@halden.example" } });
  }
  return rows;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, code: string, message: string) => json(status, { error: { code, message, requestId: "req_test" } });

export function createFakeServer() {
  let flags: WireFlag[] = [];
  let audit: AuditRow[] = [];
  let roles: Record<string, Role> = {};
  let versions = new Map<string, number>();
  let accessTokens = new Map<string, { expired: boolean }>();
  let refreshTokens = new Set<string>();
  let spentRefreshTokens = new Set<string>();
  let streams = new Set<{ projectId: string; send: (text: string) => void; close: () => void }>();
  let failWrites = 0;
  let failWith: { status: number; code: string; message: string } = { status: 503, code: "UNAVAILABLE", message: "The server refused the change" };
  let offline = false;
  let sequence = 0;
  let remoteTurn = 0;
  let calls: Array<{ method: string; path: string; authorization: string | null }> = [];
  let inFlight = 0;
  let projectEnvs: Record<string, Array<{ key: string; name: string }>> = {};
  let members: Array<{ workspaceId: string; userId: string; name: string; email: string; role: Role; joinedAt: string }> = [];
  let apiKeys: Array<{ id: string; environmentId: string; name: string; prefix: string; createdAt: string; revokedAt: string | null }> = [];

  const token = (kind: string) => `${kind}_${++sequence}_${Math.random().toString(36).slice(2, 8)}`;
  const now = () => new Date().toISOString();

  const envsOf = (projectId: string) => projectEnvs[projectId] ?? [];

  function reset() {
    projectEnvs = Object.fromEntries(PROJECTS.map((p) => [p.id, ENVS.map((e) => ({ key: e.key, name: e.name }))]));
    for (const stream of [...streams]) stream.close();
    flags = FLAGS.map(wireFlag);
    members = [
      { workspaceId: "ws_halden", userId: "u_jonas", name: "Jonas Reyes", email: "jonas@halden.example", role: "ADMIN", joinedAt: "2026-02-01T00:00:00Z" },
      { workspaceId: "ws_halden", userId: "u_tove", name: "Tove Lind", email: "tove@halden.example", role: "MEMBER", joinedAt: "2026-03-01T00:00:00Z" },
    ];
    apiKeys = [{ id: "key_seed", environmentId: envId("pr_dispatch", "prod"), name: "Checkout service", prefix: "ff_Qm2xK8v", createdAt: "2026-10-08T09:02:00Z", revokedAt: null }];
    audit = seedAudit();
    roles = Object.fromEntries(WORKSPACES.map((w) => [w.id, w.role]));
    versions = new Map(PROJECTS.flatMap((p) => envsOf(p.id).map((e) => [envId(p.id, e.key), 1] as const)));
    accessTokens = new Map();
    refreshTokens = new Set();
    spentRefreshTokens = new Set();
    streams = new Set();
    failWrites = 0;
    failWith = { status: 503, code: "UNAVAILABLE", message: "The server refused the change" };
    offline = false;
    sequence = 0;
    remoteTurn = 0;
    calls = [];
  }
  reset();

  const issue = () => {
    const pair = { accessToken: token("access"), refreshToken: token("refresh") };
    accessTokens.set(pair.accessToken, { expired: false });
    refreshTokens.add(pair.refreshToken);
    return pair;
  };

  const publicUser = { id: TEST_USER.id, name: TEST_USER.name, email: TEST_USER.email, createdAt: "2026-01-01T00:00:00.000Z" };
  const workspace = (w: (typeof WORKSPACES)[number]) => ({ id: w.id, name: w.name, slug: w.slug, ownerId: TEST_USER.id, createdAt: "2026-01-01T00:00:00.000Z", role: roles[w.id] });
  const project = (p: (typeof PROJECTS)[number]) => ({
    id: p.id,
    workspaceId: WORKSPACES.find((w) => w.slug === p.workspaceSlug)!.id,
    name: p.name,
    key: p.key,
    createdAt: "2026-01-01T00:00:00.000Z",
    environments: envsOf(p.id).map((e, i) => ({ id: envId(p.id, e.key), key: e.key, name: e.name, createdAt: `2026-01-01T00:00:0${Math.min(i, 9)}.000Z` })),
  });

  function bump(environmentId: string) {
    const version = (versions.get(environmentId) ?? 0) + 1;
    versions.set(environmentId, version);
    const projectId = environmentId.slice(0, environmentId.lastIndexOf("_"));
    for (const stream of streams) {
      if (stream.projectId === projectId) stream.send(`event: change\ndata: ${JSON.stringify({ environmentId, version })}\n\n`);
    }
  }

  function record(action: string, flag: WireFlag, metadata: Record<string, unknown>, actor = publicUser.name) {
    audit = [{ id: `audit_${++sequence}`, action, entityType: "flag", entityId: flag.id, metadata: { key: flag.key, ...metadata }, createdAt: now(), actor: { id: TEST_USER.id, name: actor, email: TEST_USER.email } }, ...audit];
  }

  function hello(projectId: string) {
    const environments = envsOf(projectId).map((e) => ({ environmentId: envId(projectId, e.key), key: e.key, version: versions.get(envId(projectId, e.key)) ?? 1 }));
    return `event: hello\ndata: ${JSON.stringify({ environments })}\n\n`;
  }

  function openStream(projectId: string, signal: AbortSignal | null | undefined): Response {
    const encoder = new TextEncoder();
    let entry: { projectId: string; send: (text: string) => void; close: () => void };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        entry = {
          projectId,
          send: (text) => open && controller.enqueue(encoder.encode(text)),
          close: () => {
            if (!open) return;
            open = false;
            streams.delete(entry);
            try {
              controller.close();
            } catch {
              // already closed by the reader
            }
          },
        };
        streams.add(entry);
        signal?.addEventListener("abort", () => entry.close());
        entry.send("retry: 3000\n\n");
        entry.send(hello(projectId));
      },
      cancel() {
        entry.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  async function handle(method: string, path: string, body: Record<string, unknown> | undefined, authorization: string | null, signal: AbortSignal | null | undefined): Promise<Response> {
    // ---- sign-in routes (no token needed) ----
    if (path === "/auth/login" && method === "POST") {
      if (body?.["email"] !== TEST_USER.email || body["password"] !== TEST_USER.password) return fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
      return json(200, { user: publicUser, ...issue() });
    }
    if (path === "/auth/register" && method === "POST") {
      if (body?.["email"] === TEST_USER.email) return fail(409, "EMAIL_TAKEN", "An account with this email already exists");
      return json(201, { user: { ...publicUser, name: String(body?.["name"]), email: String(body?.["email"]) }, ...issue() });
    }
    if (path === "/auth/refresh" && method === "POST") {
      const presented = String(body?.["refreshToken"]);
      if (spentRefreshTokens.has(presented)) {
        refreshTokens.clear(); // a replayed token: treat as theft, revoke the whole family
        return fail(401, "UNAUTHORIZED", "Invalid refresh token");
      }
      if (!refreshTokens.has(presented)) return fail(401, "UNAUTHORIZED", "Invalid refresh token");
      refreshTokens.delete(presented);
      spentRefreshTokens.add(presented);
      return json(200, issue());
    }
    if (path === "/auth/logout" && method === "POST") {
      refreshTokens.delete(String(body?.["refreshToken"]));
      return new Response(null, { status: 204 });
    }

    // ---- everything else needs a valid access token ----
    const presented = authorization?.replace(/^Bearer /, "") ?? "";
    const known = accessTokens.get(presented);
    if (!known || known.expired) return fail(401, "UNAUTHORIZED", "Invalid or expired access token");

    if (path === "/auth/me") return json(200, { user: publicUser });
    if (path === "/workspaces" && method === "GET") return json(200, { workspaces: WORKSPACES.filter((w) => roles[w.id]).map(workspace) });

    const match = /^\/workspaces\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return fail(404, "NOT_FOUND", `Route not found: ${method} ${path}`);
    const ws = WORKSPACES.find((w) => w.id === match[1]);
    const role = ws ? roles[ws.id] : undefined;
    // Not a member: the workspace "does not exist" (404, never 403), exactly like the real server.
    if (!ws || !role) return fail(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    const need = (minimum: Role) => (ORDER.indexOf(role) >= ORDER.indexOf(minimum) ? null : fail(403, "FORBIDDEN", `This action requires the ${minimum} role or higher`));
    const rest = (match[2] ?? "").split("?")[0]!;

    // Members: the signed-in user is always listed, with the role the test gave them.
    const listMembers = () =>
      [{ workspaceId: ws.id, userId: TEST_USER.id, name: TEST_USER.name, email: TEST_USER.email, role, joinedAt: "2026-01-01T00:00:00Z" }, ...members.filter((m) => m.workspaceId === ws.id)].map((m) => ({
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        user: { email: m.email, name: m.name },
      }));
    const forbid = (message: string) => fail(403, "FORBIDDEN", message);
    if (rest === "/members" && method === "GET") return json(200, { members: listMembers() });
    if (rest === "/members" && method === "POST") {
      const denied = need("ADMIN");
      if (denied) return denied;
      const email = String(body?.["email"]);
      const newRole = String(body?.["role"]) as Role;
      if (newRole === "ADMIN" && role !== "OWNER") return forbid("Only the owner can add admins");
      const person = [{ id: "u_nils", name: "Nils Berg", email: "nils@halden.example" }].find((u) => u.email === email);
      if (!person) return fail(404, "USER_NOT_FOUND", "No user with this email");
      if (email === TEST_USER.email || members.some((m) => m.workspaceId === ws.id && m.email === email)) return fail(409, "ALREADY_MEMBER", "This user is already a member");
      const added = { workspaceId: ws.id, userId: person.id, name: person.name, email, role: newRole, joinedAt: now() };
      members.push(added);
      return json(201, { userId: added.userId, role: added.role, joinedAt: added.joinedAt, user: { email, name: added.name } });
    }
    const memberRoute = /^\/members\/([^/]+)$/.exec(rest);
    if (memberRoute) {
      const targetId = memberRoute[1]!;
      const target = listMembers().find((m) => m.userId === targetId);
      if (!target) return fail(404, "MEMBER_NOT_FOUND", "Member not found");
      if (method === "PATCH") {
        const denied = need("ADMIN");
        if (denied) return denied;
        const newRole = String(body?.["role"]) as Role;
        if (targetId === TEST_USER.id) return forbid("You cannot change your own role");
        if (target.role === "OWNER") return forbid("The owner's role cannot be changed");
        if ((target.role === "ADMIN" || newRole === "ADMIN") && role !== "OWNER") return forbid("Only the owner can grant or revoke admin");
        members.find((m) => m.userId === targetId)!.role = newRole;
        return json(200, { ...target, role: newRole });
      }
      if (method === "DELETE") {
        if (target.role === "OWNER") return forbid("The owner cannot be removed");
        const leaving = targetId === TEST_USER.id;
        if (!leaving && ORDER.indexOf(role) < ORDER.indexOf("ADMIN")) return forbid("Insufficient role");
        if (!leaving && target.role === "ADMIN" && role !== "OWNER") return forbid("Only the owner can remove admins");
        if (leaving) delete roles[ws.id];
        else members = members.filter((m) => !(m.workspaceId === ws.id && m.userId === targetId));
        return new Response(null, { status: 204 });
      }
    }

    if (rest === "/projects" && method === "GET") return json(200, { projects: PROJECTS.filter((p) => p.workspaceSlug === ws.slug).map(project) });
    if (rest === "/audit-log" && method === "GET") return need("ADMIN") ?? json(200, { entries: audit });

    const inProject = /^\/projects\/([^/]+)(\/.*)?$/.exec(rest);
    const proj = inProject ? PROJECTS.find((p) => p.id === inProject[1] && p.workspaceSlug === ws.slug) : undefined;
    if (!inProject || !proj) return fail(404, "PROJECT_NOT_FOUND", "Project not found");
    const tail = inProject[2] ?? "";

    if (tail === "/environments" && method === "GET") return json(200, { environments: project(proj).environments });
    if (tail === "/environments" && method === "POST") {
      const denied = need("ADMIN");
      if (denied) return denied;
      const key = String(body?.["key"]);
      if (envsOf(proj.id).some((e) => e.key === key)) return fail(409, "ENVIRONMENT_KEY_TAKEN", "An environment with this key already exists in the project");
      envsOf(proj.id).push({ key, name: String(body?.["name"]) });
      versions.set(envId(proj.id, key), 1);
      for (const flag of flags.filter((f) => f.projectId === proj.id)) {
        flag.environments.push({ environmentId: envId(proj.id, key), key, name: String(body?.["name"]), enabled: false, rules: [], rolloutPercentage: 100, updatedAt: null });
      }
      const created = project(proj).environments.find((e) => e.key === key)!;
      return json(201, created);
    }
    const envDelete = /^\/environments\/([^/]+)$/.exec(tail);
    if (envDelete && method === "DELETE") {
      const denied = need("ADMIN");
      if (denied) return denied;
      const list = envsOf(proj.id);
      const at = list.findIndex((e) => envId(proj.id, e.key) === envDelete[1]);
      if (at === -1) return fail(404, "ENVIRONMENT_NOT_FOUND", "Environment not found");
      if (list.length <= 1) return fail(409, "LAST_ENVIRONMENT", "A project must keep at least one environment");
      const [gone] = list.splice(at, 1);
      for (const flag of flags.filter((f) => f.projectId === proj.id)) flag.environments = flag.environments.filter((e) => e.key !== gone!.key);
      apiKeys = apiKeys.filter((k) => k.environmentId !== envId(proj.id, gone!.key));
      return new Response(null, { status: 204 });
    }

    const keysRoute = /^\/environments\/([^/]+)\/api-keys(?:\/([^/]+))?$/.exec(tail);
    if (keysRoute) {
      const denied = need("ADMIN");
      if (denied) return denied;
      const environment = envsOf(proj.id).find((e) => envId(proj.id, e.key) === keysRoute[1]);
      if (!environment) return fail(404, "ENVIRONMENT_NOT_FOUND", "Environment not found");
      const environmentId = keysRoute[1]!;
      const publicKey = ({ environmentId: _env, ...rest }: (typeof apiKeys)[number]) => rest;
      if (method === "GET") return json(200, { apiKeys: apiKeys.filter((k) => k.environmentId === environmentId).map(publicKey) });
      if (method === "POST") {
        const secret = `ff_${token("secret")}${"x".repeat(24)}`; // the real key is "ff_" plus 48 characters
        const created = { id: `key_${++sequence}`, environmentId, name: String(body?.["name"]), prefix: secret.slice(0, 10), createdAt: now(), revokedAt: null };
        apiKeys = [...apiKeys, created];
        return json(201, { ...publicKey(created), key: secret });
      }
      if (method === "DELETE") {
        const key = apiKeys.find((k) => k.id === keysRoute[2] && k.environmentId === environmentId && !k.revokedAt);
        if (!key) return fail(404, "API_KEY_NOT_FOUND", "API key not found");
        key.revokedAt = now();
        return new Response(null, { status: 204 });
      }
    }

    if (tail === "/stream" && method === "GET") return openStream(proj.id, signal);
    if (tail === "/flags" && method === "GET") return json(200, { flags: flags.filter((f) => f.projectId === proj.id) });

    const writeBlocked = () => {
      if (failWrites <= 0) return null;
      failWrites--;
      return fail(failWith.status, failWith.code, failWith.message);
    };

    if (tail === "/flags" && method === "POST") {
      const denied = need("MEMBER") ?? writeBlocked();
      if (denied) return denied;
      const key = String(body?.["key"]);
      if (flags.some((f) => f.projectId === proj.id && f.key === key)) return fail(409, "FLAG_KEY_TAKEN", "A flag with this key already exists in the project");
      const created: WireFlag = {
        id: `fl_new_${++sequence}`,
        projectId: proj.id,
        key,
        name: String(body?.["name"]),
        description: typeof body?.["description"] === "string" ? body["description"] : null,
        createdAt: now(),
        updatedAt: now(),
        environments: envsOf(proj.id).map((e) => ({ environmentId: envId(proj.id, e.key), key: e.key, name: e.name, enabled: false, rules: [], rolloutPercentage: 100, updatedAt: null })),
      };
      flags = [...flags, created];
      record("flag.created", created, { projectId: proj.id });
      for (const e of envsOf(proj.id)) bump(envId(proj.id, e.key));
      return json(201, created);
    }

    const state = /^\/flags\/([^/]+)\/environments\/([^/]+)$/.exec(tail);
    if (state && method === "PUT") {
      const denied = need("MEMBER") ?? writeBlocked();
      if (denied) return denied;
      const flag = flags.find((f) => f.id === state[1] && f.projectId === proj.id);
      if (!flag) return fail(404, "FLAG_NOT_FOUND", "Flag not found");
      const target = flag.environments.find((e) => e.environmentId === state[2]);
      if (!target) return fail(404, "ENVIRONMENT_NOT_FOUND", "Environment not found");

      const before = structuredClone(target);
      if (typeof body?.["enabled"] === "boolean") target.enabled = body["enabled"];
      if (typeof body?.["rolloutPercentage"] === "number") target.rolloutPercentage = body["rolloutPercentage"];
      if (Array.isArray(body?.["rules"])) target.rules = structuredClone(body["rules"]) as WireRule[];

      const where = { environmentKey: target.key, environmentId: target.environmentId };
      const targetingChanged = before.rolloutPercentage !== target.rolloutPercentage || JSON.stringify(before.rules) !== JSON.stringify(target.rules);
      if (before.enabled !== target.enabled) record("flag.toggled", flag, { ...where, from: before.enabled, to: target.enabled });
      if (targetingChanged) {
        record("flag.targeting_updated", flag, {
          ...where,
          before: { rules: before.rules, fallthroughBps: before.rolloutPercentage * 100 },
          after: { rules: target.rules, fallthroughBps: target.rolloutPercentage * 100 },
        });
      }
      if (before.enabled !== target.enabled || targetingChanged) {
        target.updatedAt = now();
        bump(target.environmentId);
      }
      return json(200, flag);
    }

    return fail(404, "NOT_FOUND", `Route not found: ${method} ${path}`);
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://api.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const path = url.pathname.replace(/^\/api/, "") + url.search;
    calls.push({ method, path, authorization: headers.get("Authorization") });

    inFlight++;
    try {
      await new Promise((resolve) => setTimeout(resolve, 0)); // answers are never synchronous, like a network
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (offline) throw new TypeError("Failed to fetch");

      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return await handle(method, path, body, headers.get("Authorization"), init?.signal);
    } finally {
      inFlight--;
    }
  };

  return {
    fetch: fetchImpl,
    reset,
    /** Every request received, in order. */
    get calls() {
      return calls;
    },
    requests: (method: string, path: string | RegExp) => calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path))),
    /** Resolves once no request has been in flight for a few turns: the app has finished loading. */
    async whenIdle() {
      for (let quiet = 0; quiet < 3; ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        quiet = inFlight === 0 ? quiet + 1 : 0;
      }
    },
    get openStreams() {
      return streams.size;
    },
    /** A signed-in session as the browser would have it after a reload: a refresh token in storage. */
    signIn() {
      const pair = issue();
      window.localStorage.setItem("ff.refresh", pair.refreshToken);
      return pair;
    },
    setRole(workspaceSlug: string, role: Role | null) {
      const id = WORKSPACES.find((w) => w.slug === workspaceSlug)!.id;
      if (role) roles[id] = role;
      else delete roles[id];
    },
    /** Access tokens are short-lived: this is "15 minutes later". Refresh tokens still work. */
    expireAccessTokens() {
      for (const entry of accessTokens.values()) entry.expired = true;
    },
    /** The refresh token was revoked (signed out elsewhere, or expired after 7 days). */
    revokeRefreshTokens() {
      refreshTokens.clear();
    },
    failNextWrite(error?: { status: number; code: string; message: string }) {
      failWrites = 1;
      if (error) failWith = error;
    },
    setOffline(value: boolean) {
      offline = value;
    },
    /** The network dropped, or the server restarted: every open stream ends. */
    dropStreams() {
      for (const stream of [...streams]) stream.close();
    },
    /**
     * A teammate changes a flag. Picks the next flag of the project in turn (predictable, not
     * random), flips it or raises its rollout, and announces it on the stream like any change.
     * `silently` skips the announcement: a change made while this client was disconnected.
     */
    remoteChange(projectKey: string, env: string, { silently = false } = {}) {
      const proj = PROJECTS.find((p) => p.key === projectKey)!;
      const candidates = flags.filter((f) => f.projectId === proj.id);
      const flag = candidates[remoteTurn++ % candidates.length]!;
      const target = flag.environments.find((e) => e.key === env)!;
      const where = { environmentKey: env, environmentId: target.environmentId };
      if (target.enabled && target.rolloutPercentage < 100) {
        const next = Math.min(100, target.rolloutPercentage + 10);
        record("flag.targeting_updated", flag, { ...where, before: { rules: target.rules, fallthroughBps: target.rolloutPercentage * 100 }, after: { rules: target.rules, fallthroughBps: next * 100 } }, "Jonas Reyes");
        target.rolloutPercentage = next;
      } else {
        record("flag.toggled", flag, { ...where, from: target.enabled, to: !target.enabled }, "Jonas Reyes");
        target.enabled = !target.enabled;
      }
      target.updatedAt = now();
      if (silently) versions.set(target.environmentId, (versions.get(target.environmentId) ?? 0) + 1);
      else bump(target.environmentId);
      return flag.key;
    },
  };
}

export type FakeServer = ReturnType<typeof createFakeServer>;

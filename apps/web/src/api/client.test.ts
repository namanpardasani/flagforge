import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { server } from "@/test/setup";
import { ApiError, configureApi, onSessionEnd, refreshSession, request, tokens } from "./client";

const workspaces = z.object({ workspaces: z.array(z.object({ slug: z.string() })) });
const refreshCalls = () => server.requests("POST", "/auth/refresh").length;
const caught = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);

beforeEach(() => configureApi({ baseUrl: "http://api.test", fetch: server.fetch }));

describe("sending requests", () => {
  it("sends the access token as a Bearer header and returns the checked body", async () => {
    tokens.set(server.signIn());
    const body = await request("GET", "/workspaces", { schema: workspaces });
    expect(body.workspaces.map((w) => w.slug)).toEqual(["halden", "orchard"]);
    expect(server.requests("GET", "/workspaces")[0]!.authorization).toMatch(/^Bearer access_/);
    expect(refreshCalls()).toBe(0);
  });

  it("after a reload (refresh token saved, no access token in memory) it refreshes first instead of sending a doomed request", async () => {
    server.signIn(); // only the refresh token is in storage
    await request("GET", "/workspaces", { schema: workspaces });
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /auth/refresh", "GET /workspaces"]);
  });

  it("never keeps the access token in storage", async () => {
    server.signIn();
    await request("GET", "/workspaces", { schema: workspaces });
    const stored = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage });
    expect(stored).not.toContain("access_");
    expect(tokens.access()).toMatch(/^access_/);
  });
});

describe("when the access token has expired (401)", () => {
  it("refreshes once, repeats the request once with the new token, and the caller never notices", async () => {
    server.signIn();
    await request("GET", "/workspaces", { schema: workspaces });
    const oldAccess = tokens.access();
    const oldRefresh = tokens.refreshToken();
    server.expireAccessTokens();

    const body = await request("GET", "/workspaces", { schema: workspaces });
    expect(body.workspaces).toHaveLength(2);
    expect(refreshCalls()).toBe(2); // the first load, and this one
    const attempts = server.requests("GET", "/workspaces");
    expect(attempts).toHaveLength(3); // ok, 401, ok
    expect(attempts[2]!.authorization).not.toBe(attempts[1]!.authorization);
    expect(tokens.access()).not.toBe(oldAccess);
    expect(tokens.refreshToken()).not.toBe(oldRefresh); // rotated: the old one is spent
  });

  it("many requests failing together share ONE refresh (a second would replay a spent token)", async () => {
    server.signIn();
    await request("GET", "/workspaces", { schema: workspaces });
    server.expireAccessTokens();
    const before = refreshCalls();

    const results = await Promise.all(Array.from({ length: 5 }, () => request("GET", "/workspaces", { schema: workspaces })));
    expect(results.every((r) => r.workspaces.length === 2)).toBe(true);
    expect(refreshCalls() - before).toBe(1);
    expect(tokens.hasRefreshToken()).toBe(true); // the family was not revoked
  });

  it("ends the session when the refresh token no longer works: tokens cleared, listeners told, a clear error", async () => {
    server.signIn();
    await request("GET", "/workspaces", { schema: workspaces });
    const ended = vi.fn();
    const stop = onSessionEnd(ended);
    server.expireAccessTokens();
    server.revokeRefreshTokens();

    const error = await caught(request("GET", "/workspaces", { schema: workspaces }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: "SESSION_EXPIRED" });
    expect(tokens.access()).toBeNull();
    expect(tokens.hasRefreshToken()).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
    stop();
  });

  it("retries only once: a 401 after a successful refresh is reported, not looped on", async () => {
    // A server that refreshes happily but rejects every other request.
    let refreshes = 0;
    let others = 0;
    configureApi({
      fetch: async (input) => {
        if (String(input).endsWith("/auth/refresh")) {
          refreshes++;
          return Response.json({ accessToken: `a${refreshes}`, refreshToken: `r${refreshes}` });
        }
        others++;
        return Response.json({ error: { code: "UNAUTHORIZED", message: "no" } }, { status: 401 });
      },
    });
    tokens.set({ accessToken: "a0", refreshToken: "r0" });

    const error = await caught(request("GET", "/workspaces", { schema: workspaces }));
    expect(error).toMatchObject({ status: 401, code: "SESSION_EXPIRED" });
    expect(others).toBe(2); // the original and exactly one retry
    expect(refreshes).toBe(1);
  });

  it("keeps the session when refreshing fails for a temporary reason (server down)", async () => {
    let healthy = false;
    configureApi({
      fetch: async (input) => {
        if (String(input).endsWith("/auth/refresh")) return healthy ? Response.json({ accessToken: "a1", refreshToken: "r1" }) : Response.json({ error: { code: "UNAVAILABLE", message: "down" } }, { status: 503 });
        return Response.json({ workspaces: [] });
      },
    });
    window.localStorage.setItem("ff.refresh", "r0");
    const ended = vi.fn();
    const stop = onSessionEnd(ended);

    expect(await caught(request("GET", "/workspaces", { schema: workspaces }))).toMatchObject({ status: 503 });
    expect(tokens.refreshToken()).toBe("r0"); // still there for the next attempt
    expect(ended).not.toHaveBeenCalled();

    healthy = true;
    await expect(request("GET", "/workspaces", { schema: workspaces })).resolves.toEqual({ workspaces: [] });
    stop();
  });

  it("with no session at all it fails at once without calling the server", async () => {
    expect(await caught(request("GET", "/workspaces", { schema: workspaces }))).toMatchObject({ code: "SESSION_EXPIRED" });
    expect(server.calls).toHaveLength(0);
    expect(await refreshSession()).toBe(false);
  });

  it("the sign-in route itself never triggers a refresh on 401 (wrong password is just wrong)", async () => {
    server.signIn();
    const error = await caught(request("POST", "/auth/login", { body: { email: "mira@halden.example", password: "nope" }, authenticated: false }));
    expect(error).toMatchObject({ status: 401, code: "INVALID_CREDENTIALS", message: "Invalid email or password" });
    expect(refreshCalls()).toBe(0);
    expect(server.requests("POST", "/auth/login")[0]!.authorization).toBeNull();
  });
});

describe("clear errors", () => {
  beforeEach(() => tokens.set(server.signIn()));

  it("carries the server's code, message and request id", async () => {
    const error = await caught(request("GET", "/workspaces/ws_nope/projects"));
    expect(error).toMatchObject({ status: 404, code: "WORKSPACE_NOT_FOUND", message: "Workspace not found", requestId: "req_test", isNotFound: true });
  });

  it("reports 403 as forbidden without ending the session", async () => {
    server.setRole("halden", "VIEWER");
    const error = await caught(request("GET", "/workspaces/ws_halden/audit-log"));
    expect(error).toMatchObject({ status: 403, isForbidden: true });
    expect(tokens.hasRefreshToken()).toBe(true);
  });

  it("turns a network failure into a readable error instead of a raw TypeError", async () => {
    server.setOffline(true);
    const error = await caught(request("GET", "/workspaces", { schema: workspaces }));
    expect(error).toMatchObject({ status: 0, code: "NETWORK", isOffline: true });
    expect(error!.message).toMatch(/Cannot reach the server/);
  });

  it("rejects a response with the wrong shape rather than passing it on", async () => {
    const error = await caught(request("GET", "/workspaces", { schema: z.object({ workspaces: z.array(z.object({ nope: z.string() })) }) }));
    expect(error).toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("copes with an error page that is not JSON", async () => {
    configureApi({ fetch: async () => new Response("<html>Bad gateway</html>", { status: 502 }) });
    const error = await caught(request("GET", "/workspaces", { schema: workspaces }));
    expect(error).toMatchObject({ status: 502, code: "HTTP_502" });
    expect(error!.message).toMatch(/server had a problem/);
  });
});

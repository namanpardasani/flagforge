import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { etagMatches } from "../src/routes/sdk.js";
import { makeApp, registerUser, resetDb, type TestUser } from "./helpers.js";

describe("etagMatches", () => {
  const etag = '"abc123"';
  it("matches exact, weak, listed and wildcard validators", () => {
    expect(etagMatches('"abc123"', etag)).toBe(true);
    expect(etagMatches('W/"abc123"', etag)).toBe(true);
    expect(etagMatches('"zzz", "abc123"', etag)).toBe(true);
    expect(etagMatches(' "zzz" ,W/"abc123" ', etag)).toBe(true);
    expect(etagMatches("*", etag)).toBe(true);
  });
  it("does not match different, missing or empty validators", () => {
    expect(etagMatches('"other"', etag)).toBe(false);
    expect(etagMatches('"abc1234"', etag)).toBe(false);
    expect(etagMatches("", etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
    expect(etagMatches("abc123", etag)).toBe(false); // unquoted is not a valid validator
  });
});

describe("GET /sdk/v1/flags conditional requests", () => {
  const app = makeApp();
  let owner: TestUser;
  let wsId: string;
  let projectId: string;
  let flagId: string;
  let devId: string;
  let prodId: string;
  let devKey: string;

  const post = (url: string, body: object = {}) => request(app).post(url).set("Authorization", owner.auth).send(body);
  const put = (url: string, body: object) => request(app).put(url).set("Authorization", owner.auth).send(body);
  const configure = (envId: string, body: object) =>
    put(`/workspaces/${wsId}/projects/${projectId}/flags/${flagId}/environments/${envId}`, body);
  const fetchFlags = () => request(app).get("/sdk/v1/flags").set("Authorization", `Bearer ${devKey}`);

  beforeEach(async () => {
    await resetDb();
    owner = await registerUser(app, "owner@example.com");
    wsId = (await post("/workspaces", { name: "Acme", slug: "acme" })).body.id;
    const project = (await post(`/workspaces/${wsId}/projects`, { name: "Web", key: "web" })).body;
    projectId = project.id;
    devId = project.environments.find((e: { key: string }) => e.key === "dev").id;
    prodId = project.environments.find((e: { key: string }) => e.key === "prod").id;
    flagId = (await post(`/workspaces/${wsId}/projects/${projectId}/flags`, { key: "checkout", name: "C" })).body.id;
    devKey = (await post(`/workspaces/${wsId}/projects/${projectId}/environments/${devId}/api-keys`, { name: "k" })).body.key;
  });

  it("returns an ETag, revalidation headers and the body on a plain request", async () => {
    const res = await fetchFlags();
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers["cache-control"]).toBe("private, no-cache");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.flags).toHaveLength(1);
  });

  it("answers 304 with no body when the ETag matches", async () => {
    const etag = (await fetchFlags()).headers["etag"]!;
    const res = await fetchFlags().set("If-None-Match", etag);
    expect(res.status).toBe(304);
    expect(res.text).toBe("");
  });

  it("still answers 304 when the client also sends Cache-Control: no-cache (what Node's fetch does)", async () => {
    const etag = (await fetchFlags()).headers["etag"]!;
    const res = await fetchFlags().set("If-None-Match", etag).set("Cache-Control", "no-cache").set("Pragma", "no-cache");
    expect(res.status).toBe(304);
  });

  it("accepts a weak validator and a wildcard", async () => {
    const etag = (await fetchFlags()).headers["etag"]!;
    expect((await fetchFlags().set("If-None-Match", `W/${etag}`)).status).toBe(304);
    expect((await fetchFlags().set("If-None-Match", "*")).status).toBe(304);
  });

  it("returns 200 with the full body when the ETag is stale", async () => {
    const res = await fetchFlags().set("If-None-Match", '"stale"');
    expect(res.status).toBe(200);
    expect(res.body.flags).toHaveLength(1);
  });

  it("changes the ETag when this environment's config changes, not when another environment's does", async () => {
    const before = (await fetchFlags()).headers["etag"]!;
    await configure(prodId, { enabled: true });
    expect((await fetchFlags().set("If-None-Match", before)).status).toBe(304); // dev unaffected
    await configure(devId, { enabled: true });
    const changed = await fetchFlags().set("If-None-Match", before);
    expect(changed.status).toBe(200);
    expect(changed.headers["etag"]).not.toBe(before);
    expect(changed.body.flags[0].enabled).toBe(true);
  });

  it("never answers 304 to an unauthenticated request, even with a matching ETag", async () => {
    const etag = (await fetchFlags()).headers["etag"]!;
    const res = await request(app).get("/sdk/v1/flags").set("If-None-Match", etag);
    expect(res.status).toBe(401);
    const bad = await request(app).get("/sdk/v1/flags").set("Authorization", "Bearer ff_wrong").set("If-None-Match", etag);
    expect(bad.status).toBe(401);
  });
});

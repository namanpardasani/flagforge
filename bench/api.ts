/** A minimal client for setting up benchmark data through the real public API. */
export const BASE = process.env["BASE_URL"] ?? "http://localhost:3070";

export async function call<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

/** A fresh account, workspace, project, `flagCount` flags and one API key for the prod environment. */
export async function setup(flagCount: number, base = BASE) {
  const post = <T = any>(path: string, body: unknown, token?: string) => // eslint-disable-line @typescript-eslint/no-explicit-any
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(async (r) => {
      if (!r.ok) throw new Error(`POST ${path} -> ${r.status} ${await r.text()}`);
      return (await r.json()) as T;
    });
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const token = (await post("/auth/register", { email: `bench-${tag}@flagforge.local`, password: `bench-${tag}-not-a-real-account`, name: "Benchmark" })).accessToken as string;
  const ws = await post("/workspaces", { name: `Bench ${tag}`, slug: `bench-${tag}` }, token);
  const project = await post(`/workspaces/${ws.id}/projects`, { name: "Bench", key: "bench" }, token);
  const env = project.environments.find((e: { key: string }) => e.key === "prod");
  const flagsPath = `/workspaces/${ws.id}/projects/${project.id}/flags`;
  const flags: { id: string; key: string }[] = [];
  for (let i = 0; i < flagCount; i++) {
    const flag = await post(flagsPath, { key: `bench-flag-${i}`, name: `Bench flag ${i}` }, token);
    flags.push({ id: flag.id, key: flag.key });
  }
  const apiKey = (await post(`/workspaces/${ws.id}/projects/${project.id}/environments/${env.id}/api-keys`, { name: "benchmark" }, token)).key as string;
  return { token, apiKey, flags, statePath: (flagId: string) => `${flagsPath}/${flagId}/environments/${env.id}` };
}

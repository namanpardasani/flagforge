import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const URL = "/w/halden/p/dispatch-api/audit-log";
const table = () => screen.getByRole("table", { name: "Audit log" });
const rowCount = () => within(table()).getAllByRole("row").length - 1;

describe("audit log page", () => {
  it("shows who did what, where, newest first", async () => {
    await renderApp(URL);
    await screen.findByRole("table", { name: "Audit log" });
    const rows = within(table()).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("route-optimizer-v2")).toBeInTheDocument(); // the newest seed entry
    expect(within(rows[0]!).getByText("Rollout 10% to 25%")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Mira Okafor")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Production")).toBeInTheDocument();
  });

  it("includes API key events, naming the key without its secret", async () => {
    const { user, router } = await renderApp("/w/halden/p/dispatch-api/api-keys", { env: "staging" });
    await user.click(await screen.findByRole("button", { name: "New key" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Billing worker");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));
    const secret = (await screen.findByRole("dialog", { name: "Copy your key now" })).querySelector("[data-secret]")!.textContent!;
    await user.click(screen.getByRole("button", { name: "I have saved it" }));

    await act(async () => {
      await router.navigate(URL);
    });
    const table = await screen.findByRole("table", { name: "Audit log" });
    expect(within(table).getByText("Billing worker")).toBeInTheDocument();
    expect(within(table).getByText(/Created key ff_/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(secret);
  });

  it("filters by kind and by search over what is loaded", async () => {
    const { user } = await renderApp(URL);
    await screen.findByRole("table", { name: "Audit log" });
    const everything = rowCount();
    expect(everything).toBe(6); // the six flag entries in the seed

    await user.type(screen.getByRole("searchbox", { name: "Search the audit log" }), "carrier");
    await waitFor(() => expect(rowCount()).toBe(1));
    await user.clear(screen.getByRole("searchbox", { name: "Search the audit log" }));

    await user.click(screen.getByRole("button", { name: "API keys" }));
    expect(await screen.findByText("Nothing matches.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Flags" }));
    await waitFor(() => expect(rowCount()).toBe(everything));
  });

  it("loads older entries a page at a time until there are none", async () => {
    server.addOldAuditEntries(120); // 6 seed + 120 = 126 entries: pages of 50, 50, 26
    const { user } = await renderApp(URL);
    await screen.findByRole("table", { name: "Audit log" });
    expect(rowCount()).toBe(50);
    expect(screen.getByText("50 of 50 loaded / older entries exist")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(rowCount()).toBe(100));
    await user.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(rowCount()).toBe(126));
    expect(screen.getByText("126 of 126 loaded / that is everything")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
    // No entry appears twice.
    const subjects = within(table()).getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(new Set(subjects).size).toBe(126);
  });

  it("explains itself to non-admins and does not ask the server", async () => {
    await renderApp(URL, { role: "MEMBER" });
    expect(await screen.findByText("The audit log is for admins")).toBeInTheDocument();
    expect(server.requests("GET", /audit-log/)).toHaveLength(0);
  });

  it("shows a retry when the server fails, and recovers", async () => {
    server.failNextGet(/audit-log/, 500);
    const { user } = await renderApp(URL);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the audit log");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Audit log" })).toBeInTheDocument();
  });
});

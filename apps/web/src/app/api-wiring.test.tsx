import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_USER } from "@/test/fake-server";
import { flagUrl, FLAGS_URL, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const hidden = { hidden: true };
const rows = () => within(screen.getByRole("list", { name: "Flags", ...hidden })).getAllByRole("listitem", hidden);
const rowFor = (key: string) => rows().find((row) => within(row).queryByRole("link", { name: key, ...hidden }))!;
const toggleIn = (key: string) => within(rowFor(key)).getByRole("switch", hidden);
const settle = () => act(() => server.whenIdle());

describe("signing in", () => {
  it("sends a signed-out visitor to the sign-in screen, then back to the page they asked for", async () => {
    const { user, router } = await renderApp(FLAGS_URL, { signedIn: false });
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in." })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(server.requests("GET", "/workspaces")).toHaveLength(0); // nothing was asked for without a session

    await user.type(screen.getByLabelText("Email"), TEST_USER.email);
    await user.type(screen.getByLabelText("Password"), TEST_USER.password);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("list", { name: "Flags" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(FLAGS_URL);
    expect(screen.getByRole("button", { name: `Account: ${TEST_USER.name}` })).toBeInTheDocument();
  });

  it("says so when the password is wrong, and stays put", async () => {
    const { user, router } = await renderApp("/login", { signedIn: false });
    await user.type(await screen.findByLabelText("Email"), TEST_USER.email);
    await user.type(screen.getByLabelText("Password"), "not the password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(router.state.location.pathname).toBe("/login");
    expect(window.localStorage.getItem("ff.refresh")).toBeNull();
  });

  it("restores the session after a reload from the saved refresh token", async () => {
    const { router } = await renderApp("/"); // signed in: only a refresh token in storage
    await screen.findByRole("heading", { level: 1 });
    expect(router.state.location.pathname).toBe("/w/halden/p/dispatch-api/overview");
    expect(server.calls[0]).toMatchObject({ method: "POST", path: "/auth/refresh" });
  });

  it("sends a new account with no workspace to first-run setup", async () => {
    server.setRole("halden", null);
    server.setRole("orchard", null);
    const { router } = await renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Set up your workspace." })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/welcome");
  });

  it("signing out revokes the token, clears what was cached and returns to sign-in", async () => {
    const { user, router } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await user.click(screen.getByRole("button", { name: `Account: ${TEST_USER.name}` }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in." })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(window.localStorage.getItem("ff.refresh")).toBeNull();
    await waitFor(() => expect(server.requests("POST", "/auth/logout")).toHaveLength(1));
    expect(screen.queryByText("route-optimizer-v2")).not.toBeInTheDocument();
    await waitFor(() => expect(server.openStreams).toBe(0)); // the live stream was closed too
  });
});

describe("a session that runs out", () => {
  it("refreshes quietly when only the access token has expired", async () => {
    const { user } = await renderApp(FLAGS_URL, { env: "staging" });
    await screen.findByRole("list", { name: "Flags" });
    server.expireAccessTokens();

    await user.click(toggleIn("eta-dark-launch"));
    await settle();
    expect(toggleIn("eta-dark-launch")).toBeChecked();
    expect(screen.queryByText(/Could not save/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in." })).not.toBeInTheDocument();
  });

  it("asks you to sign in again when the session cannot be refreshed, and says why", async () => {
    const { user } = await renderApp(FLAGS_URL, { env: "staging" });
    await screen.findByRole("list", { name: "Flags" });
    server.expireAccessTokens();
    server.revokeRefreshTokens();

    await user.click(toggleIn("eta-dark-launch"));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in." })).toBeInTheDocument();
    expect(screen.getByText(/Your session ended/)).toBeInTheDocument();
  });
});

describe("roles (the screen hides, the server decides)", () => {
  it("a viewer sees the flags but cannot switch or create them", async () => {
    await renderApp(FLAGS_URL, { role: "VIEWER" });
    await screen.findByRole("list", { name: "Flags" });
    expect(rows()).toHaveLength(6);
    expect(toggleIn("route-optimizer-v2")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "New flag" })).not.toBeInTheDocument();
    expect(within(rowFor("route-optimizer-v2")).queryByRole("button", { name: /Kill/ })).toBeNull();
  });

  it("a viewer can read targeting but every control is locked", async () => {
    await renderApp(flagUrl("instant-payouts"), { role: "VIEWER", env: "staging" });
    expect(await screen.findByRole("slider", { name: "Rollout percentage" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("combobox", { name: "Rule 1 attribute" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add rule" })).toBeDisabled();
    expect(screen.getByText("Your role can read targeting but not change it.")).toBeInTheDocument();
  });

  it("a member can switch flags, and is told the history is for admins instead of seeing an error", async () => {
    await renderApp("/w/halden/p/dispatch-api/overview", { role: "MEMBER" });
    expect(await screen.findByText("The change history is visible to workspace admins and owners.")).toBeInTheDocument();
    expect(server.requests("GET", /audit-log/)).toHaveLength(0); // not even requested
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("when the server says 403 anyway, the change is undone and the reason is shown", async () => {
    // The screen believes the user may edit (role was MEMBER when the page loaded), but the role
    // was lowered since. The server's answer is what counts.
    const { user } = await renderApp(FLAGS_URL, { role: "MEMBER", env: "staging" });
    await screen.findByRole("list", { name: "Flags" });
    server.setRole("halden", "VIEWER");

    await user.click(toggleIn("eta-dark-launch"));
    expect(await screen.findByText("Could not save eta-dark-launch")).toBeInTheDocument();
    expect(screen.getByText(/requires the MEMBER role or higher\. Nothing was changed\./)).toBeInTheDocument();
    await waitFor(() => expect(toggleIn("eta-dark-launch")).not.toBeChecked());
  });
});

describe("friendly 404 and failure states", () => {
  it("explains a workspace you cannot see, without revealing whether it exists", async () => {
    await renderApp("/w/acme-secret/p/web/flags");
    expect(await screen.findByRole("heading", { level: 2, name: "No workspace called acme-secret" })).toBeInTheDocument();
    expect(screen.getByText(/does not exist, or you are not a member/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to your workspace" })).toHaveAttribute("href", "/");
  });

  it("explains an unknown project and offers a real one", async () => {
    await renderApp("/w/halden/p/nope/flags");
    expect(await screen.findByRole("heading", { level: 2, name: "No project called nope" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Dispatch API" })).toHaveAttribute("href", "/w/halden/p/dispatch-api/overview");
  });

  it("shows a retry when the server cannot be reached, and recovers", async () => {
    server.signIn();
    server.setOffline(true);
    const { user } = await renderApp(FLAGS_URL, { signedIn: false });
    // Cannot confirm the session while offline: sign-in screen, token kept for later.
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in." })).toBeInTheDocument();
    expect(window.localStorage.getItem("ff.refresh")).not.toBeNull();

    server.setOffline(false);
    await user.type(screen.getByLabelText("Email"), TEST_USER.email);
    await user.type(screen.getByLabelText("Password"), TEST_USER.password);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("list", { name: "Flags" })).toBeInTheDocument();
  });

  it("says the server is unreachable on sign-in rather than blaming the password", async () => {
    server.setOffline(true);
    const { user } = await renderApp("/login", { signedIn: false });
    await user.type(await screen.findByLabelText("Email"), TEST_USER.email);
    await user.type(screen.getByLabelText("Password"), TEST_USER.password);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Cannot reach the server/);
  });
});

describe("creating a flag", () => {
  it("suggests a key from the name, creates it off everywhere, and shows it in the list", async () => {
    const { user } = await renderApp(FLAGS_URL);
    await user.click(await screen.findByRole("button", { name: "New flag" }));
    const dialog = await screen.findByRole("dialog", { name: "New flag in Dispatch API" });
    await user.type(within(dialog).getByLabelText("Name"), "Depot Heatmap");
    expect(within(dialog).getByLabelText("Key")).toHaveValue("depot-heatmap");
    await user.click(within(dialog).getByRole("button", { name: "Create flag" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("link", { name: "depot-heatmap" })).toBeInTheDocument();
    expect(toggleIn("depot-heatmap")).not.toBeChecked();
    expect(screen.getByText("depot-heatmap created")).toBeInTheDocument();
  });

  it("keeps the dialog open and shows the server's reason when the key is taken", async () => {
    const { user } = await renderApp(FLAGS_URL);
    await user.click(await screen.findByRole("button", { name: "New flag" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Again");
    await user.clear(within(dialog).getByLabelText("Key"));
    await user.type(within(dialog).getByLabelText("Key"), "route-optimizer-v2");
    await user.click(within(dialog).getByRole("button", { name: "Create flag" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A flag with this key already exists in the project");
  });
});

describe("the live stream", () => {
  it("opens one stream for the project, with the token in a header and never in the address", async () => {
    await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    const opened = server.requests("GET", /\/stream$/);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.authorization).toMatch(/^Bearer access_/);
    expect(opened[0]!.path).not.toMatch(/token|access_/);
    expect(server.openStreams).toBe(1);
  });

  it("does not flash your own change as if someone else made it", async () => {
    const { user } = await renderApp(FLAGS_URL, { env: "staging" });
    await screen.findByRole("list", { name: "Flags" });
    await user.click(toggleIn("eta-dark-launch"));
    await settle();
    // The stream announced our own write too. The row shows the local flash, not the remote one.
    expect(rowFor("eta-dark-launch").querySelector('[data-flash="remote"]')).toBeNull();
    expect(screen.queryByText("updated just now")).not.toBeInTheDocument();
  });

  it("does not flash rows for a change in an environment you are not looking at", async () => {
    await renderApp(FLAGS_URL, { env: "staging" });
    await screen.findByRole("list", { name: "Flags" });
    await act(async () => {
      server.remoteChange("dispatch-api", "prod");
      await server.whenIdle();
    });
    expect(document.querySelector('[data-flash="remote"]')).toBeNull();
  });

  it("reconnects after the connection drops and catches up on what it missed", async () => {
    await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    expect(within(rowFor("route-optimizer-v2")).getByText("25%")).toBeInTheDocument();

    await act(async () => {
      server.dropStreams();
      await server.whenIdle();
    });
    expect(server.openStreams).toBe(0);
    // While disconnected, a teammate raises the rollout. No event reaches this browser.
    server.remoteChange("dispatch-api", "prod", { silently: true });
    expect(within(rowFor("route-optimizer-v2")).getByText("25%")).toBeInTheDocument();

    // It reconnects by itself (after about a second). The hello carries a newer version, so it refetches.
    await waitFor(() => expect(server.openStreams).toBe(1), { timeout: 4000 });
    expect(await within(rowFor("route-optimizer-v2")).findByText("35%")).toBeInTheDocument();
    expect(rowFor("route-optimizer-v2").querySelector('[data-flash="remote"]')).not.toBeNull();
    expect(server.requests("GET", /\/stream$/)).toHaveLength(2);
  });

  it("reconnects without refetching when nothing changed while it was away", async () => {
    await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    const fetchesBefore = server.requests("GET", /\/flags$/).length;
    await act(async () => {
      server.dropStreams();
      await server.whenIdle();
    });
    await waitFor(() => expect(server.openStreams).toBe(1), { timeout: 4000 });
    await settle();
    expect(server.requests("GET", /\/flags$/)).toHaveLength(fetchesBefore);
    expect(document.querySelector('[data-flash="remote"]')).toBeNull();
  });

  it("closes the stream when you leave the project and opens one for the next", async () => {
    const { router } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await act(async () => {
      await router.navigate("/w/halden/p/driver-app/flags");
      await server.whenIdle();
    });
    expect(await screen.findByRole("link", { name: "shift-swap" })).toBeInTheDocument();
    expect(server.openStreams).toBe(1);
    expect(server.requests("GET", /\/stream$/).map((c) => c.path)).toEqual(["/workspaces/ws_halden/projects/pr_dispatch/stream", "/workspaces/ws_halden/projects/pr_driver/stream"]);
  });
});

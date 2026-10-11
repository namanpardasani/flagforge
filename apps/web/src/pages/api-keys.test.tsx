import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const KEYS_URL = "/w/halden/p/dispatch-api/api-keys";
const settle = () => act(() => server.whenIdle());

describe("API keys page", () => {
  it("lists the keys of the environment being viewed, showing only a prefix", async () => {
    await renderApp(KEYS_URL);
    const table = await screen.findByRole("table", { name: "API keys for Production" });
    expect(within(table).getByText("Checkout service")).toBeInTheDocument();
    expect(within(table).getByText("ff_Qm2xK8v…")).toBeInTheDocument();
  });

  it("shows the other environments' keys on their own tabs", async () => {
    const { user } = await renderApp(KEYS_URL);
    await screen.findByRole("table", { name: "API keys for Production" });
    await user.click(screen.getByRole("tab", { name: "Staging" }));
    expect(await screen.findByText("No keys for Staging yet")).toBeInTheDocument();
  });

  it("creates a key, shows the secret once, and never again", async () => {
    const { user } = await renderApp(KEYS_URL, { env: "staging" });
    await user.click(await screen.findByRole("button", { name: "New key" }));
    const dialog = await screen.findByRole("dialog", { name: "New key for Staging" });
    await user.type(within(dialog).getByLabelText("Name"), "Worker");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    const secretDialog = await screen.findByRole("dialog", { name: "Copy your key now" });
    const secret = secretDialog.querySelector("[data-secret]")!.textContent!;
    expect(secret).toMatch(/^ff_/);
    expect(secret.length).toBeGreaterThan(20);

    // A stray Escape must not throw the secret away.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Copy your key now" })).toBeInTheDocument();

    await user.click(within(secretDialog).getByRole("button", { name: "I have saved it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // The list shows the prefix only, and the full secret is nowhere on the page.
    const table = await screen.findByRole("table", { name: "API keys for Staging" });
    expect(within(table).getByText("Worker")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(secret);
  });

  it("revokes a key after confirmation, and the row is marked revoked", async () => {
    const { user } = await renderApp(KEYS_URL, { env: "staging" });
    await user.click(await screen.findByRole("button", { name: "New key" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Old worker");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));
    await user.click(await screen.findByRole("button", { name: "I have saved it" }));

    await user.click(await screen.findByRole("button", { name: "Revoke Old worker" }));
    const confirm = await screen.findByRole("dialog", { name: "Revoke Old worker?" });
    await user.click(within(confirm).getByRole("button", { name: "Revoke key" }));
    expect(await screen.findByText("Key revoked")).toBeInTheDocument();
    const row = (await screen.findByText("Old worker")).closest("tr")!;
    await waitFor(() => expect(within(row).getByText("Revoked")).toBeInTheDocument());
    expect(within(row).queryByRole("button", { name: /Revoke/ })).toBeNull();
  });

  it("in Production, revoking needs the hold, and a plain click does nothing", async () => {
    const { user } = await renderApp(KEYS_URL);
    await user.click(await screen.findByRole("button", { name: "Revoke Checkout service" }));
    const confirm = await screen.findByRole("dialog", { name: "Revoke Checkout service?" });
    expect(within(confirm).getByRole("button", { name: "Hold to revoke" })).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Hold to revoke" }));
    await settle();
    expect(server.requests("DELETE", /api-keys/)).toHaveLength(0);
  });

  it("tells non-admins that keys are managed by admins, without asking the server", async () => {
    await renderApp(KEYS_URL, { role: "MEMBER" });
    expect(await screen.findByText("Keys are managed by admins")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New key" })).not.toBeInTheDocument();
    expect(server.requests("GET", /api-keys/)).toHaveLength(0);
  });

  it("when the server refuses anyway (403), says why and shows no key", async () => {
    // The screen believes the user is an admin (role at load time); the role was lowered since.
    const { user } = await renderApp(KEYS_URL, { env: "staging" });
    await screen.findByRole("button", { name: "New key" });
    server.setRole("halden", "MEMBER");
    await user.click(screen.getByRole("button", { name: "New key" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Sneaky");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("requires the ADMIN role or higher");
    expect(screen.queryByRole("dialog", { name: "Copy your key now" })).not.toBeInTheDocument();
  });
});

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { memberActions, type Member } from "@/api/types";
import { renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const URL = "/w/halden/p/dispatch-api/members";
const rowOf = (name: string) => within(screen.getByRole("table", { name: "Workspace members" })).getByText(name).closest("tr")!;

describe("members page", () => {
  it("lists everyone with their role, marking the signed-in person", async () => {
    await renderApp(URL);
    const table = await screen.findByRole("table", { name: "Workspace members" });
    expect(within(table).getAllByRole("row")).toHaveLength(4); // header + 3
    expect(within(rowOf("Mira Okafor")).getByText("you")).toBeInTheDocument();
    expect(within(rowOf("Jonas Reyes")).getByRole("combobox", { name: "Role of Jonas Reyes" })).toHaveValue("ADMIN");
    expect(screen.getByText("3 members")).toBeInTheDocument();
  });

  it("the owner cannot be changed, removed or demoted, and cannot remove themself", async () => {
    await renderApp(URL);
    await screen.findByRole("table", { name: "Workspace members" });
    const me = rowOf("Mira Okafor");
    expect(within(me).queryByRole("combobox")).toBeNull();
    expect(within(me).queryByRole("button")).toBeNull();
    expect(within(me).getByText("Owner")).toBeInTheDocument();
  });

  it("changes a role", async () => {
    const { user } = await renderApp(URL);
    await screen.findByRole("table", { name: "Workspace members" });
    await user.selectOptions(within(rowOf("Tove Lind")).getByRole("combobox"), "VIEWER");
    expect(await screen.findByText("Tove Lind is now viewer")).toBeInTheDocument();
    await waitFor(() => expect(within(rowOf("Tove Lind")).getByRole("combobox")).toHaveValue("VIEWER"));
  });

  it("adds a member by email, and says so when there is no such account", async () => {
    const { user } = await renderApp(URL);
    await user.click(await screen.findByRole("button", { name: "Add member" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a member" });
    await user.type(within(dialog).getByLabelText("Email"), "ghost@nowhere.example");
    await user.click(within(dialog).getByRole("button", { name: "Add member" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("No user with this email");

    await user.clear(within(dialog).getByLabelText("Email"));
    await user.type(within(dialog).getByLabelText("Email"), "nils@halden.example");
    await user.selectOptions(within(dialog).getByLabelText("Role"), "VIEWER");
    await user.click(within(dialog).getByRole("button", { name: "Add member" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Nils Berg added")).toBeInTheDocument();
    expect(within(rowOf("Nils Berg")).getByRole("combobox")).toHaveValue("VIEWER");
  });

  it("removes a member only after confirming", async () => {
    const { user } = await renderApp(URL);
    await screen.findByRole("table", { name: "Workspace members" });
    await user.click(within(rowOf("Tove Lind")).getByRole("button", { name: "Remove Tove Lind" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Tove Lind?" });
    expect(server.requests("DELETE", /members/)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Remove member" }));
    expect(await screen.findByText("Tove Lind removed")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Tove Lind", { selector: "span" })).not.toBeInTheDocument());
  });

  it("an admin can manage members and viewers but not other admins, and cannot offer the admin role", async () => {
    const { user } = await renderApp(URL, { role: "ADMIN" });
    await screen.findByRole("table", { name: "Workspace members" });
    expect(within(rowOf("Jonas Reyes")).queryByRole("combobox")).toBeNull(); // another admin: read only
    expect(within(rowOf("Jonas Reyes")).queryByRole("button")).toBeNull();
    const options = within(within(rowOf("Tove Lind")).getByRole("combobox")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Member", "Viewer"]);

    await user.click(screen.getByRole("button", { name: "Add member" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a member" });
    expect(within(within(dialog).getByLabelText("Role")).queryByRole("option", { name: "Admin" })).toBeNull();
  });

  it("a member or viewer sees the list but has no controls, apart from leaving", async () => {
    await renderApp(URL, { role: "MEMBER" });
    await screen.findByRole("table", { name: "Workspace members" });
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(within(rowOf("Mira Okafor")).getByRole("button", { name: "Leave workspace" })).toBeInTheDocument();
  });

  it("leaving sends you to what is left of your account", async () => {
    const { user } = await renderApp(URL, { role: "MEMBER" });
    await user.click(await screen.findByRole("button", { name: "Leave workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave Halden Freight?" });
    await user.click(within(dialog).getByRole("button", { name: "Leave workspace" }));
    await waitFor(() => expect(server.requests("DELETE", /members\/u_mira/)).toHaveLength(1));
  });

  it("when the server refuses anyway (403), shows the reason and changes nothing", async () => {
    const { user } = await renderApp(URL, { role: "ADMIN" });
    await screen.findByRole("table", { name: "Workspace members" });
    server.setRole("halden", "MEMBER"); // demoted since the page loaded
    await user.selectOptions(within(rowOf("Tove Lind")).getByRole("combobox"), "VIEWER");
    expect(await screen.findByText("Could not change the role")).toBeInTheDocument();
    expect(screen.getByText(/requires the ADMIN role or higher/)).toBeInTheDocument();
    // Nothing changed: after the refresh Tove is still a member.
    await waitFor(() => expect(within(rowOf("Tove Lind")).getByRole("combobox")).toHaveValue("MEMBER"));
  });
});

describe("memberActions (mirrors the server's rules)", () => {
  const person = (userId: string, role: Member["role"]): Member => ({ userId, name: userId, email: `${userId}@x`, role, joinedAt: "" });
  const acting = (role: Member["role"] | undefined) => ({ id: "me", role });

  it("the owner can change and remove admins, members and viewers", () => {
    for (const role of ["ADMIN", "MEMBER", "VIEWER"] as const) {
      const actions = memberActions(acting("OWNER"), person("x", role));
      expect(actions.roles).toEqual(["ADMIN", "MEMBER", "VIEWER"]);
      expect(actions.canRemove).toBe(true);
    }
  });

  it("nobody can change or remove the owner", () => {
    for (const role of ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const) {
      const actions = memberActions(acting(role), person("boss", "OWNER"));
      expect(actions.roles).toEqual([]);
      expect(actions.canRemove).toBe(false);
    }
  });

  it("an admin cannot touch other admins or hand out admin", () => {
    expect(memberActions(acting("ADMIN"), person("x", "ADMIN"))).toMatchObject({ roles: [], canRemove: false });
    expect(memberActions(acting("ADMIN"), person("x", "MEMBER"))).toMatchObject({ roles: ["MEMBER", "VIEWER"], canRemove: true });
  });

  it("members and viewers can change nobody, and nobody can change their own role", () => {
    expect(memberActions(acting("MEMBER"), person("x", "VIEWER"))).toMatchObject({ roles: [], canRemove: false });
    expect(memberActions({ id: "me", role: "ADMIN" }, person("me", "ADMIN"))).toMatchObject({ roles: [], canRemove: false, canLeave: true });
  });

  it("everyone but the owner may leave", () => {
    expect(memberActions({ id: "me", role: "VIEWER" }, person("me", "VIEWER")).canLeave).toBe(true);
    expect(memberActions({ id: "me", role: "OWNER" }, person("me", "OWNER")).canLeave).toBe(false);
  });
});

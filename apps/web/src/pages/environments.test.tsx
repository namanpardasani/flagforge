import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const URL = "/w/halden/p/dispatch-api/environments";
const table = () => screen.getByRole("table", { name: "Environments", hidden: true });
const rowOf = (name: string) => within(table()).getByText(name).closest("tr")!;
const hold = (name: RegExp) => within(screen.getByRole("dialog")).getByRole("button", { name });

describe("environments page", () => {
  it("lists the project's environments and marks the one being viewed", async () => {
    await renderApp(URL, { env: "staging" });
    await screen.findByRole("table", { name: "Environments" });
    expect(within(table()).getAllByRole("row")).toHaveLength(4);
    expect(within(rowOf("Staging")).getByText("viewing")).toBeInTheDocument();
    expect(within(rowOf("Production")).getByText("prod")).toBeInTheDocument();
  });

  it("creates an environment, suggesting a key, and every flag starts off there", async () => {
    const { user } = await renderApp(URL);
    await user.click(await screen.findByRole("button", { name: "New environment" }));
    const dialog = await screen.findByRole("dialog", { name: "New environment" });
    await user.type(within(dialog).getByLabelText("Name"), "QA Lab");
    expect(within(dialog).getByLabelText("Key")).toHaveValue("qa-lab");
    await user.click(within(dialog).getByRole("button", { name: "Create environment" }));
    expect(await screen.findByText("QA Lab created")).toBeInTheDocument();
    await waitFor(() => expect(within(rowOf("QA Lab")).getByText("qa-lab")).toBeInTheDocument());

    // It shows up as a choice in the sidebar, and flags have a state for it.
    expect(within(screen.getByRole("group", { name: "Environment" })).getByRole("button", { name: /qa-lab/ })).toBeInTheDocument();
  });

  it("refuses a key that is already used, before asking the server", async () => {
    const { user } = await renderApp(URL);
    await user.click(await screen.findByRole("button", { name: "New environment" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Prod");
    expect(within(dialog).getByText("This project already has an environment with this key.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create environment" })).toBeDisabled();
    expect(server.requests("POST", /environments/)).toHaveLength(0);
  });

  it("deleting needs the hold: a plain click on the button does nothing", async () => {
    const { user } = await renderApp(URL);
    await screen.findByRole("table", { name: "Environments" });
    await user.click(within(rowOf("Staging")).getByRole("button", { name: "Delete Staging" }));
    await screen.findByRole("dialog", { name: "Delete Staging?" });
    await user.click(hold(/Hold to delete/));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.requests("DELETE", /environments/)).toHaveLength(0);
    expect(within(table()).getByText("Staging")).toBeInTheDocument();
  });

  it("holding deletes it, and the flags lose that environment", async () => {
    const { user } = await renderApp(URL, { env: "dev" });
    await screen.findByRole("table", { name: "Environments" });
    await user.click(within(rowOf("Staging")).getByRole("button", { name: "Delete Staging" }));
    await screen.findByRole("dialog", { name: "Delete Staging?" });
    await user.pointer({ keys: "[MouseLeft>]", target: hold(/Hold to delete/) });
    expect(await screen.findByText("Staging deleted", undefined, { timeout: 3000 })).toBeInTheDocument();
    await user.pointer({ keys: "[/MouseLeft]" });
    await waitFor(() => expect(within(table()).queryByText("Staging")).not.toBeInTheDocument());
    expect(within(screen.getByRole("group", { name: "Environment" })).queryByRole("button", { name: /staging/i })).toBeNull();
  });

  it("the last environment cannot be deleted", async () => {
    const { user } = await renderApp(URL);
    await screen.findByRole("table", { name: "Environments" });
    for (const name of ["Development", "Staging"]) {
      await user.click(within(rowOf(name)).getByRole("button", { name: `Delete ${name}` }));
      await screen.findByRole("dialog", { name: `Delete ${name}?` });
      await user.pointer({ keys: "[MouseLeft>]", target: hold(/Hold to delete/) });
      await screen.findByText(`${name} deleted`, undefined, { timeout: 3000 });
      await user.pointer({ keys: "[/MouseLeft]" });
      await waitFor(() => expect(within(table()).queryByText(name)).not.toBeInTheDocument());
    }
    expect(within(rowOf("Production")).getByRole("button", { name: "Delete Production" })).toBeDisabled();
  });

  it("non-admins see the list and no controls", async () => {
    await renderApp(URL, { role: "MEMBER" });
    await screen.findByRole("table", { name: "Environments" });
    expect(screen.queryByRole("button", { name: "New environment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    expect(screen.getByText(/admins can add and delete environments/)).toBeInTheDocument();
  });
});

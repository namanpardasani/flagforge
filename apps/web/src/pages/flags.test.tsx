import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { flagUrl, FLAGS_URL, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

// `hidden: true` because an open dialog marks the page behind it aria-hidden, and these helpers
// are also used to check that the page behind did NOT change.
const hidden = { hidden: true };
const list = () => screen.getByRole("list", { name: "Flags", ...hidden });
const rows = () => within(list()).getAllByRole("listitem", hidden);
const rowFor = (key: string) => rows().find((row) => within(row).queryByRole("link", { name: key, ...hidden }))!;
const toggleIn = (key: string) => within(rowFor(key)).getByRole("switch", hidden);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A teammate changes the next flag. The server announces it on the live stream, like any change. */
async function simulateRemoteUpdate(env = "prod") {
  await act(async () => {
    server.remoteChange("dispatch-api", env);
    await server.whenIdle();
  });
}

describe("flag list", () => {
  it("shows every flag with its state in the chosen environment", async () => {
    await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    expect(rows()).toHaveLength(6);
    expect(toggleIn("route-optimizer-v2")).toBeChecked();
    expect(toggleIn("instant-payouts")).not.toBeChecked();
    expect(within(rowFor("route-optimizer-v2")).getByText("25%")).toBeInTheDocument();
    expect(within(rowFor("instant-payouts")).getByText("2 rules")).toBeInTheDocument();
  });

  it("searches by key, name or description, and says when nothing matches", async () => {
    const { user } = await renderApp(FLAGS_URL);
    const search = await screen.findByRole("searchbox", { name: "Search flags" });
    await user.type(search, "labels");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rowFor("bulk-label-print")).toBeDefined();
    await user.clear(search);
    await user.type(search, "zzzz");
    expect(await screen.findByText('Nothing matches "zzzz".')).toBeInTheDocument();
  });

  it("sorts by key and by state", async () => {
    const { user } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    const keys = () => rows().map((row) => within(row).getAllByRole("link")[0]!.textContent);
    expect(keys()[0]).toBe("route-optimizer-v2"); // most recently updated first

    await user.click(screen.getByRole("button", { name: "Key" }));
    expect(keys()).toEqual([...keys()].sort());
    expect(screen.getByRole("button", { name: "Key" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "State" }));
    expect(keys().slice(0, 2).sort()).toEqual(["carrier-rate-cache", "route-optimizer-v2"]); // the two that are on
  });

  it("opens a flag from its key", async () => {
    const { user, router } = await renderApp(FLAGS_URL);
    await user.click(await screen.findByRole("link", { name: "instant-payouts" }));
    // The detail screen is a lazily loaded route, so the address changes a moment after the click.
    expect(await screen.findByRole("heading", { level: 1, name: "instant-payouts" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(flagUrl("instant-payouts"));
  });

  it("copies a key from the quick actions", async () => {
    const { user } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await user.click(within(rowFor("eta-dark-launch")).getByRole("button", { name: "Copy key eta-dark-launch" }));
    expect(await navigator.clipboard.readText()).toBe("eta-dark-launch");
    expect(await screen.findByText("Key copied")).toBeInTheDocument();
  });
});

describe("toggling outside Production", () => {
  it("applies at once, updates the counts and confirms with a toast", async () => {
    const { user } = await renderApp(FLAGS_URL, { env: "staging" });
    await screen.findByRole("list", { name: "Flags" });
    expect(screen.getByRole("tab", { name: /On/ })).toHaveTextContent("04");

    await user.click(toggleIn("eta-dark-launch"));
    expect(toggleIn("eta-dark-launch")).toBeChecked();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); // no confirmation outside Production
    expect(await screen.findByText("eta-dark-launch turned on")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("tab", { name: /On/ })).toHaveTextContent("05"));
  });

  it("plays the ember bloom only when turning ON", async () => {
    const { user } = await renderApp(FLAGS_URL, { env: "staging" });
    await screen.findByRole("list", { name: "Flags" });
    expect(document.querySelector("[data-bloom]")).toBeNull(); // not on first render, even for flags already on

    await user.click(toggleIn("eta-dark-launch")); // off -> on
    expect(rowFor("eta-dark-launch").querySelector("[data-bloom]")).not.toBeNull();

    await user.click(toggleIn("bulk-label-print")); // on -> off
    expect(rowFor("bulk-label-print").querySelector("[data-bloom]")).toBeNull();
  });

  it("can be flipped from the keyboard", async () => {
    const { user } = await renderApp(FLAGS_URL, { env: "dev" });
    await screen.findByRole("list", { name: "Flags" });
    toggleIn("strict-address-check").focus();
    await user.keyboard(" ");
    expect(toggleIn("strict-address-check")).toBeChecked();
    await user.keyboard("{Enter}");
    expect(toggleIn("strict-address-check")).not.toBeChecked();
  });

  it("puts the switch back and says so when the server refuses (optimistic rollback)", async () => {
    const { user } = await renderApp(FLAGS_URL, { env: "staging" });
    await screen.findByRole("list", { name: "Flags" });
    server.failNextWrite();

    await user.click(toggleIn("eta-dark-launch"));
    expect(await screen.findByText("Could not save eta-dark-launch")).toBeInTheDocument();
    await waitFor(() => expect(toggleIn("eta-dark-launch")).not.toBeChecked());
  });
});

describe("Production kill switch (hold to confirm)", () => {
  const dialog = () => screen.getByRole("dialog", { name: "Turn off route-optimizer-v2 in Production?" });
  const holdButton = () => within(dialog()).getByRole("button", { name: /Hold to turn off|Keep holding/ });

  it("asks first: clicking the switch changes nothing by itself", async () => {
    const { user } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await user.click(toggleIn("route-optimizer-v2"));
    expect(dialog()).toBeInTheDocument();
    expect(toggleIn("route-optimizer-v2")).toBeChecked();
  });

  it("a plain click on the hold button does nothing", async () => {
    const { user } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await user.click(toggleIn("route-optimizer-v2"));
    await user.click(holdButton());
    await sleep(150);
    expect(dialog()).toBeInTheDocument();
    expect(toggleIn("route-optimizer-v2")).toBeChecked();
  });

  it("releasing early cancels, and the flag stays on", async () => {
    const { user } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await user.click(toggleIn("route-optimizer-v2"));
    await user.pointer({ keys: "[MouseLeft>]", target: holdButton() });
    await sleep(300); // less than the 700ms it needs
    await user.pointer({ keys: "[/MouseLeft]" });
    await sleep(600); // long enough that it WOULD have fired had the release been ignored
    expect(dialog()).toBeInTheDocument();
    expect(toggleIn("route-optimizer-v2")).toBeChecked();
    expect(screen.queryByText("route-optimizer-v2 turned off")).not.toBeInTheDocument();
  });

  it("holding for the full 700ms turns it off, flashes the row, shows a toast and closes the dialog", async () => {
    const { user } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await user.click(toggleIn("route-optimizer-v2"));

    const started = Date.now();
    await user.pointer({ keys: "[MouseLeft>]", target: holdButton() });
    await waitFor(() => expect(toggleIn("route-optimizer-v2")).not.toBeChecked(), { timeout: 2500 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(650); // it really waited

    expect(rowFor("route-optimizer-v2").querySelector('[data-flash="kill"]')).not.toBeNull();
    expect(await screen.findByText("route-optimizer-v2 turned off")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("tab", { name: /On/ })).toHaveTextContent("01"));
  });

  it("works from the keyboard by holding Enter", async () => {
    const { user } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await user.click(toggleIn("carrier-rate-cache"));
    const button = within(screen.getByRole("dialog")).getByRole("button", { name: /Hold to turn off/ });
    button.focus();
    await user.keyboard("{Enter>}"); // press and keep down
    await waitFor(() => expect(toggleIn("carrier-rate-cache")).not.toBeChecked(), { timeout: 2500 });
    await user.keyboard("{/Enter}");
  });

  it("Escape or Cancel leaves everything as it was", async () => {
    const { user } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await user.click(toggleIn("route-optimizer-v2"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(toggleIn("route-optimizer-v2")).toBeChecked();

    await user.click(toggleIn("route-optimizer-v2"));
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(toggleIn("route-optimizer-v2")).toBeChecked();
  });

  it("turning a flag ON in Production also needs the hold", async () => {
    const { user } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await user.click(toggleIn("instant-payouts"));
    const confirm = screen.getByRole("dialog", { name: "Turn on instant-payouts in Production?" });
    expect(within(confirm).getByRole("button", { name: /Hold to turn on/ })).toBeInTheDocument();
    expect(toggleIn("instant-payouts")).not.toBeChecked();
  });

  it("offers a Kill quick action only for flags that are on, and only in Production", async () => {
    const prod = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    expect(within(rowFor("route-optimizer-v2")).getByRole("button", { name: "Kill route-optimizer-v2 in Production" })).toBeInTheDocument();
    expect(within(rowFor("instant-payouts")).queryByRole("button", { name: /Kill/ })).toBeNull();

    await prod.user.click(within(rowFor("route-optimizer-v2")).getByRole("button", { name: /Kill/ }));
    expect(dialog()).toBeInTheDocument();
  });
});

describe("live updates", () => {
  it("applies a change made elsewhere, flashes that row ember and tags it", async () => {
    await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    expect(within(rowFor("route-optimizer-v2")).getByText("25%")).toBeInTheDocument();

    await simulateRemoteUpdate();
    const row = rowFor("route-optimizer-v2");
    expect(await within(row).findByText("35%")).toBeInTheDocument();
    expect(within(row).getByText("updated just now")).toBeInTheDocument();
    expect(row.querySelector('[data-flash="remote"]')).not.toBeNull();
    // The other rows are not flashed or tagged.
    expect(rowFor("carrier-rate-cache").querySelector("[data-flash]")).toBeNull();
    expect(screen.getAllByText("updated just now")).toHaveLength(1);
  });

  it("moves through the flags in turn, so the demo is predictable", async () => {
    await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await simulateRemoteUpdate(); // first flag: rollout 25 -> 35
    await simulateRemoteUpdate(); // second flag: carrier-rate-cache turned off
    await waitFor(() => expect(toggleIn("carrier-rate-cache")).not.toBeChecked());
    expect(rowFor("carrier-rate-cache").querySelector('[data-flash="remote"]')).not.toBeNull();
  });
});

describe("flag detail", () => {
  it("shows the flag, its rollout, rules and history", async () => {
    await renderApp(flagUrl("route-optimizer-v2"));
    expect(await screen.findByRole("heading", { level: 1, name: "route-optimizer-v2" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Rollout percentage" })).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByRole("img", { name: /25 of 100 sample users/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Rule 1 attribute" })).toHaveValue("depot");
    expect(screen.getByText("Rollout 10% to 25%")).toBeInTheDocument();
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).getByText("route-optimizer-v2")).toHaveAttribute("aria-current", "page");
  });

  it("explains itself when the flag does not exist", async () => {
    await renderApp(flagUrl("no-such-flag"));
    expect(await screen.findByRole("heading", { level: 2, name: "No flag called no-such-flag" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to all flags" })).toHaveAttribute("href", FLAGS_URL);
  });

  it("previews a rollout change without saving it: the grid lights exactly the new share", async () => {
    const { user } = await renderApp(flagUrl("bulk-label-print"), { env: "staging" });
    const slider = await screen.findByRole("slider", { name: "Rollout percentage" });
    expect(slider).toHaveAttribute("aria-valuenow", "50");
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument();

    slider.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(slider).toHaveAttribute("aria-valuenow", "53");
    expect(screen.getByRole("img", { name: /53 of 100 sample users/ })).toBeInTheDocument();
    expect(screen.getByText("/ +3 new")).toBeInTheDocument();
    // Exactly three squares are marked as added; none removed.
    expect(document.querySelectorAll('[data-state="added"]')).toHaveLength(3);
    expect(document.querySelectorAll('[data-state="removed"]')).toHaveLength(0);
    expect(await screen.findByRole("region", { name: "Unsaved changes" })).toBeInTheDocument();
  });

  it("marks squares that would be REMOVED when the rollout is lowered", async () => {
    const { user } = await renderApp(flagUrl("bulk-label-print"), { env: "staging" });
    const slider = await screen.findByRole("slider", { name: "Rollout percentage" });
    slider.focus();
    await user.keyboard("{PageDown}"); // minus 10
    expect(slider).toHaveAttribute("aria-valuenow", "40");
    expect(document.querySelectorAll('[data-state="removed"]')).toHaveLength(10);
    expect(screen.getByText("/ -10 removed")).toBeInTheDocument();
  });

  it("Discard puts the draft back", async () => {
    const { user } = await renderApp(flagUrl("bulk-label-print"), { env: "staging" });
    const slider = await screen.findByRole("slider", { name: "Rollout percentage" });
    slider.focus();
    await user.keyboard("{End}");
    expect(slider).toHaveAttribute("aria-valuenow", "100");
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(slider).toHaveAttribute("aria-valuenow", "50");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument());
  });

  it("applies in Staging with one click, then records the change", async () => {
    const { user } = await renderApp(flagUrl("bulk-label-print"), { env: "staging" });
    const slider = await screen.findByRole("slider", { name: "Rollout percentage" });
    slider.focus();
    await user.keyboard("{PageUp}");
    await user.click(await screen.findByRole("button", { name: "Apply to Staging" }));

    expect(await screen.findByText("Targeting saved for bulk-label-print")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument());
    expect(slider).toHaveAttribute("aria-valuenow", "60");
    expect(await screen.findByText("Rollout 50% to 60%")).toBeInTheDocument(); // appears in the history
  });

  it("in Production, applying needs the hold: a click does nothing", async () => {
    const { user } = await renderApp(flagUrl("route-optimizer-v2"));
    const slider = await screen.findByRole("slider", { name: "Rollout percentage" });
    slider.focus();
    await user.keyboard("{PageUp}");
    const hold = await screen.findByRole("button", { name: "Hold to apply to Production" });
    expect(screen.queryByRole("button", { name: /^Apply to/ })).not.toBeInTheDocument();

    await user.click(hold);
    await sleep(200);
    expect(screen.queryByText("Targeting saved for route-optimizer-v2")).not.toBeInTheDocument();

    await user.pointer({ keys: "[MouseLeft>]", target: hold });
    expect(await screen.findByText("Targeting saved for route-optimizer-v2", undefined, { timeout: 2500 })).toBeInTheDocument();
    await user.pointer({ keys: "[/MouseLeft]" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument());
  });

  it("the header toggle goes through the same Production guard", async () => {
    const { user } = await renderApp(flagUrl("route-optimizer-v2"));
    await user.click(await screen.findByRole("switch", { name: "Route optimizer v2 in Production" }));
    expect(screen.getByRole("dialog", { name: "Turn off route-optimizer-v2 in Production?" })).toBeInTheDocument();
  });

  it("follows a live update when there are no local edits", async () => {
    await renderApp(flagUrl("route-optimizer-v2"));
    const slider = await screen.findByRole("slider", { name: "Rollout percentage" });
    await simulateRemoteUpdate(); // route-optimizer-v2: 25 -> 35
    await waitFor(() => expect(slider).toHaveAttribute("aria-valuenow", "35"));
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).not.toBeInTheDocument();
    expect(screen.getByText("updated just now")).toBeInTheDocument();
  });

  it("keeps your edits and warns you when a live update arrives while you are editing", async () => {
    const { user } = await renderApp(flagUrl("route-optimizer-v2"));
    const slider = await screen.findByRole("slider", { name: "Rollout percentage" });
    slider.focus();
    await user.keyboard("{Home}"); // local edit: 0%
    await simulateRemoteUpdate(); // meanwhile someone sets 35%

    expect(slider).toHaveAttribute("aria-valuenow", "0"); // your edit is not thrown away
    expect(await screen.findByText(/also changed elsewhere/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load latest" }));
    expect(slider).toHaveAttribute("aria-valuenow", "35");
  });
});

describe("rule builder", () => {
  it("adds a rule, blocks applying until it is valid, then saves it", async () => {
    const { user } = await renderApp(flagUrl("eta-dark-launch"), { env: "staging" });
    await user.click(await screen.findByRole("button", { name: "Add rule" }));
    expect(screen.getByText("Name the attribute to check.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Apply to Staging" })).toBeDisabled();
    expect(screen.getByText("1 rule needs fixing first.")).toBeInTheDocument();

    await user.type(screen.getByRole("combobox", { name: "Rule 1 attribute" }), "plan");
    await user.type(screen.getByRole("textbox", { name: "Rule 1 value" }), "pro");
    expect(screen.queryByText(/Name the attribute|Give a value/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply to Staging" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Apply to Staging" }));
    expect(await screen.findByText("Targeting saved for eta-dark-launch")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Rule 1 attribute" })).toHaveValue("plan");
  });

  it("checks the value against the operator", async () => {
    const { user } = await renderApp(flagUrl("eta-dark-launch"), { env: "staging" });
    await user.click(await screen.findByRole("button", { name: "Add rule" }));
    await user.type(screen.getByRole("combobox", { name: "Rule 1 attribute" }), "tenureMonths");
    await user.selectOptions(screen.getByRole("combobox", { name: "Rule 1 operator" }), "at least");
    await user.type(screen.getByRole("textbox", { name: "Rule 1 value" }), "six");
    expect(screen.getByText("This comparison needs a number.")).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Rule 1 value" }));
    await user.type(screen.getByRole("textbox", { name: "Rule 1 value" }), "6");
    expect(screen.queryByText("This comparison needs a number.")).not.toBeInTheDocument();
  });

  it("reorders with the arrow buttons (order decides which rule wins)", async () => {
    const { user } = await renderApp(flagUrl("instant-payouts"), { env: "staging" });
    const first = await screen.findByRole("combobox", { name: "Rule 1 attribute" });
    expect(first).toHaveValue("depot");
    expect(screen.getByRole("combobox", { name: "Rule 2 attribute" })).toHaveValue("tenureMonths");
    expect(screen.getByRole("button", { name: "Move rule 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move rule 2 down" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Move rule 1 down" }));
    expect(screen.getByRole("combobox", { name: "Rule 1 attribute" })).toHaveValue("tenureMonths");
    expect(screen.getByRole("combobox", { name: "Rule 2 attribute" })).toHaveValue("depot");
    expect(await screen.findByRole("region", { name: "Unsaved changes" })).toBeInTheDocument(); // a new order is a change
  });

  it("removes a rule and shows the empty note when none are left", async () => {
    const { user } = await renderApp(flagUrl("route-optimizer-v2"), { env: "prod" });
    await user.click(await screen.findByRole("button", { name: "Remove rule 1" }));
    expect(await screen.findByText(/No rules\. Everyone is decided by the rollout percentage/)).toBeInTheDocument();
    expect(screen.getByText("None.")).toBeInTheDocument(); // the "how a user is decided" summary follows the draft
  });
});

describe("command palette with flags", () => {
  it("finds a flag from an abbreviation and opens it", async () => {
    const { user, router } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("rtopt");
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("route-optimizer-v2");
    await user.keyboard("{Enter}");
    expect(router.state.location.pathname).toBe(flagUrl("route-optimizer-v2"));
  });

  it("finds actions by what people call them, and Production actions still need the hold", async () => {
    const { user } = await renderApp(FLAGS_URL);
    await screen.findByRole("list", { name: "Flags" });
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("kill carrier");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Turn off carrier-rate-cache");

    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Turn off carrier-rate-cache in Production?" })).toBeInTheDocument();
    expect(toggleIn("carrier-rate-cache")).toBeChecked(); // nothing happened yet
  });
});

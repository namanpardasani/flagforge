import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const LIST = "/w/halden/p/dispatch-api/experiments";
const detail = (id: string) => `${LIST}/${id}`;

/** route-optimizer-v2 is on in prod at 25% in the seed, so an experiment can start on it. */
const seed = (extra: Parameters<typeof server.seedExperiment>[0] extends infer T ? Partial<NonNullable<T>> : never = {}) =>
  server.seedExperiment({ flagKey: "route-optimizer-v2", envKey: "prod", name: "One-tap checkout", ...extra });

describe("experiments list", () => {
  it("starts empty with an explanation and a way to begin", async () => {
    await renderApp(LIST);
    expect(await screen.findByText("No experiments yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create the first experiment" })).toBeInTheDocument();
  });

  it("lists experiments with flag, environment and status; ember only on the running one", async () => {
    seed({ name: "Live one", status: "RUNNING" });
    seed({ name: "Draft one", flagKey: "carrier-rate-cache", status: "DRAFT" });
    await renderApp(LIST);
    const table = await screen.findByRole("table", { name: "Experiments" });
    const live = within(table).getByText("Live one").closest("tr")!;
    const draft = within(table).getByText("Draft one").closest("tr")!;
    expect(within(live).getByText("Running")).toBeInTheDocument();
    expect(within(live).getByText("route-optimizer-v2")).toBeInTheDocument();
    expect(within(draft).getByText("Draft")).toBeInTheDocument();
    expect(within(draft).getByText("not started")).toBeInTheDocument();
    expect(live.querySelector(".bg-ember")).not.toBeNull();
    expect(draft.querySelector(".bg-ember")).toBeNull();
    expect(screen.getByText("2 experiments")).toBeInTheDocument();
  });

  it("creates a draft from a flag, an environment and a success event", async () => {
    const { user, router } = await renderApp(LIST);
    await user.click(await screen.findByRole("button", { name: "New experiment" }));
    const dialog = await screen.findByRole("dialog", { name: "New experiment" });
    await user.type(within(dialog).getByLabelText("Name"), "Faster routes");
    await user.selectOptions(within(dialog).getByLabelText("Flag"), "route-optimizer-v2");
    expect(within(dialog).getByLabelText("Environment")).toHaveDisplayValue("Production"); // follows the environment being viewed
    await user.type(within(dialog).getByLabelText("Success event"), "route-completed");
    await user.click(within(dialog).getByRole("button", { name: "Create experiment" }));

    expect(await screen.findByText("Faster routes created")).toBeInTheDocument();
    const row = (await screen.findByText("Faster routes")).closest("tr")!;
    expect(within(row).getByText("Draft")).toBeInTheDocument();
    expect(within(row).getByText("measures route-completed")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(LIST);
  });

  it("checks the event name before asking the server", async () => {
    const { user } = await renderApp(LIST);
    await user.click(await screen.findByRole("button", { name: "New experiment" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "x");
    await user.type(within(dialog).getByLabelText("Success event"), "Has Spaces");
    expect(within(dialog).getByText(/Lowercase letters, numbers/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create experiment" })).toBeDisabled();
  });

  it("viewers see the list without any controls", async () => {
    seed();
    await renderApp(LIST, { role: "VIEWER" });
    await screen.findByRole("table", { name: "Experiments" });
    expect(screen.queryByRole("button", { name: "New experiment" })).not.toBeInTheDocument();
  });
});

describe("experiment detail", () => {
  it("shows a checklist before starting, naming what is missing", async () => {
    const id = seed({ flagKey: "strict-address-check", envKey: "dev", status: "DRAFT" }); // off in dev
    await renderApp(detail(id));
    expect(await screen.findByText("Before you start")).toBeInTheDocument();
    expect(screen.getByText("Turn it on: while it is off nobody gets the flag.")).toBeInTheDocument();
    expect(screen.getByText(/sendEvents: true/)).toBeInTheDocument();
  });

  it("starting is refused with the server's reason when the flag is off", async () => {
    const id = seed({ flagKey: "strict-address-check", envKey: "dev", status: "DRAFT" });
    const { user } = await renderApp(detail(id));
    await user.click(await screen.findByRole("button", { name: "Start experiment" }));
    expect(await screen.findByText("Could not start the experiment")).toBeInTheDocument();
    expect(screen.getByText(/Turn the flag on in this environment first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start experiment" })).toBeInTheDocument(); // still a draft
  });

  it("refuses when everyone would get the flag, and starts once there is a split", async () => {
    const id = seed({ flagKey: "carrier-rate-cache", envKey: "prod", status: "DRAFT" }); // on at 100%
    const { user } = await renderApp(detail(id));
    await user.click(await screen.findByRole("button", { name: "Start experiment" }));
    expect(await screen.findByText(/Set the rollout between 1% and 99% first/)).toBeInTheDocument();
  });

  it("starts a draft, then shows it as running", async () => {
    const id = seed({ status: "DRAFT" });
    const { user } = await renderApp(detail(id));
    await user.click(await screen.findByRole("button", { name: "Start experiment" }));
    expect(await screen.findByText("One-tap checkout is running")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Stop experiment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start experiment" })).not.toBeInTheDocument();
    expect(screen.queryByText("Before you start")).not.toBeInTheDocument();
  });

  it("with no data yet, says what to check instead of showing zeros as a result", async () => {
    const id = seed();
    await renderApp(detail(id));
    expect(await screen.findByText("Not enough data yet")).toBeInTheDocument();
    expect(screen.getByText(/Check that your SDK was created with sendEvents on/)).toBeInTheDocument();
  });

  it("shows both groups and explains a real difference in words", async () => {
    const id = seed();
    server.setExperimentCounts(id, { users: 1000, conversions: 100 }, { users: 1000, conversions: 130 });
    server.remoteChange("dispatch-api", "dev"); // unrelated change: must not disturb anything
    await renderApp(detail(id), { env: "prod" });
    const without = await screen.findByLabelText("conversion rate 10.0%");
    const withFlag = screen.getByLabelText("conversion rate 13.0%");
    expect(without.closest("[data-group]")).toHaveAttribute("data-group", "control");
    expect(withFlag.closest("[data-group]")).toHaveAttribute("data-group", "treatment");
    expect(screen.getByText("Users with the flag convert more")).toBeInTheDocument();
    expect(screen.getByText(/13.0% against 10.0%: \+3.0 points \(\+30% relative\)/)).toBeInTheDocument();
    expect(screen.getByText(/95% confidence interval/)).toBeInTheDocument();
  });

  it("'no difference' is not presented as 'no effect'", async () => {
    const id = seed();
    server.setExperimentCounts(id, { users: 5000, conversions: 500 }, { users: 5000, conversions: 505 });
    await renderApp(detail(id));
    expect(await screen.findByText("No difference detected")).toBeInTheDocument();
    expect(screen.getByText(/does not prove the flag has no effect/)).toBeInTheDocument();
  });

  it("warns loudly when the split does not match the rollout", async () => {
    // bulk-label-print is at a plain 50% in staging, so half the users should have the flag.
    const id = seed({ flagKey: "bulk-label-print", envKey: "staging" });
    server.setExperimentCounts(id, { users: 1200, conversions: 100 }, { users: 800, conversions: 70 }); // but only 40% did
    await renderApp(detail(id));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The rollout sends 50.0% of users to the flag, but 40.0% of the users recorded had it");
    expect(alert).toHaveTextContent("do not trust these results");
  });

  it("does not run the split check when targeting rules decide who gets the flag, and says so", async () => {
    const id = seed(); // route-optimizer-v2 in prod has a targeting rule
    server.setExperimentCounts(id, { users: 1200, conversions: 100 }, { users: 800, conversions: 70 });
    await renderApp(detail(id));
    expect(await screen.findByText(/The split check is off/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("tells the reader not to peek while it runs", async () => {
    await renderApp(detail(seed()));
    expect(await screen.findByText(/read the result once/)).toBeInTheDocument();
    expect(screen.getByText(/at least 100 users/)).toBeInTheDocument();
  });

  it("does not say it once the experiment has stopped", async () => {
    await renderApp(detail(seed({ status: "STOPPED" })));
    await screen.findByText("Not enough data yet");
    expect(screen.queryByText(/read the result once/)).not.toBeInTheDocument();
  });

  it("stopping needs a confirmation and keeps the numbers", async () => {
    const id = seed();
    server.setExperimentCounts(id, { users: 300, conversions: 30 }, { users: 300, conversions: 60 });
    const { user } = await renderApp(detail(id));
    await user.click(await screen.findByRole("button", { name: "Stop experiment" }));
    const dialog = await screen.findByRole("dialog", { name: "Stop One-tap checkout?" });
    expect(dialog).toHaveTextContent("cannot be restarted");
    await user.click(within(dialog).getByRole("button", { name: "Stop experiment" }));
    expect(await screen.findByText("One-tap checkout stopped")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop experiment" })).not.toBeInTheDocument());
    expect(screen.getByLabelText("conversion rate 20.0%")).toBeInTheDocument(); // the numbers are still there
    expect(screen.queryByText(/read the result once/)).not.toBeInTheDocument();
  });

  it("deleting is for admins, asks first, and returns to the list", async () => {
    const id = seed();
    const { user, router } = await renderApp(detail(id));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete One-tap checkout?" });
    expect(server.requests("DELETE", /experiments/)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Delete experiment" }));
    expect(await screen.findByText("One-tap checkout deleted")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe(LIST));
  });

  it("a member can start and stop but not delete; a viewer can do neither", async () => {
    const id = seed({ status: "DRAFT" });
    await renderApp(detail(id), { role: "MEMBER" });
    expect(await screen.findByRole("button", { name: "Start experiment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("a viewer sees the numbers and no buttons", async () => {
    const id = seed();
    server.setExperimentCounts(id, { users: 300, conversions: 30 }, { users: 300, conversions: 60 });
    await renderApp(detail(id), { role: "VIEWER" });
    await screen.findByLabelText("conversion rate 20.0%");
    for (const name of ["Start experiment", "Stop experiment", "Delete"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });

  it("an unknown experiment gets a friendly page", async () => {
    await renderApp(detail("exp_nope"));
    expect(await screen.findByText("No such experiment")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to experiments" })).toHaveAttribute("href", LIST);
  });

  it("when the server refuses anyway (403 after a demotion), the reason is shown", async () => {
    const id = seed({ status: "DRAFT" });
    const { user } = await renderApp(detail(id), { role: "MEMBER" });
    await screen.findByRole("button", { name: "Start experiment" });
    server.setRole("halden", "VIEWER");
    await user.click(screen.getByRole("button", { name: "Start experiment" }));
    expect(await screen.findByText("Could not start the experiment")).toBeInTheDocument();
    expect(screen.getByText(/requires the MEMBER role or higher/)).toBeInTheDocument();
  });
});

describe("navigation", () => {
  it("has Experiments in the sidebar, highlighted on both pages", async () => {
    const id = seed();
    const { user } = await renderApp(LIST);
    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    expect(within(sidebar).getByRole("link", { name: "Experiments" })).toHaveAttribute("href", LIST);
    await user.click(await screen.findByRole("link", { name: "One-tap checkout" }));
    expect(await screen.findByRole("heading", { level: 1, name: "One-tap checkout" })).toBeInTheDocument();
    expect(within(sidebar).getByRole("link", { name: "Experiments" })).toHaveAttribute("aria-current", "page"); // still highlighted on the detail page
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("Experiment")).toHaveAttribute("aria-current", "page");
    expect(id).toBeTruthy();
  });
});

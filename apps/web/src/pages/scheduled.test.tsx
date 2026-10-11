import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const URL = (key: string) => `/w/halden/p/dispatch-api/flags/${key}`;
/** A time the form accepts: tomorrow, in local time, as a datetime-local input wants it. */
const tomorrow = () => {
  const t = new Date(Date.now() + 26 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
};
const form = () => within(screen.getByRole("form", { name: "Plan a change" }));

describe("scheduled changes on a flag", () => {
  it("says nothing is planned, and offers the form to members", async () => {
    await renderApp(URL("bulk-label-print"), { env: "staging" });
    expect(await screen.findByText("Nothing is planned for Staging.")).toBeInTheDocument();
    expect(form().getByLabelText("When")).toBeInTheDocument();
  });

  it("plans a change and lists it with what will happen and by whom", async () => {
    const { user } = await renderApp(URL("bulk-label-print"), { env: "staging" });
    await user.type(await screen.findByLabelText("When"), tomorrow());
    await user.selectOptions(form().getByLabelText("Turn it"), "on");
    await user.type(form().getByLabelText("Rollout to (%)"), "75");
    await user.click(form().getByRole("button", { name: "Schedule" }));

    expect(await screen.findByText("Change scheduled")).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Waiting changes" });
    expect(within(list).getByText("Turn on, rollout 75%")).toBeInTheDocument();
    expect(within(list).getByText("by Mira Okafor")).toBeInTheDocument();
    expect(server.requests("POST", /schedule$/)).toHaveLength(1);
    expect(form().getByLabelText("When")).toHaveValue(""); // the form is ready for the next step of a ramp
  });

  it("explains a problem with the form without asking the server", async () => {
    const { user } = await renderApp(URL("bulk-label-print"), { env: "staging" });
    await user.click(await screen.findByRole("button", { name: "Schedule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose when it should happen.");
    await user.type(form().getByLabelText("When"), tomorrow());
    await user.click(form().getByRole("button", { name: "Schedule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose what should change");
    expect(server.requests("POST", /schedule$/)).toHaveLength(0);
  });

  it("in Production it asks once more before planning", async () => {
    const { user } = await renderApp(URL("route-optimizer-v2"), { env: "prod" });
    await user.type(await screen.findByLabelText("When"), tomorrow());
    await user.type(form().getByLabelText("Rollout to (%)"), "40");
    await user.click(form().getByRole("button", { name: "Schedule" }));
    const dialog = await screen.findByRole("dialog", { name: "Schedule a change to Production?" });
    expect(dialog).toHaveTextContent("rollout 40% for route-optimizer-v2");
    expect(dialog).toHaveTextContent("runs by itself");
    expect(server.requests("POST", /schedule$/)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Change scheduled")).toBeInTheDocument();
  });

  it("only shows plans for the environment being viewed", async () => {
    server.seedScheduledChange({ flagKey: "bulk-label-print", envKey: "staging", patch: { rolloutPercentage: 80 } });
    server.seedScheduledChange({ flagKey: "bulk-label-print", envKey: "prod", patch: { enabled: true } });
    await renderApp(URL("bulk-label-print"), { env: "staging" });
    const list = await screen.findByRole("list", { name: "Waiting changes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Rollout 80%")).toBeInTheDocument();
  });

  it("cancelling asks first, and the plan disappears", async () => {
    server.seedScheduledChange({ flagKey: "bulk-label-print", envKey: "staging", patch: { rolloutPercentage: 80 } });
    const { user } = await renderApp(URL("bulk-label-print"), { env: "staging" });
    await user.click(await screen.findByRole("button", { name: /Cancel the change planned for/ }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel this scheduled change?" });
    expect(server.requests("DELETE", /scheduled-changes/)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Cancel the change" }));
    expect(await screen.findByText("Scheduled change cancelled")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument()); // until it has closed, the page behind is hidden
    await waitFor(() => expect(screen.getByText("Nothing is planned for Staging.")).toBeInTheDocument());
    // It moved to the history, marked cancelled.
    expect(await within(screen.getByRole("list", { name: "Past scheduled changes" })).findByText(/Cancelled/)).toBeInTheDocument();
  });

  it("shows what happened to past plans, including why one failed", async () => {
    server.seedScheduledChange({ flagKey: "bulk-label-print", envKey: "staging", patch: { rolloutPercentage: 60 }, status: "APPLIED", minutesFromNow: -120 });
    server.seedScheduledChange({ flagKey: "bulk-label-print", envKey: "staging", patch: { enabled: false }, status: "FAILED", minutesFromNow: -60, failure: "The person who scheduled this can no longer change flags" });
    await renderApp(URL("bulk-label-print"), { env: "staging" });
    const past = await screen.findByRole("list", { name: "Past scheduled changes" });
    expect(within(past).getByText("Applied")).toBeInTheDocument();
    expect(within(past).getByText("Failed")).toBeInTheDocument();
    expect(within(past).getByText("The person who scheduled this can no longer change flags")).toBeInTheDocument();
  });

  it("a plan that runs while the page is open moves to the past, and the flag row updates", async () => {
    const id = server.seedScheduledChange({ flagKey: "bulk-label-print", envKey: "staging", patch: { rolloutPercentage: 90 } });
    await renderApp(URL("bulk-label-print"), { env: "staging" });
    expect(await screen.findByRole("list", { name: "Waiting changes" })).toBeInTheDocument();
    expect(await screen.findByRole("slider", { name: "Rollout percentage" })).toHaveAttribute("aria-valuenow", "50");

    await act(async () => {
      server.runScheduledChange(id); // the server's runner applies it and announces the new version
      await server.whenIdle();
    });
    await waitFor(() => expect(screen.getByRole("slider", { name: "Rollout percentage" })).toHaveAttribute("aria-valuenow", "90"));
    await waitFor(() => expect(screen.getByText("Nothing is planned for Staging.")).toBeInTheDocument());
    expect(within(screen.getByRole("list", { name: "Past scheduled changes" })).getByText(/Applied/)).toBeInTheDocument();
  });

  it("viewers see the plans and no controls", async () => {
    server.seedScheduledChange({ flagKey: "bulk-label-print", envKey: "staging", patch: { rolloutPercentage: 80 } });
    await renderApp(URL("bulk-label-print"), { env: "staging", role: "VIEWER" });
    const list = await screen.findByRole("list", { name: "Waiting changes" });
    expect(within(list).getByText("Rollout 80%")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Plan a change" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel the change planned for/ })).not.toBeInTheDocument();
  });

  it("when the server refuses (a demotion since the page loaded), the reason is shown", async () => {
    const { user } = await renderApp(URL("bulk-label-print"), { env: "staging", role: "MEMBER" });
    await user.type(await screen.findByLabelText("When"), tomorrow());
    await user.selectOptions(form().getByLabelText("Turn it"), "on");
    server.setRole("halden", "VIEWER");
    await user.click(form().getByRole("button", { name: "Schedule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/requires the MEMBER role or higher/);
    expect(screen.getByText("Scheduled changes")).toBeInTheDocument(); // the panel is still there
  });
});

import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render-app";
import { setReducedMotion } from "@/test/setup";

// The landing page loads sections when they come near the viewport. jsdom has no layout, so in
// these tests every observed element is reported as visible straight away.
class VisibleObserver {
  constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
  observe = () => this.callback([{ isIntersecting: true }]);
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = () => [];
}

const realMatchMedia = window.matchMedia;
/** Pretend the device has (or lacks) a mouse. Other queries keep the shared fake's behaviour. */
function setFinePointer(fine: boolean) {
  window.matchMedia = ((query: string) => (query.includes("pointer: fine") ? { ...realMatchMedia(query), matches: fine } : realMatchMedia(query))) as typeof window.matchMedia;
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", VisibleObserver);
  // jsdom has no canvas. Returning null is what a browser without 2D canvas support does, and it
  // is exactly the case the static fallback exists for.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  window.sessionStorage.clear();
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  setReducedMotion(false);
  vi.restoreAllMocks();
});

const boot = () => document.querySelector("[data-boot]");
// The landing page needs no session and no API, so it is opened signed out and without waiting for data.
const openLanding = () => renderApp("/landing", { signedIn: false, settle: false });
/** Opens the page as a returning visitor: no boot sequence. */
const openBooted = () => {
  window.sessionStorage.setItem("ff.booted", "1");
  return openLanding();
};

describe("boot sequence", () => {
  it("plays on the first visit, then gets out of the way by itself", async () => {
    await openLanding();
    expect(await screen.findByRole("status", { name: "Loading FlagForge" })).toHaveTextContent(/forging flags\.\.\./);
    await waitFor(() => expect(boot()).toBeNull(), { timeout: 4000 });
    expect(window.sessionStorage.getItem("ff.booted")).toBe("1");
  });

  it("can be skipped with the button", async () => {
    const { user } = await openLanding();
    await user.click(await screen.findByRole("button", { name: "Skip" }));
    // Marked as seen at the moment of skipping, not when the count would have finished.
    expect(window.sessionStorage.getItem("ff.booted")).toBe("1");
    expect(boot()).toHaveTextContent("100%");
    await waitFor(() => expect(boot()).toBeNull(), { timeout: 4000 });
  });

  it("can be skipped with any key", async () => {
    const { user } = await openLanding();
    await screen.findByRole("status", { name: "Loading FlagForge" });
    await user.keyboard("x");
    expect(window.sessionStorage.getItem("ff.booted")).toBe("1");
  });

  it("is shown once per session", async () => {
    await openBooted();
    await screen.findByRole("heading", { level: 1 });
    expect(boot()).toBeNull();
  });

  it("is not shown at all with reduced motion", async () => {
    setReducedMotion(true);
    await openLanding();
    await screen.findByRole("heading", { level: 1 });
    expect(boot()).toBeNull();
  });
});

describe("hero", () => {
  it("has a headline that reads as one sentence, however it is animated", async () => {
    await openBooted();
    expect(await screen.findByRole("heading", { level: 1, name: "Ship it dark. Light it up for 5%, then 20%, then everyone." })).toBeInTheDocument();
  });

  it("falls back to a static field when canvas is unavailable, and still describes it", async () => {
    await openBooted();
    const field = await screen.findByRole("img", { name: /simulated users have the flag at 5 percent rollout/ });
    expect(field).toHaveAttribute("data-static-field");
  });

  it("the slider sets the rollout, and a higher rollout never lights fewer users", async () => {
    const { user } = await openBooted();
    const slider = await screen.findByRole("slider", { name: "Rollout percentage" });
    const litAt = () => Number(/^(\d+) of/.exec(screen.getByRole("img", { name: /simulated users/ }).getAttribute("aria-label")!)![1]);

    slider.focus();
    await user.keyboard("{Home}");
    expect(litAt()).toBe(0);
    await user.keyboard("{PageUp}{PageUp}");
    expect(slider).toHaveAttribute("aria-valuenow", "20");
    const at20 = litAt();
    await user.keyboard("{PageUp}");
    expect(slider).toHaveAttribute("aria-valuenow", "30");
    expect(litAt()).toBeGreaterThan(at20);
  });

  it("stops following the headline once you take the slider", async () => {
    const { user } = await openBooted();
    const slider = await screen.findByRole("slider", { name: "Rollout percentage" });
    slider.focus();
    await user.keyboard("{End}");
    await act(() => new Promise((resolve) => setTimeout(resolve, 2900))); // longer than one word change
    expect(slider).toHaveAttribute("aria-valuenow", "100");
  });

  it("with reduced motion the word does not cycle", async () => {
    setReducedMotion(true);
    await openLanding();
    const slider = await screen.findByRole("slider", { name: "Rollout percentage" });
    expect(slider).toHaveAttribute("aria-valuenow", "20");
    await act(() => new Promise((resolve) => setTimeout(resolve, 2900)));
    expect(slider).toHaveAttribute("aria-valuenow", "20");
  });
});

describe("custom cursor", () => {
  const mark = () => document.querySelector("[data-cursor-mark]");

  it("appears for a mouse and hides the system cursor", async () => {
    setFinePointer(true);
    await openBooted();
    await screen.findByRole("heading", { level: 1 });
    expect(mark()).not.toBeNull();
    expect(document.documentElement).toHaveClass("custom-cursor");
  });

  it("is off on touch devices", async () => {
    setFinePointer(false);
    await openBooted();
    await screen.findByRole("heading", { level: 1 });
    expect(mark()).toBeNull();
    expect(document.documentElement).not.toHaveClass("custom-cursor");
  });

  it("is off with reduced motion, even with a mouse", async () => {
    setFinePointer(true);
    setReducedMotion(true);
    await openLanding();
    await screen.findByRole("heading", { level: 1 });
    expect(mark()).toBeNull();
  });
});

describe("flip it, watch it land", () => {
  const checkout = () => document.querySelector("[data-checkout]")!.getAttribute("data-checkout");
  const node = (label: string) => document.querySelector(`[data-node="${label}"]`)!.getAttribute("data-on");

  it("changes the checkout only after the pulse has travelled the path", async () => {
    const { user } = await openBooted();
    const toggle = await screen.findByRole("switch", { name: "one-tap-checkout flag" });
    expect(checkout()).toBe("form");

    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(checkout()).toBe("form"); // the app has not been told yet
    expect(node("SDK")).toBe("false");
    expect(screen.getByText("On its way")).toBeInTheDocument();

    await waitFor(() => expect(checkout()).toBe("one-tap"), { timeout: 3000 });
    expect(node("Dashboard")).toBe("true");
    expect(node("SDK")).toBe("true");
    expect(screen.getByText("On in production")).toBeInTheDocument();
    expect(await screen.findByText("Pay in one tap")).toBeInTheDocument();
  });

  it("with reduced motion the change lands at once", async () => {
    setReducedMotion(true);
    const { user } = await openLanding();
    await user.click(await screen.findByRole("switch", { name: "one-tap-checkout flag" }));
    expect(checkout()).toBe("one-tap");
  });
});

describe("the rest of the page", () => {
  it("loads every section and gives each a heading", async () => {
    await openBooted();
    for (const name of ["Flip it. Watch it land.", "The whole machine, on one sheet.", "Small parts. Each one you can watch.", "One import. One if.", "Put the next release behind a flag."]) {
      expect(await screen.findByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });

  it("shows the SDK snippet in full to screen readers, whatever has been typed so far", async () => {
    await openBooted();
    const sdk = (await screen.findByRole("heading", { level: 2, name: "One import. One if." })).closest("section")!;
    expect(sdk.querySelector("pre[aria-label]")!.getAttribute("aria-label")).toContain('flags.isEnabled("one-tap-checkout"');
  });

  it("with reduced motion the demos show a finished state instead of looping", async () => {
    setReducedMotion(true);
    await openLanding();
    const bento = (await screen.findByRole("heading", { level: 2, name: "Small parts. Each one you can watch." })).closest("section")!;
    // The rule is fully written and already evaluated by the real matcher.
    expect(within(bento).getByText("ingrid").closest("li")).toHaveTextContent("matches");
    expect(within(bento).getByText("tomasz").closest("li")).toHaveTextContent("falls through");
    const log = within(bento).getByRole("list", { name: "Audit log (simulated)" });
    const before = within(log).getAllByRole("listitem").length;
    await act(() => new Promise((resolve) => setTimeout(resolve, 2400)));
    expect(within(log).getAllByRole("listitem")).toHaveLength(before);
  });

  it("links to the dashboard", async () => {
    await openBooted();
    const links = await screen.findAllByRole("link", { name: /Open (the )?dashboard/ });
    for (const link of links) expect(link).toHaveAttribute("href", "/");
  });
});

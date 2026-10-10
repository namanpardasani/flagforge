import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";

const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });

describe("dashboard shell", () => {
  it("shows a loading state first, then the overview built from the mock data", async () => {
    renderApp();
    expect(screen.getByRole("status", { name: "Loading overview" })).toBeInTheDocument();
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Six flags in Dispatch API, two live in production.");
    expect(screen.queryByRole("status", { name: "Loading overview" })).not.toBeInTheDocument();
  });

  it("redirects / to the default project and /w/:workspace to its first project", async () => {
    const root = renderApp("/");
    await screen.findByRole("heading", { level: 1 });
    expect(root.router.state.location.pathname).toBe("/w/halden/p/dispatch-api/overview");
  });

  it("opens another workspace on its first project", async () => {
    const { router } = renderApp("/w/orchard");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Storefront");
    expect(router.state.location.pathname).toBe("/w/orchard/p/storefront/overview");
  });

  it("shows the breadcrumb trail with the current page marked", async () => {
    renderApp("/w/halden/p/dispatch-api/flags");
    const trail = await screen.findByRole("navigation", { name: "Breadcrumb" });
    // The crumb shows the project key until its name has loaded, so wait for the name.
    expect(await within(trail).findByRole("link", { name: "Dispatch API" })).toBeInTheDocument();
    expect(within(trail).getByText("Flags")).toHaveAttribute("aria-current", "page");
  });

  it("navigates between pages from the sidebar and marks the active one", async () => {
    const { user, router } = renderApp();
    await screen.findByRole("heading", { level: 1 });
    await user.click(within(sidebar()).getByRole("link", { name: "Flags" }));
    expect(router.state.location.pathname).toBe("/w/halden/p/dispatch-api/flags");
    expect(await screen.findByRole("heading", { level: 1, name: /switched/ })).toBeInTheDocument();
    expect(within(sidebar()).getByRole("link", { name: "Flags" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the same page when switching project", async () => {
    const { user, router } = renderApp("/w/halden/p/dispatch-api/flags");
    await user.click(await within(sidebar()).findByRole("link", { name: "Driver App" }));
    expect(router.state.location.pathname).toBe("/w/halden/p/driver-app/flags");
  });

  it("shows the 404 screen for an unknown page", async () => {
    renderApp("/w/halden/p/dispatch-api/nope");
    expect(await screen.findByText("404")).toBeInTheDocument();
  });
});

describe("sidebar collapse", () => {
  it("collapses, expands, and remembers the choice", async () => {
    const { user } = renderApp();
    expect(sidebar()).toHaveAttribute("data-collapsed", "false");

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(sidebar()).toHaveAttribute("data-collapsed", "true");
    expect(window.localStorage.getItem("ff.sidebar")).toBe("collapsed");
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand).toHaveAttribute("aria-expanded", "false");

    await user.click(expand);
    expect(sidebar()).toHaveAttribute("data-collapsed", "false");
    expect(window.localStorage.getItem("ff.sidebar")).toBe("open");
  });

  it("starts collapsed when that was the saved choice", () => {
    window.localStorage.setItem("ff.sidebar", "collapsed");
    renderApp();
    expect(sidebar()).toHaveAttribute("data-collapsed", "true");
  });

  it("keeps every link reachable by name while collapsed (labels are hidden, not removed)", async () => {
    window.localStorage.setItem("ff.sidebar", "collapsed");
    renderApp();
    for (const name of ["Overview", "Flags", "Environments", "API keys", "Members", "Audit log"]) {
      expect(within(sidebar()).getByRole("link", { name })).toBeInTheDocument();
    }
  });

  it("keeps the same link elements and keyboard focus when collapsing (nothing is rebuilt)", async () => {
    const { user } = renderApp();
    const before = within(sidebar()).getByRole("link", { name: "Members" });
    before.focus();
    await user.keyboard("{Control>}k{/Control}"); // open the palette...
    await user.keyboard("collapse{Enter}"); // ...and collapse from the keyboard, without clicking elsewhere
    expect(sidebar()).toHaveAttribute("data-collapsed", "true");
    const after = within(sidebar()).getByRole("link", { name: "Members" });
    expect(after).toBe(before); // the very same DOM node, not a rebuilt copy
    expect(before.isConnected).toBe(true);
  });

  it("makes the hidden environment control unreachable in each state", () => {
    renderApp();
    const group = within(sidebar()).getByRole("group", { name: "Environment" });
    expect(group.closest("[inert]")).toBeNull(); // open: the three-way control is live
    expect(within(sidebar()).getByRole("button", { name: /Switch to/, hidden: true }).closest("[inert]")).not.toBeNull();
  });
});

describe("environment switcher", () => {
  it("defaults to prod, switches, and remembers", async () => {
    const { user } = renderApp();
    const group = within(sidebar()).getByRole("group", { name: "Environment" });
    expect(within(group).getByRole("button", { name: "prod" })).toHaveAttribute("aria-pressed", "true");

    await user.click(within(group).getByRole("button", { name: "staging" }));
    expect(within(group).getByRole("button", { name: "staging" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "prod" })).toHaveAttribute("aria-pressed", "false");
    expect(window.localStorage.getItem("ff.env")).toBe("staging");
  });

  it("changes what the pages report", async () => {
    const { user } = renderApp();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("two live in production");
    await user.click(within(sidebar()).getByRole("button", { name: "dev" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("five live in development");
  });

  it("ignores a corrupted saved value", () => {
    window.localStorage.setItem("ff.env", "nonsense");
    renderApp();
    const group = within(sidebar()).getByRole("group", { name: "Environment" });
    expect(within(group).getByRole("button", { name: "prod" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("command palette", () => {
  it("opens with Ctrl+K and closes with Escape", async () => {
    const { user } = renderApp();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search flags, pages and actions/)).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("also opens with Cmd+K and from the top-bar button, and Ctrl+K toggles it shut", async () => {
    const { user } = renderApp();
    await screen.findByRole("heading", { level: 1 });
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open command palette" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("filters as you type and navigates on Enter", async () => {
    const { user, router } = renderApp();
    await screen.findByRole("heading", { level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("audit");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Audit log");

    await user.keyboard("{Enter}");
    expect(router.state.location.pathname).toBe("/w/halden/p/dispatch-api/audit-log");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says so when nothing matches", async () => {
    const { user } = renderApp();
    await screen.findByRole("heading", { level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("zzzzzz");
    expect(screen.getByText("Nothing matches that.")).toBeInTheDocument();
  });

  it("can switch environment and collapse the sidebar", async () => {
    const { user } = renderApp();
    await screen.findByRole("heading", { level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("staging{Enter}");
    expect(window.localStorage.getItem("ff.env")).toBe("staging");

    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("collapse{Enter}");
    expect(sidebar()).toHaveAttribute("data-collapsed", "true");
  });
});

describe("flag list basics", () => {
  it("filters with the tabs and counts each state", async () => {
    const { user } = renderApp("/w/halden/p/dispatch-api/flags");
    const tabs = await screen.findByRole("tablist", { name: "Filter flags by state" });
    expect(within(tabs).getByRole("tab", { name: /All/ })).toHaveTextContent("06");
    expect(within(tabs).getByRole("tab", { name: /On/ })).toHaveTextContent("02");
    const rows = () => within(screen.getByRole("list", { name: "Flags" })).getAllByRole("listitem");
    expect(rows()).toHaveLength(6);

    await user.click(within(tabs).getByRole("tab", { name: /On/ }));
    // Filtered-out rows fade for a moment before leaving the page.
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(within(tabs).getByRole("tab", { name: /On/ })).toHaveAttribute("aria-selected", "true");
  });

  it("moves between tabs with the arrow keys", async () => {
    const { user } = renderApp("/w/halden/p/dispatch-api/flags");
    const tabs = await screen.findByRole("tablist");
    within(tabs).getByRole("tab", { name: /All/ }).focus();
    await user.keyboard("{ArrowRight}");
    expect(within(tabs).getByRole("tab", { name: /On/ })).toHaveAttribute("aria-selected", "true");
  });

  it("shows the empty state for a project with no flags", async () => {
    renderApp("/w/halden/p/billing/flags");
    expect(await screen.findByRole("heading", { level: 2, name: "No flags in Billing yet" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("says plainly that the data is mock and unsaved", async () => {
    renderApp("/w/halden/p/dispatch-api/flags");
    expect(await screen.findByText(/Mock data/)).toBeInTheDocument();
  });
});

describe("pages not built yet", () => {
  it("explain themselves instead of looking broken", async () => {
    renderApp("/w/halden/p/dispatch-api/api-keys");
    expect(await screen.findByRole("heading", { level: 2, name: "API keys is not wired up yet" })).toBeInTheDocument();
  });
});

describe("ui kit", () => {
  it("renders inside the shell and selects table rows", async () => {
    const { user } = renderApp("/kit");
    await user.click(await screen.findByRole("tab", { name: "Data" }));
    const table = screen.getByRole("table", { name: "Flags in Dispatch API" });
    await user.click(within(table).getByRole("checkbox", { name: "Select flag route-optimizer-v2" }));
    expect(screen.getByText("1 of 6 selected")).toBeInTheDocument();
    await user.click(within(table).getByRole("checkbox", { name: "Select all rows" }));
    expect(screen.getByText("6 of 6 selected")).toBeInTheDocument();
    await user.click(within(table).getByRole("checkbox", { name: "Select all rows" }));
    expect(screen.getByText("0 of 6 selected")).toBeInTheDocument();
  });
});

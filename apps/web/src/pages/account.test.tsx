import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { verifyEmail } from "@/api/account";
import { renderApp } from "@/test/render-app";
import { server } from "@/test/setup";
import { TEST_USER } from "@/test/fake-server";

const signedOut = { signedIn: false } as const;

describe("forgot password", () => {
  it("asks for the address and shows the server's neutral answer, never whether an account exists", async () => {
    const { user } = await renderApp("/forgot-password", signedOut);
    await user.type(await screen.findByLabelText("Email"), "nobody-at-all@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText("If an account exists for that address, a reset link is on its way.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send reset link" })).not.toBeInTheDocument();
    expect(server.requests("POST", "/auth/forgot-password")).toHaveLength(1);
  });

  it("is reachable from the sign-in screen and keeps the address already typed", async () => {
    const { user, router } = await renderApp("/login", signedOut);
    await user.type(await screen.findByLabelText("Email"), "tove@example.com");
    await user.click(screen.getByRole("link", { name: "Forgot your password?" }));
    expect(await screen.findByRole("heading", { level: 1, name: /Forgot your password/ })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/forgot-password");
    expect(screen.getByLabelText("Email")).toHaveValue("tove@example.com");
  });

  it("says plainly when the server cannot be reached", async () => {
    const { user } = await renderApp("/forgot-password", signedOut);
    server.setOffline(true);
    await user.type(await screen.findByLabelText("Email"), "tove@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Cannot reach the server/);
  });
});

describe("reset password", () => {
  it("takes the token from the link, removes it from the address, and sets the new password", async () => {
    const token = server.emailLink("reset");
    const { user, router } = await renderApp(`/reset-password#token=${token}`, signedOut);
    await screen.findByLabelText("New password");
    await waitFor(() => expect(router.state.location.hash).toBe("")); // the secret is no longer in the address bar

    await user.type(screen.getByLabelText("New password"), "a brand new password");
    await user.type(screen.getByLabelText("Repeat it"), "a brand new password");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in." })).toBeInTheDocument();
    expect(await screen.findByText(/Your password was changed and every session was signed out/)).toBeInTheDocument();
    const sent = server.requests("POST", "/auth/reset-password");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).not.toContain(token); // the token goes in the body, never in the address

    // And the new password really is the one that works now.
    await user.type(screen.getByLabelText("Email"), TEST_USER.email);
    await user.type(screen.getByLabelText("Password"), "a brand new password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { level: 1, name: /flags in Dispatch API/ })).toBeInTheDocument(); // signed in, on the dashboard
  });

  it("checks the two passwords before asking the server", async () => {
    const { user } = await renderApp(`/reset-password#token=${server.emailLink("reset")}`, signedOut);
    await user.type(await screen.findByLabelText("New password"), "short");
    expect(screen.getByText("At least 8 characters.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("New password"));
    await user.type(screen.getByLabelText("New password"), "a long enough password");
    await user.type(screen.getByLabelText("Repeat it"), "a different password");
    expect(screen.getByText("The two passwords differ.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change password" })).toBeDisabled();
    expect(server.requests("POST", "/auth/reset-password")).toHaveLength(0);
  });

  it("a spent or expired link is explained, with a way to get a new one", async () => {
    const spent = server.emailLink("reset");
    const first = await renderApp(`/reset-password#token=${spent}`, signedOut);
    await first.user.type(await screen.findByLabelText("New password"), "a brand new password");
    await first.user.type(screen.getByLabelText("Repeat it"), "a brand new password");
    await first.user.click(screen.getByRole("button", { name: "Change password" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in." });

    // The same link again.
    await act(async () => {
      await first.router.navigate(`/reset-password#token=${spent}`);
    });
    await first.user.type(await screen.findByLabelText("New password"), "another password!");
    await first.user.type(screen.getByLabelText("Repeat it"), "another password!");
    await first.user.click(screen.getByRole("button", { name: "Change password" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This link is invalid, has expired, or was already used.");
    expect(within(alert).getByRole("link", { name: "Ask for a new link" })).toHaveAttribute("href", "/forgot-password");
  });

  it("an expired link is refused", async () => {
    const { user } = await renderApp(`/reset-password#token=${server.emailLink("reset", { expired: true })}`, signedOut);
    await user.type(await screen.findByLabelText("New password"), "a brand new password");
    await user.type(screen.getByLabelText("Repeat it"), "a brand new password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid, has expired, or was already used");
  });

  it("a link without its token says so instead of showing a form that cannot work", async () => {
    await renderApp("/reset-password", signedOut);
    expect(await screen.findByText("This link is not complete.")).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ask for a new link" })).toHaveAttribute("href", "/forgot-password");
  });

  it("a verification link is not accepted as a reset link", async () => {
    const { user } = await renderApp(`/reset-password#token=${server.emailLink("verify")}`, signedOut);
    await user.type(await screen.findByLabelText("New password"), "a brand new password");
    await user.type(screen.getByLabelText("Repeat it"), "a brand new password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid");
  });
});

describe("confirming an email address", () => {
  it("opening the link confirms it, once, and removes the token from the address", async () => {
    const { router } = await renderApp(`/verify-email#token=${server.emailLink("verify")}`, signedOut);
    expect(await screen.findByRole("heading", { level: 1, name: "Email confirmed." })).toBeInTheDocument();
    expect(router.state.location.hash).toBe("");
    expect(server.requests("POST", "/auth/verify-email")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });

  it("asking twice for the same link sends one request (development mode runs effects twice)", async () => {
    const token = server.emailLink("verify");
    await Promise.all([verifyEmail(token), verifyEmail(token), verifyEmail(token)]);
    expect(server.requests("POST", "/auth/verify-email")).toHaveLength(1);
  });

  it("a link that does not work is explained", async () => {
    await renderApp(`/verify-email#token=${server.emailLink("verify", { expired: true })}`, signedOut);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("invalid, has expired, or was already used");
    expect(alert).toHaveTextContent("Send again");
  });

  it("a link without its token is explained", async () => {
    await renderApp("/verify-email", signedOut);
    expect(await screen.findByText(/This link is not complete/)).toBeInTheDocument();
  });

  it("someone already signed in with an unconfirmed address: the banner goes away once they confirm", async () => {
    server.setEmailVerified(false);
    const { router } = await renderApp("/w/halden/p/dispatch-api/flags");
    expect(await screen.findByText(/Confirm your email address/)).toBeInTheDocument();
    await act(async () => {
      await router.navigate(`/verify-email#token=${server.emailLink("verify")}`);
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Email confirmed." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to your workspace" })).toHaveAttribute("href", "/");
    await act(async () => {
      await router.navigate("/w/halden/p/dispatch-api/flags");
    });
    await screen.findByRole("list", { name: "Flags" });
    expect(screen.queryByText(/Confirm your email address/)).not.toBeInTheDocument();
  });
});

describe("the reminder banner", () => {
  it("shows for an unconfirmed address, names it, and can send the email again", async () => {
    server.setEmailVerified(false);
    const { user } = await renderApp("/w/halden/p/dispatch-api/flags");
    const banner = await screen.findByText(/Confirm your email address/);
    expect(banner).toHaveTextContent(TEST_USER.email);
    await user.click(screen.getByRole("button", { name: "Send again" }));
    expect(await screen.findByText("Sent. Check your inbox.")).toBeInTheDocument();
    expect(server.requests("POST", "/auth/resend-verification")).toHaveLength(1);
  });

  it("is absent for a confirmed address", async () => {
    await renderApp("/w/halden/p/dispatch-api/flags");
    await screen.findByRole("list", { name: "Flags" });
    expect(screen.queryByText(/Confirm your email address/)).not.toBeInTheDocument();
  });

  it("is only a reminder: an unconfirmed user can still use flags", async () => {
    server.setEmailVerified(false);
    await renderApp("/w/halden/p/dispatch-api/flags", { env: "dev" });
    expect(await screen.findByRole("list", { name: "Flags" })).toBeInTheDocument();
    expect(screen.getAllByRole("switch").length).toBeGreaterThan(0);
  });
});

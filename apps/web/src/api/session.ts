import { createStore } from "@/stores/create-store";
import { meSchema, sessionSchema, toUser } from "./adapters";
import { ApiError, onSessionEnd, request, tokens } from "./client";
import type { User } from "./types";

/**
 * Who is signed in. A tiny store outside React (like the toast and flash stores) so the API
 * client, which is not a component, can end the session too.
 *
 *  checking  - the app just loaded and is finding out whether the saved session still works
 *  signedOut - show the sign-in screen
 *  signedIn  - `user` is set
 */
export type Session = { status: "checking" } | { status: "signedOut"; reason?: "expired" } | { status: "signedIn"; user: User };

const store = createStore<Session>({ status: "checking" });
export const useSession = () => store.use((state) => state);
export const getSession = () => store.get();

const afterSignOut = new Set<() => void>();
/** Lets the data cache empty itself when the user changes, so nothing from the last person is shown. */
export function onSignOut(listener: () => void): () => void {
  afterSignOut.add(listener);
  return () => afterSignOut.delete(listener);
}

function signedOut(reason?: "expired") {
  store.set(reason ? { status: "signedOut", reason } : { status: "signedOut" });
  for (const listener of [...afterSignOut]) listener();
}

// The client could not refresh: whatever the user was doing, the session is over.
onSessionEnd(() => {
  if (store.get().status !== "signedOut") signedOut("expired");
});

let restoring: Promise<void> | null = null;

/** Run once when the app starts: turns a saved refresh token back into a signed-in session. */
export function restoreSession(): Promise<void> {
  restoring ??= (async () => {
    if (!tokens.hasRefreshToken()) return signedOut();
    try {
      const { user } = await request("GET", "/auth/me", { schema: meSchema });
      store.set({ status: "signedIn", user: toUser(user) });
    } catch (error) {
      // Could not reach the server: keep the token and let the user retry, do not sign them out.
      if (error instanceof ApiError && error.status !== 401) {
        store.set({ status: "signedOut" });
        return;
      }
      if (store.get().status !== "signedOut") signedOut("expired");
    }
  })();
  return restoring;
}

async function enter(path: "/auth/login" | "/auth/register", body: object) {
  const session = await request("POST", path, { body, schema: sessionSchema, authenticated: false });
  tokens.set(session);
  store.set({ status: "signedIn", user: toUser(session.user) });
}

export const signIn = (input: { email: string; password: string }) => enter("/auth/login", input);
export const register = (input: { name: string; email: string; password: string }) => enter("/auth/register", input);

/** The address was confirmed in this browser: update the signed-in user so the banner goes away. */
export function markEmailVerified() {
  const current = store.get();
  if (current.status === "signedIn") store.set({ status: "signedIn", user: { ...current.user, emailVerified: true } });
}

export async function signOut() {
  const refreshToken = tokens.refreshToken();
  tokens.clear();
  signedOut();
  // Tell the server to revoke the token. If that fails the user is still signed out here, and
  // the token expires by itself.
  if (refreshToken) await request("POST", "/auth/logout", { body: { refreshToken }, authenticated: false }).catch(() => {});
}

/** Test helper. */
export function resetSession() {
  restoring = null;
  store.set({ status: "checking" });
}

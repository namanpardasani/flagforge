import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useSession } from "@/api/session";
import { paths } from "./use-scope";

/**
 * Shows its children only to a signed-in user; everyone else goes to the sign-in screen and comes
 * back to the same address afterwards.
 *
 * This is navigation, not security. Anyone can edit JavaScript in their own browser; what actually
 * protects the data is that every API request needs a valid token and is checked on the server.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();

  if (session.status === "checking") return <div role="status" aria-label="Checking your session" className="h-dvh bg-canvas" />;
  if (session.status === "signedOut") {
    return <Navigate to={paths.login} replace state={{ from: `${location.pathname}${location.search}`, expired: session.reason === "expired" }} />;
  }
  return children;
}

import { useState } from "react";
import { explainLinkError, resendVerification } from "@/api/account";
import { useSession } from "@/api/session";

/**
 * A reminder for someone whose address is not confirmed yet. It is only a reminder: signing in and
 * using flags work without it. What needs a confirmed address (being added to a workspace by email)
 * is enforced by the server, not by this banner.
 */
export function VerifyEmailBanner() {
  const session = useSession();
  const [state, setState] = useState<"idle" | "sending" | "sent" | "already">("idle");
  const [error, setError] = useState<string | null>(null);
  if (session.status !== "signedIn" || session.user.emailVerified) return null;

  const resend = async () => {
    setState("sending");
    setError(null);
    try {
      const { alreadyVerified } = await resendVerification();
      setState(alreadyVerified ? "already" : "sent");
    } catch (cause) {
      setError(explainLinkError(cause));
      setState("idle");
    }
  };

  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-hairline bg-sunken px-4 py-2 text-xs text-muted">
      <span>
        Confirm your email address <span className="font-mono text-ink">{session.user.email}</span> so teammates can add you to workspaces.
      </span>
      {state === "sent" ? (
        <span className="text-ink">Sent. Check your inbox.</span>
      ) : state === "already" ? (
        <span className="text-ink">Already confirmed. Reload this page.</span>
      ) : (
        <button type="button" onClick={() => void resend()} disabled={state === "sending"} className="border-b border-muted text-ink hover:border-ink disabled:opacity-50">
          {state === "sending" ? "Sending" : "Send again"}
        </button>
      )}
      {error && (
        <span role="alert" className="text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

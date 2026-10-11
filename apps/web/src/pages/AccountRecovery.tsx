import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { explainLinkError, forgotPassword, resetPassword, verifyEmail } from "@/api/account";
import { useSession } from "@/api/session";
import { paths } from "@/components/shell/use-scope";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { AuthFrame } from "./Auth";

/**
 * Reads the token from the address ("/reset-password#token=...") ONCE, then removes it from the
 * address bar. The token sits after the "#", so it was never sent to any server; taking it out of
 * the address as well keeps it out of browser history, screenshots and shared screens.
 */
function useLinkToken(): string | null {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(location.hash.replace(/^#/, "")).get("token"));
  useEffect(() => {
    if (location.hash) void navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: location.state });
  }, [location.hash, location.pathname, location.search, location.state, navigate]);
  return token;
}

export function ForgotPasswordPage() {
  const state = useLocation().state as { email?: unknown } | null;
  const [email, setEmail] = useState(typeof state?.email === "string" ? state.email : "");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSent(await forgotPassword(email.trim()));
    } catch (cause) {
      setError(explainLinkError(cause));
    }
    setBusy(false);
  };

  return (
    <AuthFrame
      fig="5.4"
      title={
        <>
          Forgot your <span className="accent text-[1.1em]">password</span>?
        </>
      }
      footer={
        <Link to={paths.login} className="border-b border-ink pb-0.5 text-ink">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <div role="status" className="mt-5 space-y-3 text-sm leading-relaxed text-muted">
          <p className="text-ink">{sent}</p>
          <p>The link works once and expires in an hour. Nothing arrived? Check the spam folder, then try again in a few minutes.</p>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-5 space-y-4">
          <p className="text-sm leading-relaxed text-muted">Enter the email you signed up with. If it has an account, we send a link to choose a new password.</p>
          <Field label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="solid" disabled={busy || !email.trim()} className="h-9 w-full">
            {busy ? "Sending" : "Send reset link"}
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function ResetPasswordPage() {
  const token = useLinkToken();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server's rule (8 characters, at most 72 bytes because of bcrypt), checked early for a faster answer.
  const passwordError = password.length > 0 && password.length < 8 ? "At least 8 characters." : new TextEncoder().encode(password).length > 72 ? "At most 72 bytes." : null;
  const mismatch = again.length > 0 && again !== password ? "The two passwords differ." : null;

  if (!token) {
    return (
      <AuthFrame
        fig="5.5"
        title="This link is not complete."
        footer={
          <Link to={paths.forgotPassword} className="border-b border-ink pb-0.5 text-ink">
            Ask for a new link
          </Link>
        }
      >
        <p role="alert" className="mt-4 text-sm leading-relaxed text-muted">
          Open the link from the email exactly as it was sent. Some mail programs cut long links in two.
        </p>
      </AuthFrame>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (passwordError || mismatch || !password) return;
    setBusy(true);
    setError(null);
    try {
      await resetPassword(token, password);
      void navigate(paths.login, { replace: true, state: { passwordReset: true } });
    } catch (cause) {
      setError(explainLinkError(cause));
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      fig="5.5"
      title={
        <>
          Choose a new <span className="accent text-[1.1em]">password</span>.
        </>
      }
      footer={
        <Link to={paths.login} className="border-b border-ink pb-0.5 text-ink">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={submit} className="mt-5 space-y-4">
        <Field label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} error={passwordError} hint="At least 8 characters." required autoFocus />
        <Field label="Repeat it" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} error={mismatch} required />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error} <Link to={paths.forgotPassword} className="border-b border-danger">Ask for a new link</Link>
          </p>
        )}
        <p className="text-xs leading-relaxed text-faint">Everywhere you are signed in will be signed out.</p>
        <Button type="submit" variant="solid" disabled={busy || !password || !again || passwordError !== null || mismatch !== null} className="h-9 w-full">
          {busy ? "Saving" : "Change password"}
        </Button>
      </form>
    </AuthFrame>
  );
}

type Verification = { state: "checking" } | { state: "done" } | { state: "failed"; message: string } | { state: "incomplete" };

export function VerifyEmailPage() {
  const token = useLinkToken();
  const session = useSession();
  const [result, setResult] = useState<Verification>(token ? { state: "checking" } : { state: "incomplete" });

  useEffect(() => {
    if (!token) return;
    let current = true;
    verifyEmail(token).then(
      () => current && setResult({ state: "done" }),
      (cause: unknown) => current && setResult({ state: "failed", message: explainLinkError(cause) }),
    );
    return () => {
      current = false;
    };
  }, [token]);

  const signedIn = session.status === "signedIn";
  const next = (
    <Link to={signedIn ? paths.home : paths.login} className="border-b border-ink pb-0.5 text-ink">
      {signedIn ? "Go to your workspace" : "Sign in"}
    </Link>
  );

  return (
    <AuthFrame
      fig="5.6"
      title={
        result.state === "done" ? (
          <>
            Email <span className="accent text-[1.1em]">confirmed</span>.
          </>
        ) : (
          "Confirming your email"
        )
      }
      footer={next}
    >
      <div role="status" className="mt-4 text-sm leading-relaxed text-muted">
        {result.state === "checking" && <p>One moment.</p>}
        {result.state === "done" && <p>Thanks. Teammates can now add you to workspaces by this address, and you can recover your account if you forget your password.</p>}
        {result.state === "incomplete" && <p>This link is not complete. Open it exactly as it was sent in the email.</p>}
        {result.state === "failed" && (
          <p role="alert" className="text-danger">
            {result.message}
            {signedIn ? " Open your workspace and use “Send again” in the banner at the top." : " Sign in and use “Send again” in the banner at the top to get a new one."}
          </p>
        )}
      </div>
    </AuthFrame>
  );
}

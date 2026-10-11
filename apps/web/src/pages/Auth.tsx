import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { ApiError } from "@/api/client";
import { register, signIn, useSession } from "@/api/session";
import { Crosshairs } from "@/components/blueprint/Frame";
import { FigCaption, Grain } from "@/components/blueprint/marks";
import { Mark } from "@/components/shell/Sidebar";
import { paths } from "@/components/shell/use-scope";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

/** Where to go after signing in: back to the page that sent us here, if there was one. */
function useReturnTo() {
  const state = useLocation().state as { from?: unknown; expired?: unknown; passwordReset?: unknown } | null;
  // Only an in-app path is accepted, so a crafted link cannot bounce someone to another site.
  const from = typeof state?.from === "string" && state.from.startsWith("/") && !state.from.startsWith("//") ? state.from : paths.home;
  return { from, expired: state?.expired === true, passwordReset: state?.passwordReset === true };
}

function explain(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return "Too many attempts. Wait a few minutes and try again.";
    if (error.isOffline) return error.message;
    if (error.status >= 500) return "The server had a problem. Try again in a moment.";
    return error.message;
  }
  return "Something went wrong. Try again.";
}

export function AuthFrame({ fig, title, children, footer }: { fig: string; title: ReactNode; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-12">
      <main className="w-full max-w-sm">
        <Link to={paths.landing} className="flex items-center gap-2.5 text-sm font-medium text-ink">
          <Mark /> FlagForge
        </Link>
        <div className="relative mt-8 rounded-xs border border-hairline bg-raised/50 p-6">
          <Crosshairs />
          <FigCaption index={fig} />
          <h1 className="mt-3 text-2xl font-medium tracking-tight text-ink">{title}</h1>
          {children}
        </div>
        <p className="mt-5 text-sm text-muted">{footer}</p>
      </main>
      <Grain />
    </div>
  );
}

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const { from, expired, passwordReset } = useReturnTo();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.status === "signedIn") return <Navigate to={from} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn({ email, password });
      void navigate(from, { replace: true });
    } catch (cause) {
      setError(explain(cause));
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      fig="5.1"
      title={
        <>
          Sign <span className="accent text-[1.1em]">in</span>.
        </>
      }
      footer={
        <>
          New here?{" "}
          <Link to={paths.register} state={{ from }} className="border-b border-ink pb-0.5 text-ink">
            Create an account
          </Link>
        </>
      }
    >
      {expired && !error && <p className="mt-3 text-sm text-muted">Your session ended. Sign in again to carry on where you were.</p>}
      {passwordReset && !error && (
        <p role="status" className="mt-3 text-sm text-muted">
          Your password was changed and every session was signed out. Sign in with the new one.
        </p>
      )}
      <form onSubmit={submit} className="mt-5 space-y-4">
        <Field label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <p className="text-right text-xs">
          <Link to={paths.forgotPassword} state={{ email }} className="text-muted underline-offset-4 hover:text-ink hover:underline">
            Forgot your password?
          </Link>
        </p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="solid" disabled={busy} className="h-9 w-full">
          {busy ? "Signing in" : "Sign in"}
        </Button>
      </form>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const session = useSession();
  const navigate = useNavigate();
  const { from } = useReturnTo();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.status === "signedIn") return <Navigate to={from} replace />;

  // The server's rule (8 characters, at most 72 bytes because of bcrypt), checked early for a faster answer.
  const passwordError = password.length > 0 && password.length < 8 ? "At least 8 characters." : new TextEncoder().encode(password).length > 72 ? "At most 72 bytes." : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (passwordError) return;
    setBusy(true);
    setError(null);
    try {
      await register({ name: name.trim(), email, password });
      void navigate(from, { replace: true });
    } catch (cause) {
      setError(explain(cause));
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      fig="5.2"
      title={
        <>
          Create an <span className="accent text-[1.1em]">account</span>.
        </>
      }
      footer={
        <>
          Already have one?{" "}
          <Link to={paths.login} state={{ from }} className="border-b border-ink pb-0.5 text-ink">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="mt-5 space-y-4">
        <Field label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
        <Field label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Field label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} error={passwordError} hint="At least 8 characters." required />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="solid" disabled={busy || passwordError !== null} className="h-9 w-full">
          {busy ? "Creating" : "Create account"}
        </Button>
      </form>
    </AuthFrame>
  );
}

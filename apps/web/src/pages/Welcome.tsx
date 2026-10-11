import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { signOut } from "@/api/session";
import { Crosshairs } from "@/components/blueprint/Frame";
import { FigCaption, Grain } from "@/components/blueprint/marks";
import { RequireAuth } from "@/components/shell/RequireAuth";
import { Mark } from "@/components/shell/Sidebar";
import { paths } from "@/components/shell/use-scope";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { slugify } from "@/lib/slugify";
import { Problem } from "@/components/ui/problem";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { useCreateWorkspace } from "@/data/mutations";
import { useWorkspaces } from "@/data/queries";

const Opening = () => (
  <SkeletonGroup label="Opening FlagForge" className="flex h-dvh items-center justify-center bg-canvas">
    <Skeleton className="h-4 w-48" />
  </SkeletonGroup>
);

/** "/": no screen of its own. Sends you to your first workspace, or to set one up. */
export function HomeRedirect() {
  return (
    <RequireAuth>
      <Home />
    </RequireAuth>
  );
}

function Home() {
  const workspaces = useWorkspaces();
  if (workspaces.isPending) return <Opening />;
  if (workspaces.isError) {
    return (
      <div className="mx-auto max-w-lg px-4 py-24">
        <Problem error={workspaces.error} what="your workspaces" onRetry={() => void workspaces.refetch()} />
      </div>
    );
  }
  const first = workspaces.data[0];
  return <Navigate to={first ? `/w/${first.slug}` : paths.welcome} replace />;
}

/** First run: a new account has no workspace, so there is nothing for the dashboard to show yet. */
export function WelcomePage() {
  return (
    <RequireAuth>
      <Setup />
    </RequireAuth>
  );
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function Setup() {
  const navigate = useNavigate();
  const create = useCreateWorkspace();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");

  const shownSlug = slug ?? slugify(name);
  const projectKey = slugify(projectName);
  const slugError = shownSlug && (shownSlug.length < 3 || !SLUG.test(shownSlug)) ? "Lowercase letters, numbers and single hyphens, at least 3." : null;
  const ready = name.trim() && shownSlug.length >= 3 && !slugError && projectName.trim() && projectKey.length >= 2;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || create.isPending) return;
    create.mutate(
      { name: name.trim(), slug: shownSlug, projectName: projectName.trim(), projectKey },
      { onSuccess: ({ workspace, project }) => void navigate(paths.project(workspace.slug, project.key, "flags"), { replace: true }) },
    );
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-12">
      <main className="w-full max-w-md">
        <p className="flex items-center gap-2.5 text-sm font-medium text-ink">
          <Mark /> FlagForge
        </p>
        <form onSubmit={submit} className="relative mt-8 space-y-4 rounded-xs border border-hairline bg-raised/50 p-6">
          <Crosshairs />
          <FigCaption index="5.3" label="First run" />
          <h1 className="text-2xl font-medium tracking-tight text-ink">
            Set up your <span className="accent text-[1.1em]">workspace</span>.
          </h1>
          <p className="text-sm leading-relaxed text-muted">A workspace is your team. A project is one app or service inside it; it starts with dev, staging and prod environments.</p>
          <Field label="Workspace name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Halden Freight" required autoFocus />
          <Field label="Workspace address" mono value={shownSlug} onChange={(e) => setSlug(e.target.value.toLowerCase())} maxLength={40} error={slugError} hint={`Appears in links: /w/${shownSlug || "your-team"}`} required />
          <Field label="First project" value={projectName} onChange={(e) => setProjectName(e.target.value)} maxLength={100} placeholder="Dispatch API" hint={projectKey ? `Key: ${projectKey}` : undefined} required />
          {create.error && (
            <p role="alert" className="text-sm text-danger">
              {create.error.message}
            </p>
          )}
          <Button type="submit" variant="solid" disabled={!ready || create.isPending} className="h-9 w-full">
            {create.isPending ? "Creating" : "Create workspace"}
          </Button>
        </form>
        <button type="button" onClick={() => void signOut()} className="mt-5 text-sm text-muted hover:text-ink">
          Sign out
        </button>
      </main>
      <Grain />
    </div>
  );
}

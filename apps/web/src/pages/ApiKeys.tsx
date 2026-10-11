import { Check, Copy, KeyRound, Plus } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState, type FormEvent } from "react";
import { envName, isProduction, type ApiKey } from "@/api/types";
import { Crosshairs, Frame } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { useShell } from "@/components/shell/use-shell";
import { useScope } from "@/components/shell/use-scope";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Problem } from "@/components/ui/problem";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { useCreateApiKey, useRevokeApiKey } from "@/data/mutations";
import { useApiKeys } from "@/data/queries";
import { can } from "@/api/types";
import { cn } from "@/lib/cn";
import { formatStamp } from "@/lib/format";
import { toast } from "@/stores/toasts";

/**
 * API keys: what a server-side SDK uses to read one environment's flags.
 * One key belongs to one environment, so the page works on the environment chosen in its tabs.
 * The full key is shown once, right after creation, and never again (the server keeps only a hash).
 */
export function ApiKeysPage() {
  const scope = useScope();
  const { env: shellEnv } = useShell();
  const environments = scope.project?.environments ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const envKey = chosen ?? (environments.some((e) => e.key === shellEnv) ? shellEnv : environments[0]?.key);
  const environment = environments.find((e) => e.key === envKey);

  const allowed = can.manageKeys(scope.role);
  const keys = useApiKeys(scope.project, environment?.id, scope.role);
  const revoke = useRevokeApiKey(scope.project, environment?.id);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const tabs: TabItem[] = environments.map((e) => ({ value: e.key, label: e.name }));
  const active = (keys.data ?? []).filter((k) => !k.revokedAt);
  const revoked = (keys.data ?? []).filter((k) => k.revokedAt);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <FigCaption index="3.1" label="API keys" />
          <h1 className="mt-4 text-3xl font-medium leading-[1.15] tracking-tight text-ink">
            How your code <span className="accent text-[1.1em]">connects</span>.
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">A key lets one server-side SDK read the flags of one environment. Keep it on your server, never in a web page or an app.</p>
        </div>
        {allowed && environment && (
          <Button variant="solid" onClick={() => setCreating(true)}>
            <Plus strokeWidth={1.5} /> New key
          </Button>
        )}
      </header>

      {!allowed ? (
        <EmptyState fig="3.2" title="Keys are managed by admins">
          Your role can read flags but not create or see API keys. Ask an owner or admin of this workspace if your service needs one.
        </EmptyState>
      ) : (
        <Tabs items={tabs} value={envKey ?? ""} onValueChange={setChosen} label="Environment">
          <div className="mt-5">
            {keys.isPending ? (
              <KeysSkeleton />
            ) : keys.isError ? (
              <Problem error={keys.error} what="the API keys" onRetry={() => void keys.refetch()} />
            ) : active.length === 0 && revoked.length === 0 ? (
              <EmptyState fig="3.3" title={`No keys for ${envName(envKey ?? "")} yet`} action={<Button onClick={() => setCreating(true)}>Create the first key</Button>}>
                Create one and paste it into your server's configuration as FLAGFORGE_API_KEY. It is shown once.
              </EmptyState>
            ) : (
              <Frame>
                <Table aria-label={`API keys for ${envName(envKey ?? "")}`}>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Name</TableHead>
                      <TableHead>Key</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="w-28" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...active, ...revoked].map((key) => (
                      <TableRow key={key.id} className={cn(key.revokedAt && "opacity-50")}>
                        <TableCell className="text-ink">{key.name}</TableCell>
                        <TableCell className="font-mono text-xs text-muted">{key.prefix}…</TableCell>
                        <TableCell className="font-mono text-2xs text-faint">{formatStamp(key.createdAt)}</TableCell>
                        <TableCell className="text-right">
                          {key.revokedAt ? (
                            <span className="caption text-faint">Revoked</span>
                          ) : (
                            <Button size="sm" variant="danger" onClick={() => setRevoking(key)} aria-label={`Revoke ${key.name}`}>
                              Revoke
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Frame>
            )}
          </div>
        </Tabs>
      )}

      <NewKeyDialog
        open={creating}
        onOpenChange={setCreating}
        environmentName={envName(envKey ?? "")}
        project={scope.project}
        environmentId={environment?.id}
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        hold={isProduction(envKey ?? "")}
        tone="danger"
        title={`Revoke ${revoking?.name ?? "this key"}?`}
        description={
          <>
            Any service using <span className="font-mono text-xs text-ink">{revoking?.prefix}…</span> stops getting flags right away, and its live connections close. This cannot be undone; create a new key instead.
          </>
        }
        confirmLabel={isProduction(envKey ?? "") ? "Hold to revoke" : "Revoke key"}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </div>
  );
}

/** Two steps in one dialog: ask for a name, then show the secret exactly once. */
function NewKeyDialog({ open, onOpenChange, environmentName, project, environmentId }: { open: boolean; onOpenChange: (open: boolean) => void; environmentName: string; project: ReturnType<typeof useScope>["project"]; environmentId: string | undefined }) {
  const create = useCreateApiKey(project, environmentId);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const close = (next: boolean) => {
    // Closing the second step forgets the secret for good. It cannot be fetched again.
    if (!next) {
      setName("");
      setSecret(null);
      setCopied(false);
      create.reset();
    }
    onOpenChange(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || create.isPending) return;
    create.mutate(name.trim(), { onSuccess: (result) => setSecret(result.secret) });
  };

  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      toast("Could not copy", { detail: "Select the key and copy it by hand.", tone: "danger" });
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-canvas/80" />
        <Dialog.Content
          aria-describedby={undefined}
          // While the secret is on screen, a stray click or Escape must not throw it away.
          onInteractOutside={(event) => secret && event.preventDefault()}
          onEscapeKeyDown={(event) => secret && event.preventDefault()}
          className="fixed left-1/2 top-[16vh] z-[60] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 rounded-xs border border-hairline bg-raised p-5 outline-none"
        >
          <Crosshairs />
          {secret ? (
            <div className="space-y-4">
              <Dialog.Title className="flex items-center gap-2 text-base font-medium tracking-tight text-ink">
                <KeyRound className="size-4" strokeWidth={1.5} /> Copy your key now
              </Dialog.Title>
              <p className="text-sm leading-relaxed text-muted">This is the only time it is shown. FlagForge keeps just a fingerprint of it, so it cannot be recovered. If you lose it, revoke it and make a new one.</p>
              <p data-secret className="break-all rounded-xs border border-line-strong bg-sunken px-3 py-2.5 font-mono text-xs text-ink">
                {secret}
              </p>
              <div className="flex justify-between gap-2">
                <Button onClick={() => void copy()}>
                  {copied ? <Check strokeWidth={1.5} /> : <Copy strokeWidth={1.5} />} {copied ? "Copied" : "Copy key"}
                </Button>
                <Button variant="solid" onClick={() => close(false)}>
                  I have saved it
                </Button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <Dialog.Title className="text-base font-medium tracking-tight text-ink">New key for {environmentName}</Dialog.Title>
              <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Checkout service" hint="So you can tell it apart later." autoFocus required />
              {create.error && (
                <p role="alert" className="text-sm text-danger">
                  {create.error.message}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button variant="ghost">Cancel</Button>
                </Dialog.Close>
                <Button type="submit" variant="solid" disabled={!name.trim() || create.isPending}>
                  {create.isPending ? "Creating" : "Create key"}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function KeysSkeleton() {
  return (
    <SkeletonGroup label="Loading API keys" className="space-y-2">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </SkeletonGroup>
  );
}

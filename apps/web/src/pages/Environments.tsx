import { Plus } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState, type FormEvent } from "react";
import { can, type Environment } from "@/api/types";
import { Crosshairs, Frame } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { useScope } from "@/components/shell/use-scope";
import { useShell } from "@/components/shell/use-shell";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useEnvironmentMutations } from "@/data/mutations";
import { formatStamp, plural } from "@/lib/format";
import { slugify } from "@/lib/slugify";

// The server's rule for environment keys (the same as project keys).
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The environments of this project (dev, staging, prod, or your own). Admins can add and delete
 * them. Deleting removes every flag's settings in that environment and its API keys, so it always
 * asks for the hold-to-confirm; and the last environment cannot be deleted.
 */
export function EnvironmentsPage() {
  const scope = useScope();
  const { env: viewing } = useShell();
  const environments = scope.project?.environments ?? [];
  const { create, remove } = useEnvironmentMutations(scope.project);
  const allowed = can.manageEnvironments(scope.role);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Environment | null>(null);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <FigCaption index="3.5" label="Environments" />
          <h1 className="mt-4 text-3xl font-medium leading-[1.15] tracking-tight text-ink">
            Where a flag can be <span className="accent text-[1.1em]">on</span>.
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">Each flag has its own state in every environment, so a change in staging never touches production. New environments start with every flag off.</p>
        </div>
        {allowed && (
          <Button variant="solid" onClick={() => setAdding(true)}>
            <Plus strokeWidth={1.5} /> New environment
          </Button>
        )}
      </header>

      <Frame>
        <Table aria-label="Environments">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead className="hidden md:table-cell">Created</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {environments.map((environment) => (
              <TableRow key={environment.id}>
                <TableCell className="text-ink">
                  {environment.name} {environment.key === viewing && <span className="caption ml-1 text-faint">viewing</span>}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted">{environment.key}</TableCell>
                <TableCell className="hidden font-mono text-2xs text-faint md:table-cell">{formatStamp(environment.createdAt)}</TableCell>
                <TableCell className="text-right">
                  {allowed && (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={environments.length <= 1}
                      title={environments.length <= 1 ? "A project must keep at least one environment" : undefined}
                      aria-label={`Delete ${environment.name}`}
                      onClick={() => setDeleting(environment)}
                    >
                      Delete
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Frame>
      <p className="caption text-faint">
        {environments.length} {plural(environments.length, "environment")}
        {!allowed && " / admins can add and delete environments"}
      </p>

      <NewEnvironmentDialog open={adding} onOpenChange={setAdding} existing={environments.map((e) => e.key)} mutation={create} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        hold
        tone="danger"
        title={`Delete ${deleting?.name ?? "this environment"}?`}
        description={
          <>
            Every flag loses its state in <span className="font-mono text-xs text-ink">{deleting?.key}</span>, its API keys stop working at once, and SDKs using them are disconnected. This cannot be undone.
          </>
        }
        confirmLabel="Hold to delete"
        onConfirm={() => deleting && remove.mutate({ id: deleting.id, name: deleting.name })}
      />
    </div>
  );
}

function NewEnvironmentDialog({ open, onOpenChange, existing, mutation }: { open: boolean; onOpenChange: (open: boolean) => void; existing: string[]; mutation: ReturnType<typeof useEnvironmentMutations>["create"] }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);

  const shownKey = keyEdited ? key : slugify(name);
  const keyError = !shownKey ? null : shownKey.length < 2 || !KEY_PATTERN.test(shownKey) ? "Lowercase letters, numbers and single hyphens, at least 2." : existing.includes(shownKey) ? "This project already has an environment with this key." : null;
  const ready = name.trim().length > 0 && shownKey.length >= 2 && !keyError;

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setName("");
      setKey("");
      setKeyEdited(false);
      mutation.reset();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || mutation.isPending) return;
    mutation.mutate({ name: name.trim(), key: shownKey }, { onSuccess: () => close(false) });
  };

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-canvas/80" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-[16vh] z-[60] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 rounded-xs border border-hairline bg-raised p-5 outline-none">
          <Crosshairs />
          <form onSubmit={submit} className="space-y-4">
            <Dialog.Title className="text-base font-medium tracking-tight text-ink">New environment</Dialog.Title>
            <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="QA" autoFocus required />
            <Field
              label="Key"
              mono
              value={shownKey}
              onChange={(e) => {
                setKeyEdited(true);
                setKey(e.target.value.toLowerCase());
              }}
              maxLength={40}
              hint="Used in the dashboard and in logs."
              error={keyError}
              required
            />
            {mutation.error && (
              <p role="alert" className="text-sm text-danger">
                {mutation.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="ghost">Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="solid" disabled={!ready || mutation.isPending}>
                {mutation.isPending ? "Creating" : "Create environment"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

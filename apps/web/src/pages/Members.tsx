import { Plus } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState, type FormEvent } from "react";
import { useSession } from "@/api/session";
import { ASSIGNABLE_ROLES, can, memberActions, type Member, type Role } from "@/api/types";
import { Crosshairs, Frame } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { useScope } from "@/components/shell/use-scope";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Problem } from "@/components/ui/problem";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useMemberMutations } from "@/data/mutations";
import { useMembers } from "@/data/queries";
import { formatStamp, plural } from "@/lib/format";

const ROLE_HELP: Record<Role, string> = {
  OWNER: "Everything, including admins. There is one owner.",
  ADMIN: "Manage members, projects, environments and API keys. Read the audit log.",
  MEMBER: "Create and change flags.",
  VIEWER: "Read only.",
};
const label = (role: Role) => role.charAt(0) + role.slice(1).toLowerCase();

/**
 * Who is in this workspace, and what they can do. The buttons shown follow the same rules as the
 * server (see memberActions), but only so people are not offered things that will fail: every
 * request is checked again on the server, and a refusal is shown with its reason.
 */
export function MembersPage() {
  const scope = useScope();
  const session = useSession();
  const me = session.status === "signedIn" ? session.user : null;
  const members = useMembers(scope.workspace?.id);
  const { add, changeRole, remove } = useMemberMutations(scope.workspace?.id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);

  const list = members.data ?? [];
  const leaving = removing !== null && removing.userId === me?.id;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <FigCaption index="3.4" label="Members" />
          <h1 className="mt-4 text-3xl font-medium leading-[1.15] tracking-tight text-ink">
            Who can <span className="accent text-[1.1em]">change</span> things.
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">People in {scope.workspace?.name ?? "this workspace"} and their roles. A role applies to every project in the workspace.</p>
        </div>
        {can.manageMembers(scope.role) && (
          <Button variant="solid" onClick={() => setAdding(true)}>
            <Plus strokeWidth={1.5} /> Add member
          </Button>
        )}
      </header>

      {members.isPending ? (
        <SkeletonGroup label="Loading members" className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </SkeletonGroup>
      ) : members.isError ? (
        <Problem error={members.error} what="the members" onRetry={() => void members.refetch()} />
      ) : (
        <>
          <Frame>
            <Table aria-label="Workspace members">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Person</TableHead>
                  <TableHead className="w-44">Role</TableHead>
                  <TableHead className="hidden w-36 md:table-cell">Joined</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((member) => {
                  const actions = memberActions({ id: me?.id ?? "", role: scope.role }, member);
                  return (
                    <TableRow key={member.userId}>
                      <TableCell>
                        <span className="block text-ink">
                          {member.name} {actions.isSelf && <span className="caption ml-1 text-faint">you</span>}
                        </span>
                        <span className="block font-mono text-2xs text-muted">{member.email}</span>
                      </TableCell>
                      <TableCell>
                        {actions.roles.length > 0 ? (
                          <select
                            aria-label={`Role of ${member.name}`}
                            value={member.role}
                            disabled={changeRole.isPending}
                            onChange={(event) => changeRole.mutate({ userId: member.userId, role: event.target.value as Role })}
                            className="h-8 w-full rounded-xs border border-hairline bg-sunken px-2 text-sm text-ink hover:border-line-strong disabled:opacity-40"
                          >
                            {[member.role, ...actions.roles.filter((r) => r !== member.role)].map((role) => (
                              <option key={role} value={role}>
                                {label(role)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="font-mono text-xs text-muted">{label(member.role)}</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden font-mono text-2xs text-faint md:table-cell">{formatStamp(member.joinedAt)}</TableCell>
                      <TableCell className="text-right">
                        {actions.canRemove && (
                          <Button size="sm" variant="danger" aria-label={`Remove ${member.name}`} onClick={() => setRemoving(member)}>
                            Remove
                          </Button>
                        )}
                        {actions.canLeave && (
                          <Button size="sm" variant="danger" aria-label="Leave workspace" onClick={() => setRemoving(member)}>
                            Leave
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Frame>
          <p className="caption text-faint">
            {list.length} {plural(list.length, "member")}
          </p>

          <dl className="grid gap-x-8 gap-y-3 border-t border-hairline pt-6 sm:grid-cols-2">
            {(["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const).map((role) => (
              <div key={role}>
                <dt className="caption text-muted">{label(role)}</dt>
                <dd className="mt-1 text-sm text-faint">{ROLE_HELP[role]}</dd>
              </div>
            ))}
          </dl>
        </>
      )}

      <AddMemberDialog open={adding} onOpenChange={setAdding} isOwner={scope.role === "OWNER"} mutation={add} />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        tone="danger"
        title={leaving ? `Leave ${scope.workspace?.name}?` : `Remove ${removing?.name}?`}
        description={
          leaving
            ? "You lose access to every project here straight away. An owner or admin would have to add you again."
            : `${removing?.name} loses access to every project in this workspace straight away. Their past changes stay in the audit log.`
        }
        confirmLabel={leaving ? "Leave workspace" : "Remove member"}
        onConfirm={() => removing && remove.mutate({ userId: removing.userId, name: removing.name })}
      />
    </div>
  );
}

function AddMemberDialog({ open, onOpenChange, isOwner, mutation }: { open: boolean; onOpenChange: (open: boolean) => void; isOwner: boolean; mutation: ReturnType<typeof useMemberMutations>["add"] }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("MEMBER");
  const roles = ASSIGNABLE_ROLES.filter((r) => isOwner || r !== "ADMIN");

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setEmail("");
      setRole("MEMBER");
      mutation.reset();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || mutation.isPending) return;
    mutation.mutate({ email: email.trim(), role }, { onSuccess: () => close(false) });
  };

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-canvas/80" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-[16vh] z-[60] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 rounded-xs border border-hairline bg-raised p-5 outline-none">
          <Crosshairs />
          <form onSubmit={submit} className="space-y-4">
            <Dialog.Title className="text-base font-medium tracking-tight text-ink">Add a member</Dialog.Title>
            <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="They need a FlagForge account already." autoFocus required />
            <div>
              <label htmlFor="new-member-role" className="caption text-muted">
                Role
              </label>
              <select id="new-member-role" value={role} onChange={(e) => setRole(e.target.value as Role)} className="mt-1.5 h-9 w-full rounded-xs border border-hairline bg-sunken px-3 text-sm text-ink hover:border-line-strong">
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {label(r)}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-faint">{ROLE_HELP[role]}</p>
            </div>
            {mutation.error && (
              <p role="alert" className="text-sm text-danger">
                {mutation.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="ghost">Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="solid" disabled={!email.trim() || mutation.isPending}>
                {mutation.isPending ? "Adding" : "Add member"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

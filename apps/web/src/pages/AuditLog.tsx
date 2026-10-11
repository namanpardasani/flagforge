import { useMemo, useState } from "react";
import { can, envName, type Activity } from "@/api/types";
import { Frame } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { useScope } from "@/components/shell/use-scope";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Problem } from "@/components/ui/problem";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuditLog } from "@/data/queries";
import { cn } from "@/lib/cn";
import { formatStamp } from "@/lib/format";

type Kind = "all" | "flag" | "apikey";
const KINDS: readonly { value: Kind; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "flag", label: "Flags" },
  { value: "apikey", label: "API keys" },
];
const kindOf = (entry: Activity): Exclude<Kind, "all"> | "other" => (entry.action.startsWith("flag.") ? "flag" : entry.action.startsWith("apikey.") ? "apikey" : "other");

/**
 * Every change in the workspace, newest first: who, what, and where. Written by the server in the
 * same transaction as the change, so it cannot disagree with what happened. Admins and owners only.
 * Filtering works on the pages already loaded; "Load older" fetches the next page from the server.
 */
export function AuditLogPage() {
  const scope = useScope();
  const allowed = can.readAuditLog(scope.role);
  const log = useAuditLog(scope.workspace?.id, scope.role);
  const [kind, setKind] = useState<Kind>("all");
  const [query, setQuery] = useState("");

  const loaded = useMemo(() => (log.data?.pages ?? []).flatMap((page) => page.entries), [log.data]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return loaded.filter((entry) => (kind === "all" || kindOf(entry) === kind) && (!needle || `${entry.subject} ${entry.actor} ${entry.detail} ${entry.env ?? ""}`.toLowerCase().includes(needle)));
  }, [loaded, kind, query]);

  return (
    <div className="space-y-8">
      <header>
        <FigCaption index="3.6" label="Audit log" />
        <h1 className="mt-4 text-3xl font-medium leading-[1.15] tracking-tight text-ink">
          Every change, <span className="accent text-[1.1em]">on record</span>.
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">Who changed what, and where. Entries are written together with the change itself, so nothing happens without leaving a line here. Times are UTC.</p>
      </header>

      {!allowed ? (
        <EmptyState fig="3.7" title="The audit log is for admins">
          Your role cannot read the workspace history. Ask an owner or admin if you need to see who changed something.
        </EmptyState>
      ) : log.isPending ? (
        <SkeletonGroup label="Loading the audit log" className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </SkeletonGroup>
      ) : log.isError ? (
        <Problem error={log.error} what="the audit log" onRetry={() => void log.refetch()} />
      ) : loaded.length === 0 ? (
        <EmptyState fig="3.8" title="Nothing has happened yet">
          Create a flag, flip a switch or make an API key and it shows up here.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="min-w-52 flex-1">
              <span className="sr-only">Search the audit log</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by flag, person or change"
                className="h-8 w-full rounded-xs border border-hairline bg-sunken px-3 text-sm text-ink placeholder:text-faint hover:border-line-strong"
              />
            </label>
            <div role="group" aria-label="Kind of change" className="flex items-center gap-1">
              {KINDS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={kind === option.value}
                  onClick={() => setKind(option.value)}
                  className={cn("h-7 rounded-xs border px-2 text-xs", kind === option.value ? "border-line-strong bg-raised text-ink" : "border-transparent text-muted hover:text-ink")}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <Frame>
            {shown.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted">{loaded.length > 0 && log.hasNextPage ? "Nothing among the loaded entries matches. Older entries may; load more below." : "Nothing matches."}</p>
            ) : (
              <Table aria-label="Audit log">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-40">When</TableHead>
                    <TableHead className="w-40">Who</TableHead>
                    <TableHead>What</TableHead>
                    <TableHead className="hidden w-32 md:table-cell">Where</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-mono text-2xs text-faint">
                        <time dateTime={entry.at}>{formatStamp(entry.at)}</time>
                      </TableCell>
                      <TableCell className="text-sm text-muted">{entry.actor}</TableCell>
                      <TableCell>
                        <span className="block truncate font-mono text-xs text-ink">{entry.subject}</span>
                        <span className="block text-sm text-muted">{entry.detail}</span>
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs text-muted md:table-cell">{entry.env ? envName(entry.env) : ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Frame>
          <div className="flex items-center justify-between">
            <p aria-live="polite" className="caption text-faint">
              {shown.length} of {loaded.length} loaded{log.hasNextPage ? " / older entries exist" : " / that is everything"}
            </p>
            {log.hasNextPage && (
              <Button onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
                {log.isFetchingNextPage ? "Loading" : "Load older"}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

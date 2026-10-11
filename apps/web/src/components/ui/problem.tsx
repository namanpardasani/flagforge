import type { ReactNode } from "react";
import { ApiError } from "@/api/client";
import { Frame } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { Button } from "./button";

interface ProblemProps {
  error: unknown;
  /** What was being loaded, e.g. "the flags". Used in the sentence shown. */
  what: string;
  onRetry?: () => void;
  action?: ReactNode;
}

/** Plain words for each kind of failure, so "403" never has to be decoded by the reader. */
function describe(error: unknown, what: string): { code: string; label: string; title: string; body: string; retry: boolean } {
  if (error instanceof ApiError) {
    if (error.isForbidden) {
      return { code: "403", label: "Not allowed", title: `Your role cannot see ${what}`, body: `${error.message}. Ask an owner or admin of this workspace if you need it.`, retry: false };
    }
    if (error.isNotFound) {
      return { code: "404", label: "Not found", title: `Could not find ${what}`, body: "It may have been deleted, or it belongs to a workspace you are not a member of.", retry: false };
    }
    if (error.isOffline) {
      return { code: "offline", label: "No connection", title: "Cannot reach the server", body: "Nothing was lost. Check your connection, or that the server is running, and try again.", retry: true };
    }
    if (error.status === 429) {
      return { code: "429", label: "Slow down", title: "Too many requests", body: "The server asked for a pause. Wait a moment and try again.", retry: true };
    }
    return {
      code: String(error.status),
      label: "Server problem",
      title: `Could not load ${what}`,
      body: `${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`,
      retry: true,
    };
  }
  return { code: "error", label: "Problem", title: `Could not load ${what}`, body: "Something unexpected went wrong in the app.", retry: true };
}

/** What a screen shows when its data could not be loaded. Never a blank page, never a raw status code alone. */
export function Problem({ error, what, onRetry, action }: ProblemProps) {
  const text = describe(error, what);
  return (
    <Frame role="alert" className="px-6 py-14 text-center">
      <p className="font-mono text-4xl text-ink">{text.code}</p>
      <FigCaption index="4.0" label={text.label} className="mt-5 justify-center" />
      <h2 className="mt-3 text-lg font-medium tracking-tight text-ink">{text.title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">{text.body}</p>
      <div className="mt-6 flex justify-center gap-2">
        {text.retry && onRetry && <Button onClick={onRetry}>Try again</Button>}
        {action}
      </div>
    </Frame>
  );
}

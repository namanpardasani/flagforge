import { useCallback, useState, type ReactNode } from "react";
import { useShell } from "@/components/shell/use-shell";
import { useScope } from "@/components/shell/use-scope";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useSetFlagEnabled } from "@/data/mutations";
import { envName, isProduction, stateOf, type Flag } from "@/api/types";
import { FlagGuardContext, type GuardedToggle } from "./use-flag-guard";

/**
 * The single place a flag gets switched. The list, the detail page and the command palette all
 * call `useGuardedToggle()`, so the Production rule cannot be forgotten in one of them:
 * ANY toggle in a production environment must be confirmed by holding a button for 0.7 seconds.
 */
export function FlagGuard({ children }: { children: ReactNode }) {
  const { env } = useShell();
  const scope = useScope();
  const setEnabled = useSetFlagEnabled(scope.project);
  const [pending, setPending] = useState<{ flag: Flag; enabled: boolean } | null>(null);
  const { mutate } = setEnabled;

  const toggle = useCallback<GuardedToggle>(
    (flag, enabled) => {
      if (isProduction(env)) setPending({ flag, enabled });
      else mutate({ flag, env, enabled });
    },
    [env, mutate],
  );

  const turningOff = pending ? !pending.enabled : true;

  return (
    <FlagGuardContext.Provider value={toggle}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        hold
        tone={turningOff ? "danger" : "ink"}
        title={pending ? `Turn ${pending.enabled ? "on" : "off"} ${pending.flag.key} in ${envName(env)}?` : ""}
        description={
          turningOff ? (
            <>
              Every user who currently gets <span className="font-mono text-xs text-ink">{pending?.flag.key}</span> loses it straight away. Connected SDKs pick the change up within moments.
            </>
          ) : (
            <>
              <span className="font-mono text-xs text-ink">{pending?.flag.key}</span> goes live in {envName(env)} at {pending ? stateOf(pending.flag, env).rolloutPercentage : 0}% rollout, with its current rules.
            </>
          )
        }
        confirmLabel={turningOff ? "Hold to turn off" : "Hold to turn on"}
        onConfirm={() => pending && mutate({ flag: pending.flag, env, enabled: pending.enabled, kind: pending.enabled ? "local" : "kill" })}
      />
    </FlagGuardContext.Provider>
  );
}

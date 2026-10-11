import { useId, type ComponentProps } from "react";
import { cn } from "@/lib/cn";

interface FieldProps extends ComponentProps<"input"> {
  label: string;
  hint?: string;
  error?: string | null;
  mono?: boolean;
}

/** A labelled text input with its hint and error wired up for screen readers. */
export function Field({ label, hint, error, mono, className, ...props }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="caption text-muted">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn("mt-1.5 h-9 w-full rounded-xs border bg-sunken px-3 text-sm text-ink placeholder:text-faint hover:border-line-strong", mono && "font-mono text-xs", error ? "border-danger/60" : "border-hairline")}
        {...props}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="mt-1.5 text-xs text-faint">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

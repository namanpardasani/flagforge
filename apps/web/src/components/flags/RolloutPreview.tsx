import { Slider } from "radix-ui";
import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { isIncluded, SAMPLE_SIZE, sampleBuckets } from "@/lib/targeting";

interface RolloutPreviewProps {
  flagKey: string;
  /** The percentage being edited. */
  value: number;
  onChange: (value: number) => void;
  /** The percentage currently saved on the server, to show what would change. */
  saved: number;
  /** Is the flag on in this environment? Only then are lit squares ember (live). */
  live: boolean;
  disabled?: boolean;
}

/**
 * Rollout slider with a 100-square preview.
 *
 * Each square is one sample user. A square is lit when that user's bucket is below the cut-off,
 * using the SAME function the SDK uses (`bucketFor` from @flagforge/core). Because a user's
 * bucket never changes, raising 20% to 30% lights only NEW squares and never turns one off: the
 * preview shows the "nobody flips back" guarantee instead of just claiming it.
 *
 * The 100 users are picked one per percentage point of the bucket range (see sampleBuckets), so
 * N% lights exactly N squares.
 */
export function RolloutPreview({ flagKey, value, onChange, saved, live, disabled }: RolloutPreviewProps) {
  // Finding the sample means hashing a few hundred keys. It depends only on the flag key, so it is
  // done once per flag, not on every slider movement.
  const buckets = useMemo(() => sampleBuckets(flagKey), [flagKey]);

  const lit = buckets.filter((b) => isIncluded(b, value)).length;
  const wasLit = buckets.filter((b) => isIncluded(b, saved)).length;
  const delta = lit - wasLit;

  return (
    <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_auto]">
      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor={`${flagKey}-rollout`} className="caption text-muted">
            Rollout
          </label>
          <p className="font-mono text-3xl leading-none text-ink">
            <input
              id={`${flagKey}-rollout`}
              type="number"
              min={0}
              max={100}
              step={1}
              value={value}
              disabled={disabled}
              onChange={(event) => onChange(clamp(Number(event.target.value)))}
              className="w-[3ch] bg-transparent text-right outline-offset-4 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-muted">%</span>
          </p>
        </div>

        {/* Radix Slider: arrow keys step by 1, Page Up/Down by 10, Home/End jump to 0/100. */}
        <Slider.Root
          value={[value]}
          onValueChange={([next]) => next !== undefined && onChange(next)}
          min={0}
          max={100}
          step={1}
          disabled={disabled}
          className="relative mt-5 flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-40"
        >
          <Slider.Track className="relative h-px grow bg-line-strong">
            <Slider.Range className={cn("absolute h-px", live ? "bg-ember" : "bg-ink")} />
          </Slider.Track>
          <Slider.Thumb aria-label="Rollout percentage" className="block size-3.5 rounded-[1px] border border-canvas bg-ink" />
        </Slider.Root>
        <div aria-hidden className="mt-1 flex justify-between font-mono text-2xs text-faint">
          <span>0</span>
          <span>25</span>
          <span>50</span>
          <span>75</span>
          <span>100</span>
        </div>

        <p className="mt-5 max-w-prose text-sm leading-relaxed text-muted">
          Of everyone no rule matches, this share gets the flag. A user keeps the same position as the number grows, so raising it only adds people.
        </p>
      </div>

      <div>
        <div
          role="img"
          aria-label={`${lit} of ${SAMPLE_SIZE} sample users would get this flag at ${value} percent.`}
          className="grid w-fit grid-cols-10 gap-1.5"
        >
          {buckets.map((bucket, i) => {
            const now = isIncluded(bucket, value);
            const before = isIncluded(bucket, saved);
            return (
              <span key={i} data-state={now ? (before ? "kept" : "added") : before ? "removed" : "off"} className="relative block size-2.5 rounded-[1px] bg-hairline">
                {/* Lit layer fades with opacity; the square itself never changes colour mid-animation. */}
                <span className={cn("absolute inset-0 rounded-[1px] transition-opacity duration-150 ease-out-quart", live ? "bg-ember" : "bg-muted", now ? "opacity-100" : "opacity-0")} />
                {/* Outline marks a square that differs from what is saved: about to be added, or about to be removed. */}
                <span
                  className={cn(
                    "absolute -inset-[2px] rounded-[2px] border transition-opacity duration-150 ease-out-quart",
                    now ? "border-ink" : "border-danger",
                    now !== before ? "opacity-100" : "opacity-0",
                  )}
                />
              </span>
            );
          })}
        </div>
        <p className="mt-3 font-mono text-2xs text-muted">
          <span className="text-ink">{lit}</span> of {SAMPLE_SIZE} sample users
          {delta !== 0 && <span className={delta > 0 ? "text-ink" : "text-danger"}> / {delta > 0 ? `+${delta} new` : `${delta} removed`}</span>}
        </p>
      </div>
    </div>
  );
}

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0);

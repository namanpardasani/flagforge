import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Slider } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Crosshairs } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { Ticker } from "@/components/ui/ticker";
import { duration, easeOut } from "@/motion";
import { countLit, fieldBuckets } from "./field-model";
import { useActive, useDesktop, useFinePointer } from "./hooks";
import { Magnetic } from "./Magnetic";
import { RolloutField } from "./RolloutField";

/** The headline's last word and the rollout it stands for. The field follows it until you take the slider. */
const STAGES = [
  { word: "5%.", percentage: 5 },
  { word: "20%.", percentage: 20 },
  { word: "everyone.", percentage: 100 },
] as const;
const STAGE_MS = 2600;

const LINES = ["Ship it dark.", "Light it up for"] as const;
const SPOKEN = "Ship it dark. Light it up for 5%, then 20%, then everyone.";

interface HeroProps {
  /** False while the boot sequence still covers the page: entrances wait for it. */
  ready: boolean;
  dashboardPath: string;
}

export function Hero({ ready, dashboardPath }: HeroProps) {
  const reduced = useReducedMotion() ?? false;
  const desktop = useDesktop();
  const fine = useFinePointer();
  const [ref, active] = useActive<HTMLElement>();

  const [stage, setStage] = useState(reduced ? 1 : 0);
  const [manual, setManual] = useState<number | null>(null);
  const [total, setTotal] = useState(desktop ? 1200 : 560);

  // The word cycles only while the hero is on screen, and never with reduced motion.
  useEffect(() => {
    if (!ready || !active || reduced) return;
    const timer = setInterval(() => setStage((s) => (s + 1) % STAGES.length), STAGE_MS);
    return () => clearInterval(timer);
  }, [ready, active, reduced]);

  const percentage = manual ?? (ready ? STAGES[stage]!.percentage : 0);
  const lit = useMemo(() => countLit(fieldBuckets(total), percentage), [total, percentage]);
  const digits = String(total).length;

  return (
    <section ref={ref} aria-labelledby="hero-title" className="relative mx-auto max-w-6xl px-4 pb-20 pt-10 md:px-6 md:pt-14">
      <FigCaption index="0.1" label="Percentage rollout" />

      <h1 id="hero-title" aria-label={SPOKEN} className="mt-6 text-[clamp(2.5rem,7.2vw,5.5rem)] font-semibold leading-[0.94] tracking-[-0.045em] text-ink">
        <span aria-hidden>
          {LINES.map((line, lineIndex) => (
            <span key={line} className="block">
              <Characters text={line} show={ready} startAt={lineIndex === 0 ? 0 : LINES[0].length} reduced={reduced} />
              {lineIndex === 1 && (
                // A fixed-width slot, as wide as the longest word, so the line never reflows when the word changes.
                <span className="relative ml-[0.22em] inline-block min-w-[4.1em] text-left align-baseline">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={stage}
                      initial={{ opacity: 0, y: reduced ? 0 : "0.18em" }}
                      animate={{ opacity: ready ? 1 : 0, y: 0 }}
                      exit={{ opacity: 0, y: reduced ? 0 : "-0.14em" }}
                      transition={{ duration: duration.base, ease: easeOut }}
                      className="accent inline-block text-[1.06em] font-normal tracking-[-0.02em]"
                    >
                      {STAGES[stage]!.word}
                    </motion.span>
                  </AnimatePresence>
                </span>
              )}
            </span>
          ))}
        </span>
      </h1>

      <div className="mt-8 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <p className="max-w-xl text-base leading-relaxed text-muted">
          FlagForge puts a release behind a flag, rolls it out by percentage, and turns it off in one click when it misbehaves. Every dot below is a user. Drag the rollout and watch who gets the new code.
        </p>
        <div className="flex shrink-0 items-center gap-3">
          <Magnetic>
            <Link to={dashboardPath} className="flex h-10 items-center gap-2 rounded-sm bg-ink px-4 text-sm font-medium text-canvas hover:bg-ink/90">
              Open the dashboard <ArrowRight className="size-4" strokeWidth={1.5} />
            </Link>
          </Magnetic>
          <a href="#sdk" className="flex h-10 items-center rounded-sm border border-hairline px-4 text-sm font-medium text-ink hover:border-line-strong">
            Read the SDK
          </a>
        </div>
      </div>

      <div className="relative mt-10 border border-hairline bg-sunken">
        <Crosshairs />
        {/* A fixed height, set before the canvas has drawn anything: no layout shift when it appears. */}
        <div className="h-[300px] md:h-[440px]">
          <RolloutField
            percentage={percentage}
            target={desktop ? 1200 : 560}
            lively={!reduced}
            onTotal={setTotal}
            label={`${lit} of ${total} simulated users have the flag at ${percentage} percent rollout.`}
            className={fine ? undefined : "touch-pan-y"}
          />
        </div>

        <div className="grid items-center gap-x-8 gap-y-4 border-t border-hairline px-4 py-4 md:grid-cols-[auto_minmax(0,1fr)_auto] md:px-6">
          <p className="caption text-muted">
            Rollout <span className="ml-2 font-mono text-sm normal-case tracking-normal text-ink">{String(percentage).padStart(3, " ")}%</span>
          </p>
          <Slider.Root
            value={[percentage]}
            onValueChange={([next]) => next !== undefined && setManual(next)}
            min={0}
            max={100}
            step={1}
            className="relative flex h-6 w-full touch-none select-none items-center"
          >
            <Slider.Track className="relative h-px grow bg-line-strong">
              <Slider.Range className="absolute h-px bg-ember" />
            </Slider.Track>
            <Slider.Thumb aria-label="Rollout percentage" className="block h-5 w-2.5 rounded-[1px] border border-canvas bg-ink" />
          </Slider.Root>
          <p className="caption text-muted">
            <Ticker value={lit} pad={digits} className="text-sm tracking-normal text-ink" /> / {total} users lit
          </p>
        </div>
      </div>
      <p className="mt-3 max-w-2xl text-xs leading-relaxed text-faint">
        Lit with the same hash the SDK uses. A user keeps their position, so going from 20% to 30% lights new dots and never turns one off.
      </p>
    </section>
  );
}

/** Per-character reveal. Each letter rises and fades in, one after another. Words never break in the middle. */
function Characters({ text, show, startAt, reduced }: { text: string; show: boolean; startAt: number; reduced: boolean }) {
  let index = startAt;
  return (
    <>
      {text.split(" ").map((word, wordIndex) => (
        <span key={wordIndex} className="inline-block whitespace-nowrap">
          {wordIndex > 0 && " "}
          {[...word].map((char) => {
            const order = index++;
            return (
              <motion.span
                key={order}
                initial={{ opacity: 0, y: reduced ? 0 : "0.3em" }}
                animate={show ? { opacity: 1, y: 0 } : undefined}
                transition={{ duration: reduced ? duration.quick : 0.5, ease: easeOut, delay: reduced ? 0 : order * 0.022 }}
                className="inline-block"
              >
                {char}
              </motion.span>
            );
          })}
        </span>
      ))}
    </>
  );
}

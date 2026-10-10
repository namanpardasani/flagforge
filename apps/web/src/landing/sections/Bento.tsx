import { matchCondition, type Attributes, type Condition } from "@flagforge/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode, type Ref } from "react";
import { Crosshairs } from "@/components/blueprint/Frame";
import { FigCaption, LiveDot } from "@/components/blueprint/marks";
import { Ticker } from "@/components/ui/ticker";
import { cn } from "@/lib/cn";
import { duration, quiet, Reveal } from "@/motion";
import { useActive, useTyped } from "../hooks";

/**
 * Four small working demos. Each one runs only while its card is on screen and the tab is
 * visible (useActive), and none of them loop at all with reduced motion: they show a finished
 * state instead.
 */
export default function Bento() {
  return (
    <section aria-labelledby="bento-title" className="mx-auto max-w-6xl px-4 py-24 md:px-6 md:py-32">
      <Reveal whenInView>
        <FigCaption index="0.4" label="Working parts" />
        <h2 id="bento-title" className="mt-5 max-w-3xl text-4xl font-semibold leading-none tracking-[-0.035em] text-ink md:text-6xl">
          Small parts. Each one you can <span className="accent text-[1.06em] font-normal">watch</span>.
        </h2>
      </Reveal>

      <div className="mt-12 grid gap-4 md:grid-cols-6">
        <RuleCard className="md:col-span-4" />
        <AuditCard className="md:col-span-2 md:row-span-2" />
        <SdkCard className="md:col-span-2" />
        <OfflineCard className="md:col-span-2" />
      </div>
    </section>
  );
}

function Card({ title, note, className, children, innerRef }: { title: string; note: string; className?: string; children: ReactNode; innerRef: Ref<HTMLDivElement> }) {
  return (
    <div ref={innerRef} className={cn("relative flex flex-col border border-hairline bg-raised/50", className)}>
      <Crosshairs />
      <div className="min-h-0 flex-1 p-5">{children}</div>
      <div className="border-t border-hairline px-5 py-3.5">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">{note}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const OPERATOR_WORDS: Partial<Record<Condition["operator"], string>> = { equals: "equals", in: "is one of", gte: "at least" };

const RULES: ReadonlyArray<{ condition: Condition; shown: string; serve: number }> = [
  { condition: { attribute: "plan", operator: "equals", value: "pro" }, shown: "pro", serve: 50 },
  { condition: { attribute: "country", operator: "in", value: ["NO", "SE"] }, shown: "NO, SE", serve: 100 },
  { condition: { attribute: "tenureMonths", operator: "gte", value: 6 }, shown: "6", serve: 25 },
];

const PEOPLE: ReadonlyArray<{ key: string; attributes: Attributes }> = [
  { key: "ingrid", attributes: { plan: "pro", country: "NO", tenureMonths: 14 } },
  { key: "tomasz", attributes: { plan: "free", country: "PL", tenureMonths: 7 } },
  { key: "saoirse", attributes: { plan: "pro", country: "IE", tenureMonths: 2 } },
];

/** A rule that types itself, then is checked against three people by the real matcher from packages/core. */
function RuleCard({ className }: { className?: string }) {
  const reduced = useReducedMotion() ?? false;
  const [ref, active] = useActive<HTMLDivElement>();
  const [index, setIndex] = useState(0);
  const rule = RULES[index]!;

  const parts = [rule.condition.attribute, OPERATOR_WORDS[rule.condition.operator] ?? rule.condition.operator, rule.shown] as const;
  const script = parts.join("");
  const typed = useTyped(script, active, { cps: 16, instant: reduced });
  const done = typed >= script.length;

  // Hold the finished rule for a moment, then start the next one.
  useEffect(() => {
    if (!done || !active || reduced) return;
    const timer = setTimeout(() => setIndex((i) => (i + 1) % RULES.length), 2800);
    return () => clearTimeout(timer);
  }, [done, active, reduced]);

  let offset = 0;
  return (
    <Card innerRef={ref} className={className} title="Target by what you know about a user" note="Rules are checked top to bottom. The first one that matches decides; everyone else falls through to the rollout percentage.">
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <span className="caption text-faint">If</span>
        {parts.map((part, i) => {
          const start = offset;
          offset += part.length;
          const visible = part.slice(0, Math.max(0, typed - start));
          const typing = typed >= start && typed < start + part.length;
          return (
            // Full text sits invisibly underneath so each field has its final width from the start.
            <span key={i} className={cn("relative rounded-xs border bg-sunken px-2.5 py-1.5", typing ? "border-line-strong" : "border-hairline")}>
              <span className="invisible">{part}</span>
              <span className={cn("absolute inset-y-1.5 left-2.5", i === 1 ? "text-muted" : "text-ink")}>
                {visible}
                {typing && <Caret />}
              </span>
            </span>
          );
        })}
        <span className={cn("caption text-faint transition-opacity duration-150", done ? "opacity-100" : "opacity-0")}>
          then serve to <span className="text-ink">{rule.serve}%</span>
        </span>
      </div>

      <ul className="mt-5 divide-y divide-hairline border-y border-hairline font-mono text-xs">
        {PEOPLE.map((person) => {
          const matches = done && matchCondition(rule.condition, person.attributes);
          return (
            <li key={person.key} className="flex items-center justify-between gap-4 py-2">
              <span className="truncate text-muted">
                <span className="text-ink">{person.key}</span> {String(person.attributes[rule.condition.attribute])}
              </span>
              <span className={cn("shrink-0 transition-opacity duration-150", done ? "opacity-100" : "opacity-0", matches ? "text-ink" : "text-faint")}>{matches ? "matches" : "falls through"}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Caret() {
  return <span aria-hidden className="ml-px inline-block h-[1.1em] w-px translate-y-[0.15em] animate-blink bg-ink" />;
}

// ---------------------------------------------------------------------------------------------

const EVENTS = [
  { actor: "Mira Okafor", text: "turned on one-tap-checkout", env: "production" },
  { actor: "Jonas Reyes", text: "set route-optimizer-v2 to 35%", env: "production" },
  { actor: "Tove Lind", text: "added rule: plan equals pro", env: "staging" },
  { actor: "Mira Okafor", text: "revoked key ff_7Qm2…", env: "staging" },
  { actor: "Jonas Reyes", text: "killed carrier-rate-cache", env: "production" },
  { actor: "Tove Lind", text: "created eta-dark-launch", env: "dev" },
  { actor: "Mira Okafor", text: "set bulk-label-print to 60%", env: "staging" },
] as const;
const VISIBLE_EVENTS = 7;

const clock = (date: Date) => date.toLocaleTimeString("en-GB", { hour12: false });

/** An audit log that keeps receiving entries. New ones arrive at the top; old ones leave at the bottom. */
function AuditCard({ className }: { className?: string }) {
  const reduced = useReducedMotion() ?? false;
  const [ref, active] = useActive<HTMLDivElement>();
  const [entries, setEntries] = useState(() => {
    const now = Date.now();
    return [5, 4, 3, 2, 1, 0].map((i) => ({ id: i, at: clock(new Date(now - (6 - i) * 47_000)), ...EVENTS[i]! }));
  });

  useEffect(() => {
    if (!active || reduced) return;
    const timer = setInterval(() => {
      setEntries((current) => {
        const id = current[0]!.id + 1;
        return [{ id, at: clock(new Date()), ...EVENTS[id % EVENTS.length]! }, ...current].slice(0, VISIBLE_EVENTS);
      });
    }, 2100);
    return () => clearInterval(timer);
  }, [active, reduced]);

  return (
    <Card innerRef={ref} className={className} title="Every change leaves a record" note="Who, what, where and what it was before. Written in the same transaction as the change, so the log cannot disagree with reality.">
      {/* Fixed height and clipped: appending an entry never changes the size of the card. */}
      <ol aria-label="Audit log (simulated)" className="h-[19rem] overflow-hidden md:h-full md:min-h-[26rem]">
        <AnimatePresence initial={false} mode="popLayout">
          {entries.map((entry) => (
            <motion.li key={entry.id} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={quiet} className="border-b border-hairline py-2.5 first:pt-0">
              <p className="flex items-center justify-between font-mono text-2xs text-faint">
                <span>{entry.at}</span>
                <span>{entry.env}</span>
              </p>
              <p className="mt-1 text-xs leading-snug text-muted">
                <span className="text-ink">{entry.actor}</span> {entry.text}
              </p>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------

const SLOTS = 16;
/** A plausible little story: instances come up during a deploy, then two are retired. */
const CONNECTED = [12, 13, 14, 14, 15, 16, 15, 14, 13, 12] as const;

function SdkCard({ className }: { className?: string }) {
  const reduced = useReducedMotion() ?? false;
  const [ref, active] = useActive<HTMLDivElement>();
  const [tick, setTick] = useState(0);
  const count = CONNECTED[tick % CONNECTED.length]!;

  useEffect(() => {
    if (!active || reduced) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1900);
    return () => clearInterval(timer);
  }, [active, reduced]);

  return (
    <Card innerRef={ref} className={className} title="SDKs connected" note="Each open stream is counted per key. Simulated here; the real figure comes from the server.">
      <div className="flex items-center gap-4">
        <span className="relative flex size-3 items-center justify-center">
          {/* The pulse: a square that grows and fades each time the count changes. */}
          {!reduced && (
            <motion.span key={tick} aria-hidden initial={{ scale: 1, opacity: 0.7 }} animate={{ scale: 3.4, opacity: 0 }} transition={{ duration: 1.1, ease: "easeOut" }} className="absolute inset-0 rounded-[1px] border border-ember" />
          )}
          <LiveDot className="size-2" />
        </span>
        <Ticker value={count} pad={2} className="text-5xl leading-none text-ink" />
      </div>
      <div aria-hidden className="mt-5 grid w-fit grid-cols-8 gap-1.5">
        {Array.from({ length: SLOTS }, (_, i) => (
          <span key={i} className="relative block size-2.5 rounded-[1px] bg-hairline">
            <span className={cn("absolute inset-0 rounded-[1px] bg-ember transition-opacity duration-200", i < count ? "opacity-100" : "opacity-0")} />
          </span>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------

const PHASES = [
  { key: "online", ms: 3200, status: "Stream open", detail: "config v41, from network" },
  { key: "offline", ms: 3400, status: "Server unreachable", detail: "config v41, from disk" },
  { key: "recovering", ms: 1800, status: "Reconnected", detail: "caught up: v41 to v43" },
] as const;

/** The server disappears, the card dims, and the flag check keeps answering from the saved copy. */
function OfflineCard({ className }: { className?: string }) {
  const reduced = useReducedMotion() ?? false;
  const [ref, active] = useActive<HTMLDivElement>();
  const [index, setIndex] = useState(0);
  const phase = PHASES[index]!;
  const offline = phase.key === "offline";

  useEffect(() => {
    if (!active || reduced) return;
    const timer = setTimeout(() => setIndex((i) => (i + 1) % PHASES.length), phase.ms);
    return () => clearTimeout(timer);
  }, [active, reduced, phase.ms, index]);

  return (
    <Card innerRef={ref} className={className} title="Your app outlives our server" note="If FlagForge is unreachable the SDK serves the last rules it saved, then catches up when the stream returns.">
      <div data-phase={phase.key}>
        <p className="flex items-center gap-2.5 font-mono text-xs">
          <LiveDot on={!offline} />
          <span className={offline ? "text-danger" : "text-ink"}>{phase.status}</span>
        </p>
        <motion.div animate={{ opacity: offline ? 0.4 : 1 }} transition={{ duration: reduced ? 0 : duration.base }} className="mt-4 space-y-1.5 font-mono text-xs text-muted">
          <p>{phase.detail}</p>
          <p>polling: {offline ? "retrying, backing off" : "every 5 min"}</p>
        </motion.div>
        {/* This line never dims: the answer does not change while the server is away. */}
        <p className="mt-4 rounded-xs border border-hairline bg-sunken px-3 py-2 font-mono text-xs text-muted">
          isEnabled(<span className="text-ink">"one-tap-checkout"</span>) <span className="text-faint">=&gt;</span> <span className="text-ink">true</span>
        </p>
      </div>
    </Card>
  );
}

import { motion, motionValue, useMotionValueEvent, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import { useRef, useState } from "react";
import { FigCaption } from "@/components/blueprint/marks";
import { cn } from "@/lib/cn";
import { useDesktop } from "../hooks";

const STEPS = [
  {
    title: "The change is saved with its receipt.",
    body: "A flip writes the flag and its audit entry in one transaction: both exist or neither does. The environment's version number goes up by one.",
  },
  {
    title: "Every server hears about it.",
    body: "The server that took the write publishes a short message to Redis. Every other instance is listening, so each one drops its cached copy at the same moment.",
  },
  {
    title: "Your app is told, then decides alone.",
    body: "Each instance pushes the new version down its open streams. The SDK fetches the rules once. From then on a flag check is a function call inside your process: no network, no waiting.",
  },
] as const;

interface Box {
  id: string;
  label: string;
  note: string;
  x: number;
  y: number;
  /** The step (0 to 2) in which this box joins the story. */
  step: number;
}
const W = 150;
const H = 52;
const BOXES: readonly Box[] = [
  { id: "dashboard", label: "Dashboard", note: "you flip a flag", x: 24, y: 36, step: 0 },
  { id: "api", label: "API server", note: "validates, checks role", x: 245, y: 36, step: 0 },
  { id: "postgres", label: "Postgres", note: "flag + audit, one txn", x: 466, y: 36, step: 0 },
  { id: "redis", label: "Redis", note: "publish: env at v42", x: 245, y: 184, step: 1 },
  { id: "instance", label: "Server 2..n", note: "drop cache, relay", x: 466, y: 184, step: 1 },
  { id: "sdk", label: "SDK", note: "fetch rules for v42", x: 245, y: 332, step: 2 },
  { id: "app", label: "Your code", note: "isEnabled(): local", x: 24, y: 332, step: 2 },
];

/** The connecting lines, grouped by the step that draws them. */
const WIRES: ReadonlyArray<{ d: string; step: number }> = [
  { d: "M174 62 H245", step: 0 },
  { d: "M395 62 H466", step: 0 },
  { d: "M320 88 V184", step: 1 },
  { d: "M395 210 H466", step: 1 },
  { d: "M541 236 V358 H395", step: 2 },
  { d: "M320 236 V332", step: 2 },
  { d: "M245 358 H174", step: 2 },
];

/** Used when the section is not pinned: the diagram is simply complete. */
const DONE = motionValue(1);

/**
 * The architecture, drawn as you scroll.
 *
 * On a desktop the section is three screens tall and its content is `position: sticky`, so it
 * stays put while you scroll through it; the scroll position (0 to 1) draws the lines. On a phone,
 * or with reduced motion, nothing is pinned: the finished drawing and the three steps are just
 * laid out in the page.
 */
export default function Blueprint() {
  const reduced = useReducedMotion() ?? false;
  const pinned = useDesktop() && !reduced;
  const track = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: track, offset: ["start start", "end end"] });
  const progress = pinned ? scrollYProgress : DONE;

  const [step, setStep] = useState(0);
  // Three updates over the whole scroll, not one per scroll event.
  useMotionValueEvent(scrollYProgress, "change", (value) => {
    const next = Math.min(STEPS.length - 1, Math.floor(value * STEPS.length));
    setStep((current) => (current === next ? current : next));
  });
  const active = pinned ? step : STEPS.length - 1;

  return (
    <section aria-labelledby="blueprint-title" className="border-y border-hairline bg-sunken">
      <div ref={track} className={pinned ? "h-[300vh]" : undefined}>
        <div className={cn("mx-auto grid max-w-6xl items-center gap-12 px-4 md:px-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]", pinned ? "sticky top-0 h-dvh" : "py-24")}>
          <div>
            <FigCaption index="0.3" label="Architecture" />
            <h2 id="blueprint-title" className="mt-5 text-4xl font-semibold leading-none tracking-[-0.035em] text-ink md:text-5xl">
              The whole machine, on <span className="accent text-[1.06em] font-normal">one</span> sheet.
            </h2>
            <ol className="relative mt-10 space-y-7 pl-6">
              <span aria-hidden className="absolute bottom-1 left-0 top-1 w-px bg-hairline" />
              <motion.span aria-hidden style={{ scaleY: progress }} className="absolute bottom-1 left-0 top-1 w-px origin-top bg-ink" />
              {STEPS.map((item, i) => (
                // Only opacity changes between steps, so the text column never reflows while pinned.
                <li key={item.title} data-active={pinned ? i === active : true} className={cn("transition-opacity duration-200", !pinned || i === active ? "opacity-100" : "opacity-35")}>
                  <p className="caption text-faint">Step {String(i + 1).padStart(2, "0")}</p>
                  <h3 className="mt-1.5 text-lg font-medium text-ink">{item.title}</h3>
                  <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">{item.body}</p>
                </li>
              ))}
            </ol>
          </div>

          <Diagram progress={progress} />
        </div>
      </div>
    </section>
  );
}

function Diagram({ progress }: { progress: MotionValue<number> }) {
  return (
    <svg viewBox="0 0 640 420" role="img" aria-label="Dashboard to API server to Postgres; API server to Redis to the other servers; servers to the SDK inside your app." className="w-full">
      {WIRES.map((wire, i) => (
        <Wire key={wire.d} {...wire} order={WIRES.filter((other, j) => other.step === wire.step && j < i).length} progress={progress} />
      ))}
      {BOXES.map((box) => (
        <BoxMark key={box.id} box={box} progress={progress} />
      ))}
    </svg>
  );
}

/** One third of the scroll per step. Within a step, its lines draw one after another. */
function Wire({ d, step, order, progress }: { d: string; step: number; order: number; progress: MotionValue<number> }) {
  const inStep = WIRES.filter((wire) => wire.step === step).length;
  const from = (step + (order / inStep) * 0.8) / STEPS.length;
  const to = (step + ((order + 1) / inStep) * 0.8) / STEPS.length;
  const pathLength = useTransform(progress, [from, to], [0, 1], { clamp: true });
  return (
    <>
      <path d={d} fill="none" className="stroke-hairline" strokeWidth={1} strokeDasharray="2 4" />
      <motion.path d={d} fill="none" className="stroke-ink" strokeWidth={1} style={{ pathLength }} />
    </>
  );
}

function BoxMark({ box, progress }: { box: Box; progress: MotionValue<number> }) {
  const start = box.step / STEPS.length;
  const opacity = useTransform(progress, [start - 0.02, start + 0.08], [0.3, 1], { clamp: true });
  return (
    <motion.g style={{ opacity: box.step === 0 ? 1 : opacity }}>
      <rect x={box.x} y={box.y} width={W} height={H} className="fill-canvas stroke-line-strong" strokeWidth={1} />
      <text x={box.x + 12} y={box.y + 22} className="fill-ink text-[13px] font-medium">
        {box.label}
      </text>
      <text x={box.x + 12} y={box.y + 39} className="fill-muted font-mono text-[9.5px]">
        {box.note}
      </text>
    </motion.g>
  );
}

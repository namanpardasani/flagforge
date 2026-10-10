import { animate, AnimatePresence, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from "motion/react";
import { Switch } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { Crosshairs } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { cn } from "@/lib/cn";
import { duration, easeOut, Reveal, spring } from "@/motion";

/** How long the pulse takes to travel the whole path, in seconds. */
const TRAVEL_S = 0.9;

// The route a change takes, as corner points of a right-angled line (drawn in a 480 x 120 box).
const ROUTE: ReadonlyArray<readonly [number, number]> = [
  [30, 40], [100, 40], [100, 80], [170, 80], [240, 80], [240, 40], [310, 40], [380, 40], [380, 80], [450, 80],
];
const NODES = [
  { label: "Dashboard", at: 0 },
  { label: "Server", at: 3 },
  { label: "Redis", at: 6 },
  { label: "SDK", at: 9 },
] as const;

// Distance along the route at each corner, worked out once. This is what lets the pulse be placed
// with plain arithmetic instead of asking the browser to measure the SVG path every frame.
const LENGTHS = ROUTE.reduce<number[]>((sums, point, i) => {
  if (i === 0) return [0];
  const previous = ROUTE[i - 1]!;
  return [...sums, sums[i - 1]! + Math.hypot(point[0] - previous[0], point[1] - previous[1])];
}, []);
const TOTAL = LENGTHS[LENGTHS.length - 1]!;
const PATH = ROUTE.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join(" ");

/** The point a given fraction (0 to 1) of the way along the route. */
function pointAt(fraction: number): [number, number] {
  const distance = Math.min(1, Math.max(0, fraction)) * TOTAL;
  const next = Math.max(1, LENGTHS.findIndex((length) => length >= distance));
  const [fromX, fromY] = ROUTE[next - 1]!;
  const [toX, toY] = ROUTE[next]!;
  const span = LENGTHS[next]! - LENGTHS[next - 1]!;
  const along = span === 0 ? 0 : (distance - LENGTHS[next - 1]!) / span;
  return [fromX + (toX - fromX) * along, fromY + (toY - fromY) * along];
}

/**
 * "Flip it. Watch it land." A toggle, the four hops a change makes, and a checkout that changes
 * only when the pulse arrives at the SDK. Everything is simulated in the browser.
 */
export default function Flip() {
  const reduced = useReducedMotion() ?? false;
  /** What the toggle says. */
  const [wanted, setWanted] = useState(false);
  /** What the "app" on the right has actually received. It lags behind `wanted` by one trip. */
  const [landed, setLanded] = useState(false);
  /** How many nodes the pulse has passed on the current trip. */
  const [reached, setReached] = useState<number>(NODES.length);

  const progress = useMotionValue(1);
  const x = useTransform(progress, (value) => pointAt(value)[0]);
  const y = useTransform(progress, (value) => pointAt(value)[1]);
  const pulseOpacity = useTransform(progress, [0, 0.04, 0.94, 1], [0, 1, 1, 0]);
  const trip = useRef<ReturnType<typeof animate> | null>(null);

  // Four state updates per trip (one per node), not one per frame.
  useMotionValueEvent(progress, "change", (value) => {
    const passed = NODES.filter((node) => LENGTHS[node.at]! / TOTAL <= value + 0.001).length;
    setReached((current) => (current === passed ? current : passed));
  });

  useEffect(() => () => trip.current?.stop(), []);

  const flip = (next: boolean) => {
    setWanted(next);
    trip.current?.stop();
    if (reduced) {
      progress.jump(1);
      setLanded(next);
      return;
    }
    progress.jump(0);
    trip.current = animate(progress, 1, { duration: TRAVEL_S, ease: "linear", onComplete: () => setLanded(next) });
  };

  const travelling = wanted !== landed;

  return (
    <section aria-labelledby="flip-title" className="mx-auto max-w-6xl px-4 py-24 md:px-6 md:py-32">
      <Reveal whenInView>
        <FigCaption index="0.2" label="Propagation" />
        <h2 id="flip-title" className="mt-5 text-4xl font-semibold leading-none tracking-[-0.035em] text-ink md:text-6xl">
          Flip it. Watch it <span className="accent text-[1.06em] font-normal">land</span>.
        </h2>
        <p className="mt-5 max-w-xl text-base leading-relaxed text-muted">
          Your app does not ask whether anything changed. It is told. A flip in the dashboard reaches every running SDK through four hops, and the next flag check uses the new rules.
        </p>
      </Reveal>

      <div className="mt-14 grid items-center gap-10 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,22rem)]">
        <div>
          <Switch.Root
            checked={wanted}
            onCheckedChange={flip}
            aria-label="one-tap-checkout flag"
            className={cn("relative block h-20 w-36 rounded-md border bg-sunken", wanted ? "border-ember" : "border-line-strong")}
          >
            <motion.span aria-hidden initial={false} animate={{ opacity: wanted ? 1 : 0 }} transition={{ duration: duration.instant }} className="absolute inset-0 rounded-[3px] bg-ember" />
            <Switch.Thumb asChild>
              <motion.span initial={false} animate={{ x: wanted ? 68 : 8 }} transition={spring.snappy} className={cn("relative block size-16 rounded-sm", wanted ? "bg-canvas" : "bg-muted")} />
            </Switch.Thumb>
          </Switch.Root>
          <p className="mt-4 font-mono text-sm text-ink">one-tap-checkout</p>
          <p className="caption mt-1 text-muted" aria-live="polite">
            {travelling ? "On its way" : landed ? "On in production" : "Off in production"}
          </p>
        </div>

        <figure className="min-w-0">
          <svg viewBox="0 0 480 120" className="w-full overflow-visible" role="img" aria-label="A change travels from the dashboard to the server, to Redis, to the SDK in your app.">
            <path d={PATH} fill="none" className="stroke-line-strong" strokeWidth={1} />
            {NODES.map((node, i) => {
              const [nodeX, nodeY] = ROUTE[node.at]!;
              // A node shows the new value once the pulse has passed it, and the old value until then.
              const on = i < reached ? wanted : landed;
              return (
                <g key={node.label} data-node={node.label} data-on={on}>
                  <rect x={nodeX - 9} y={nodeY - 9} width={18} height={18} className="fill-canvas stroke-line-strong" strokeWidth={1} />
                  <rect x={nodeX - 4} y={nodeY - 4} width={8} height={8} className={on ? "fill-ember" : "fill-faint"} />
                  <text x={nodeX} y={nodeY > 60 ? nodeY + 28 : nodeY - 18} textAnchor="middle" className="fill-muted font-mono text-[10px] uppercase tracking-widest">
                    {node.label}
                  </text>
                </g>
              );
            })}
            {/* The pulse. Ember when it carries "on" (something is going live), ink when it carries "off". */}
            <motion.rect width={10} height={10} style={{ x, y, opacity: pulseOpacity, translateX: -5, translateY: -5 }} className={wanted ? "fill-ember" : "fill-ink"} />
          </svg>
          <figcaption className="mt-6 max-w-md text-xs leading-relaxed text-faint">
            Slowed down here so you can follow it. On one machine, from the API call to the SDK seeing the change, the real path took 23.7 ms at the median (25 runs).
          </figcaption>
        </figure>

        <Checkout oneTap={landed} />
      </div>

      <Reveal whenInView className="mt-16 border-t border-hairline pt-6">
        <p className="text-2xl font-medium tracking-tight text-ink md:text-3xl">
          Kill switch. One click. <span className="text-muted">Under a second.</span>
        </p>
      </Reveal>
    </section>
  );
}

/** A pretend checkout page. With the flag on, the card form is replaced by a single saved-card button. */
function Checkout({ oneTap }: { oneTap: boolean }) {
  return (
    <div className="relative border border-hairline bg-raised/50" data-checkout={oneTap ? "one-tap" : "form"}>
      <Crosshairs />
      <p className="caption flex items-center justify-between border-b border-hairline px-4 py-2 text-faint">
        <span>parcels.example / checkout</span>
        <span>your app</span>
      </p>
      <div className="px-4 py-4">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-ink">Same-day courier</span>
          <span className="font-mono text-ink">184,00 kr</span>
        </div>
        <p className="mt-1 text-xs text-muted">Oslo to Bergen, one parcel, 4.2 kg</p>

        {/* Fixed height: swapping the two versions must not move the page. */}
        <div className="relative mt-5 h-36">
          <AnimatePresence mode="wait" initial={false}>
            {oneTap ? (
              <motion.div key="one-tap" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: duration.quick, ease: easeOut }} className="absolute inset-0 flex flex-col">
                <p className="flex items-center justify-between rounded-xs border border-hairline bg-sunken px-3 py-2.5 text-sm">
                  <span className="text-muted">Saved card</span>
                  <span className="font-mono text-ink">•••• 4417</span>
                </p>
                <p className="mt-2 text-xs text-muted">Receipt goes to the address on file.</p>
                <span className="mt-auto flex h-10 items-center justify-center rounded-sm bg-ink text-sm font-medium text-canvas">Pay in one tap</span>
              </motion.div>
            ) : (
              <motion.div key="form" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: duration.quick, ease: easeOut }} className="absolute inset-0 flex flex-col">
                <div className="grid grid-cols-[1fr_4rem_3.5rem] gap-2 font-mono text-xs text-faint">
                  <span className="rounded-xs border border-hairline bg-sunken px-3 py-2.5">Card number</span>
                  <span className="rounded-xs border border-hairline bg-sunken px-2 py-2.5">MM/YY</span>
                  <span className="rounded-xs border border-hairline bg-sunken px-2 py-2.5">CVC</span>
                </div>
                <span className="mt-2 rounded-xs border border-hairline bg-sunken px-3 py-2.5 font-mono text-xs text-faint">Name on card</span>
                <span className="mt-auto flex h-10 items-center justify-center rounded-sm border border-line-strong text-sm font-medium text-ink">Pay 184,00 kr</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

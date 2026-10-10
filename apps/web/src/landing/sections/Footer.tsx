import { ArrowRight } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { Ticker } from "@/components/ui/ticker";
import { paths } from "@/components/shell/use-scope";
import { Reveal } from "@/motion";
import { useFinePointer, useNear } from "../hooks";
import { Magnetic } from "../Magnetic";

const WORD = [..."FLAGFORGE"];
/** How close the cursor must be (as a share of the wordmark's width) for a letter to react. */
const REACH = 0.22;

// Counted from the repository on the day this page was written, not estimates.
const FACTS = [
  { value: 382, pad: 3, label: "tests: server, core, SDK" },
  { value: 33, pad: 2, label: "API routes" },
  { value: 4, pad: 1, label: "roles, owner to viewer" },
] as const;

export default function Footer({ dashboardPath }: { dashboardPath: string }) {
  const [factsRef, seen] = useNear<HTMLDListElement>("0px");
  return (
    <footer className="relative overflow-hidden border-t border-hairline">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-24 md:px-6 md:pt-32">
        <Reveal whenInView className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
          <h2 className="max-w-2xl text-4xl font-semibold leading-none tracking-[-0.035em] text-ink md:text-6xl">
            Put the next release behind a <span className="accent text-[1.06em] font-normal">flag</span>.
          </h2>
          <Magnetic>
            <Link to={dashboardPath} className="flex h-11 items-center gap-2 rounded-sm bg-ink px-5 text-sm font-medium text-canvas hover:bg-ink/90">
              Open the dashboard <ArrowRight className="size-4" strokeWidth={1.5} />
            </Link>
          </Magnetic>
        </Reveal>

        <dl ref={factsRef} className="mt-16 grid gap-y-4 border-t border-hairline pt-6 sm:grid-cols-3">
          {FACTS.map((fact) => (
            <div key={fact.label} className="flex items-baseline gap-3">
              {/* Counts up from zero the first time it is seen; the real value is always in the markup for screen readers. */}
              <dd className="text-2xl text-ink">
                <span className="sr-only">{fact.value}</span>
                <span aria-hidden>
                  <Ticker value={seen ? fact.value : 0} pad={fact.pad} />
                </span>
              </dd>
              <dt className="caption text-muted">{fact.label}</dt>
            </div>
          ))}
        </dl>
      </div>

      <Wordmark />

      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 md:px-6">
        <p className="caption text-faint">FlagForge / a portfolio project by Naman Pardasani</p>
        <nav aria-label="Footer" className="caption flex gap-6 text-muted">
          <Link to={dashboardPath} className="hover:text-ink">
            Dashboard
          </Link>
          <Link to={paths.kit} className="hover:text-ink">
            UI kit
          </Link>
          <a href="https://github.com/namanpardasani/flagforge" className="hover:text-ink">
            Source
          </a>
        </nav>
      </div>
    </footer>
  );
}

/**
 * The giant wordmark. Each letter is dim until the cursor comes near, then it brightens and lifts.
 *
 * Styles are written straight to the nine letter elements (opacity and transform only), at most
 * once per frame, and a short CSS transition smooths the change. React renders this once.
 */
function Wordmark() {
  const ref = useRef<HTMLParagraphElement>(null);
  const fine = useFinePointer();
  const reduced = useReducedMotion();
  const enabled = fine && !reduced;

  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    const letters = [...root.children] as HTMLElement[];
    let frame = 0;
    let pointerX: number | null = null;

    const paint = () => {
      frame = 0;
      const box = root.getBoundingClientRect();
      for (const letter of letters) {
        let near = 0;
        if (pointerX !== null) {
          const centre = letter.offsetLeft + letter.offsetWidth / 2;
          near = Math.max(0, 1 - Math.abs(pointerX - box.left - centre) / (box.width * REACH));
        }
        letter.style.opacity = String(0.16 + near * 0.84);
        letter.style.transform = `translateY(${(-near * 5).toFixed(2)}%)`;
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    };
    const onMove = (event: PointerEvent) => {
      pointerX = event.clientX;
      schedule();
    };
    const onLeave = () => {
      pointerX = null;
      schedule();
    };

    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
    };
  }, [enabled]);

  return (
    <p ref={ref} aria-hidden data-wordmark className="flex select-none justify-between px-[1.5vw] text-[16.2vw] font-semibold leading-[0.8] tracking-[-0.02em] text-ink">
      {WORD.map((letter, i) => (
        <span key={i} className="block opacity-[0.16] transition-[opacity,transform] duration-300 ease-out-quart">
          {letter}
        </span>
      ))}
    </p>
  );
}

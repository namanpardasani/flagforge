import "lenis/dist/lenis.css";
import { ReactLenis } from "lenis/react";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { FigCaption, Grain, GridLines } from "@/components/blueprint/marks";
import { Mark } from "@/components/shell/Sidebar";
import { DEFAULT_SCOPE, paths } from "@/components/shell/use-scope";
import { Reveal, RevealGroup, RevealItem } from "@/motion";

/**
 * Landing PREVIEW. The real marketing page is a later prompt; this exists so the marketing-only
 * pieces can be reviewed now: smooth scrolling (Lenis), the drafting grid, the two-tone headline.
 *
 * Lenis is imported here and nowhere else, and this page is lazy-loaded, so the dashboard never
 * downloads or runs it. A dashboard should scroll exactly like the operating system does.
 * Lenis turns itself off when the visitor prefers reduced motion.
 */
export default function LandingPage() {
  const dashboard = paths.project(DEFAULT_SCOPE.workspaceSlug, DEFAULT_SCOPE.projectKey);

  return (
    <ReactLenis root options={{ lerp: 0.12, anchors: true }}>
      <div className="relative min-h-dvh bg-canvas">
        <GridLines className="h-[900px]" />

        <header className="relative mx-auto flex h-16 max-w-6xl items-center justify-between border-b border-hairline px-6">
          <span className="flex items-center gap-2.5 text-sm font-medium text-ink">
            <Mark /> FlagForge
          </span>
          <Link to={dashboard} className="flex h-8 items-center gap-2 rounded-sm bg-ink px-3 text-sm font-medium text-canvas hover:bg-ink/90">
            Open dashboard <ArrowRight className="size-4" strokeWidth={1.5} />
          </Link>
        </header>

        <main className="relative mx-auto max-w-6xl px-6">
          <RevealGroup step={0.08} className="pb-24 pt-20">
            <RevealItem>
              <FigCaption index="0.0" label="Feature flags and rollouts" />
            </RevealItem>
            <RevealItem>
              <h1 className="mt-6 max-w-4xl text-balance text-5xl font-medium leading-[1.05] tracking-tight text-ink md:text-6xl">
                Ship the change. Keep the <span className="accent text-[1.08em]">switch</span>.{" "}
                <span className="text-muted">Put a release behind a flag, roll it out by percentage, and turn it off in one click if it misbehaves.</span>
              </h1>
            </RevealItem>
          </RevealGroup>

          <section aria-label="How it works" className="grid border-y border-hairline md:grid-cols-3 md:divide-x md:divide-hairline">
            <Figure index="0.1" title="Decided inside your app" drawing={<Layers />}>
              The SDK downloads the rules once and evaluates every flag in process. A flag check costs no network call.
            </Figure>
            <Figure index="0.2" title="Changes arrive as they happen" drawing={<Nodes />}>
              The server streams a signal when a flag changes and each SDK fetches the new rules. If the stream drops, polling takes over.
            </Figure>
            <Figure index="0.3" title="Every change is on record" drawing={<Ledger />}>
              Who changed which flag, in which environment, and what it was before. Written in the same transaction as the change.
            </Figure>
          </section>

          <section aria-labelledby="path-title" className="py-28">
            <FigCaption id="path-title" index="0.4" label="The path of one change" />
            <ol className="mt-8 max-w-2xl">
              {STEPS.map((step, i) => (
                <Reveal key={step.title} whenInView className="grid grid-cols-[3rem_1fr] border-b border-hairline py-6 first:border-t">
                  <span className="font-mono text-xs text-faint">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <h3 className="text-base font-medium text-ink">{step.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
                  </div>
                </Reveal>
              ))}
            </ol>
          </section>
        </main>

        <footer className="relative mx-auto flex max-w-6xl items-center justify-between border-t border-hairline px-6 py-6">
          <p className="caption text-faint">FlagForge / landing preview</p>
          <Link to={paths.kit} className="caption text-muted hover:text-ink">
            UI kit
          </Link>
        </footer>
        <Grain />
      </div>
    </ReactLenis>
  );
}

const STEPS = [
  { title: "Someone flips a flag", body: "In the dashboard, for one environment. The change and its audit entry are saved together or not at all." },
  { title: "The environment gets a new version number", body: "Each environment counts its own changes, so an SDK can tell at a glance whether it has missed anything." },
  { title: "Connected SDKs are told", body: "A small message goes down an open stream: this environment is now at version 42. Nothing else is sent." },
  { title: "Each SDK fetches and swaps", body: "It downloads the rules for that version and replaces its copy in one step. The next flag check uses them." },
] as const;

function Figure({ index, title, drawing, children }: { index: string; title: string; drawing: ReactNode; children: ReactNode }) {
  return (
    <Reveal whenInView className="px-6 py-8 max-md:border-b max-md:border-hairline max-md:last:border-b-0 md:first:pl-0 md:last:pr-0">
      <FigCaption index={index} />
      <div className="my-8 h-28 text-line-strong">{drawing}</div>
      <h2 className="text-base font-medium text-ink">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
    </Reveal>
  );
}

// Thin-line drawings. One stroke weight, no fills, so they read as diagrams rather than icons.
const stroke = { stroke: "currentColor", strokeWidth: 1, fill: "none" } as const;

function Layers() {
  return (
    <svg viewBox="0 0 160 112" aria-hidden className="h-full">
      {[0, 1, 2].map((i) => (
        <path key={i} d={`M80 ${18 + i * 22} l56 20 -56 20 -56 -20z`} {...stroke} className={i === 0 ? "text-ink" : undefined} />
      ))}
    </svg>
  );
}

function Nodes() {
  return (
    <svg viewBox="0 0 160 112" aria-hidden className="h-full">
      <path d="M36 56h36M88 56l36 -28M88 56h36M88 56l36 28" {...stroke} />
      <rect x="20" y="48" width="16" height="16" {...stroke} className="text-ink" />
      <rect x="72" y="48" width="16" height="16" {...stroke} />
      {[20, 48, 76].map((y) => (
        <rect key={y} x="124" y={y} width="16" height="16" {...stroke} />
      ))}
    </svg>
  );
}

function Ledger() {
  return (
    <svg viewBox="0 0 160 112" aria-hidden className="h-full">
      <rect x="28" y="14" width="104" height="84" {...stroke} />
      {[34, 54, 74].map((y, i) => (
        <g key={y}>
          <path d={`M40 ${y}h8`} {...stroke} className="text-ink" />
          <path d={`M56 ${y}h${[58, 44, 52][i]}`} {...stroke} />
        </g>
      ))}
    </svg>
  );
}

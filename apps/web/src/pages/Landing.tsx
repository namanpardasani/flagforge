import "lenis/dist/lenis.css";
import { ReactLenis } from "lenis/react";
import { ArrowRight } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Grain, GridLines } from "@/components/blueprint/marks";
import { Mark } from "@/components/shell/Sidebar";
import { paths } from "@/components/shell/use-scope";
import { cn } from "@/lib/cn";
import { Boot } from "@/landing/Boot";
import { shouldBoot } from "@/landing/boot-session";
import { Cursor } from "@/landing/Cursor";
import { Hero } from "@/landing/Hero";
import { useFinePointer, useNear } from "@/landing/hooks";
import { Magnetic } from "@/landing/Magnetic";

// Everything below the hero is a separate file that is downloaded only when you scroll near it.
// The first screen therefore loads the hero and nothing else.
const Flip = lazy(() => import("@/landing/sections/Flip"));
const Blueprint = lazy(() => import("@/landing/sections/Blueprint"));
const Bento = lazy(() => import("@/landing/sections/Bento"));
const Sdk = lazy(() => import("@/landing/sections/Sdk"));
const Marquee = lazy(() => import("@/landing/sections/Marquee"));
const Footer = lazy(() => import("@/landing/sections/Footer"));

const NAV = [
  { href: "#flip", label: "How it lands" },
  { href: "#blueprint", label: "Architecture" },
  { href: "#sdk", label: "SDK" },
] as const;

/**
 * The landing page: one long scroll, every demo simulated in the browser (no backend calls).
 *
 * Lenis (smooth scrolling) is imported here and nowhere else, and this page is itself lazy-loaded,
 * so the dashboard never downloads or runs it. Lenis leaves touch scrolling native and turns
 * itself off when the visitor prefers reduced motion.
 */
export default function LandingPage() {
  // "/" sends a signed-in visitor to their first project and anyone else to the sign-in screen.
  const dashboard = paths.home;
  const reduced = useReducedMotion() ?? false;
  const fine = useFinePointer();
  // Decided once, on the first render: the intro must not appear halfway through a visit.
  const [booting, setBooting] = useState(() => shouldBoot() && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [ready, setReady] = useState(!booting);

  return (
    <ReactLenis root options={{ lerp: 0.12, anchors: true }}>
      <div className="relative min-h-dvh bg-canvas">
        <GridLines className="h-[980px]" />

        <header className="relative mx-auto flex h-16 max-w-6xl items-center justify-between border-b border-hairline px-4 md:px-6">
          <span className="flex items-center gap-2.5 text-sm font-medium text-ink">
            <Mark /> FlagForge
          </span>
          <nav aria-label="Sections" className="caption hidden gap-8 text-muted md:flex">
            {NAV.map((item) => (
              <a key={item.href} href={item.href} className="hover:text-ink">
                {item.label}
              </a>
            ))}
          </nav>
          <Magnetic>
            <Link to={dashboard} className="flex h-8 items-center gap-2 rounded-sm border border-line-strong px-3 text-sm font-medium text-ink hover:bg-raised">
              Open dashboard <ArrowRight className="size-4" strokeWidth={1.5} />
            </Link>
          </Magnetic>
        </header>

        <main className="relative">
          <Hero ready={ready} dashboardPath={dashboard} />

          <LazySection id="flip" placeholder="min-h-[900px] lg:min-h-[760px]">
            <Flip />
          </LazySection>
          <LazySection id="blueprint" placeholder="min-h-[900px] md:min-h-[300vh]">
            <Blueprint />
          </LazySection>
          <LazySection id="bento" placeholder="min-h-[1100px] md:min-h-[860px]">
            <Bento />
          </LazySection>
          <LazySection id="sdk" placeholder="min-h-[820px] lg:min-h-[620px]">
            <Sdk />
          </LazySection>
          <LazySection placeholder="min-h-[62px]">
            <Marquee />
          </LazySection>
        </main>

        <LazySection placeholder="min-h-[640px]">
          <Footer dashboardPath={dashboard} />
        </LazySection>

        <Grain />
        {fine && !reduced && <Cursor />}
        {booting && <Boot onReveal={() => setReady(true)} onGone={() => setBooting(false)} />}
      </div>
    </ReactLenis>
  );
}

/**
 * Holds a section's place with an empty box of about the right height until the visitor scrolls
 * near it, then loads and shows the real thing. The swap happens well below the screen edge, so
 * nothing the visitor is looking at moves.
 */
function LazySection({ id, placeholder, children }: { id?: string; placeholder: string; children: ReactNode }) {
  const [ref, near] = useNear<HTMLDivElement>("700px");
  return (
    <div ref={ref} id={id} className={cn("scroll-mt-8", !near && placeholder)}>
      {near && <Suspense fallback={<div className={placeholder} />}>{children}</Suspense>}
    </div>
  );
}

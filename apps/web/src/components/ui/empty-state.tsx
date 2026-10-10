import type { ReactNode } from "react";
import { Frame } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { RevealGroup, RevealItem, scaleIn, useOffscreenPause } from "@/motion";

interface EmptyStateProps {
  /** Figure number shown in the caption, e.g. "1.2". */
  fig: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}

/**
 * What a screen shows when there is nothing to list yet.
 * The parts arrive one after another (a stagger), and a thin line keeps sweeping the drawing so
 * the screen reads as "waiting" rather than "broken". The sweep stops when offscreen.
 */
export function EmptyState({ fig, title, children, action }: EmptyStateProps) {
  const glyph = useOffscreenPause<HTMLDivElement>();
  return (
    <Frame className="px-6 py-16">
      <RevealGroup step={0.07} className="mx-auto flex max-w-md flex-col items-center text-center">
        <RevealItem variants={scaleIn}>
          <div ref={glyph} className="relative size-24 overflow-hidden rounded-xs border border-hairline bg-sunken">
            <svg viewBox="0 0 96 96" fill="none" aria-hidden className="absolute inset-0 text-muted">
              {/* an empty flag: pole, outline where the flag would be, and a base line */}
              <path d="M34 22v52" stroke="currentColor" strokeWidth="1" />
              <path d="M34 26h30l-7 9 7 9H34" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" />
              <path d="M24 74h48" stroke="currentColor" strokeWidth="1" />
              <path d="M30 78h8M44 78h4M54 78h12" stroke="currentColor" strokeWidth="1" opacity="0.45" />
            </svg>
            <span aria-hidden className="absolute inset-0 animate-scan">
              <span className="block h-px w-full bg-ink/40" />
            </span>
          </div>
        </RevealItem>
        <RevealItem className="mt-6">
          <FigCaption index={fig} label="Nothing here yet" />
        </RevealItem>
        <RevealItem>
          <h2 className="mt-3 text-lg font-medium tracking-tight text-ink">{title}</h2>
        </RevealItem>
        <RevealItem>
          <p className="mt-2 text-pretty text-sm leading-relaxed text-muted">{children}</p>
        </RevealItem>
        {action && <RevealItem className="mt-6">{action}</RevealItem>}
      </RevealGroup>
    </Frame>
  );
}

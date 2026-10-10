import type { Transition } from "motion/react";

/**
 * Motion tokens. Components never invent their own timings: they pick a name from here, so the
 * whole app moves with one voice. Rules are in design/MOTION.md.
 */

/** Seconds (Motion's unit). UI feedback stays under 0.2s; only `grand` may reach 0.8s. */
export const duration = {
  /** Press and hover feedback. */
  instant: 0.12,
  /** Menus, tooltips, small reveals. */
  quick: 0.18,
  /** Page and panel transitions. */
  base: 0.32,
  /** Large, rare moments: first paint of a screen, an empty state arriving. */
  grand: 0.8,
} as const;

/** Decelerating curve: things arrive quickly and settle gently. */
export const easeOut = [0.22, 1, 0.36, 1] as const;

/**
 * Springs are described by physics, not time, so they stay natural when interrupted mid-flight
 * (a tween restarted halfway looks like a stutter; a spring just changes direction).
 */
export const spring = {
  /** Tight and fast, no visible overshoot. Toggles, markers, small controls. */
  snappy: { type: "spring", stiffness: 520, damping: 38, mass: 0.7 },
  /** Softer arrival for content entering the screen. */
  gentle: { type: "spring", stiffness: 220, damping: 28, mass: 1 },
  /** Shared-layout moves: the sidebar collapsing, an indicator sliding between items. */
  layout: { type: "spring", stiffness: 380, damping: 34, mass: 0.9 },
} as const satisfies Record<string, Transition>;

/** Delay between siblings in a staggered list. Small, so long lists do not feel slow. */
export const staggerStep = 0.04;

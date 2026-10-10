import { render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cn } from "@/lib/cn";
import { countWord, formatStamp, plural } from "@/lib/format";
import { setReducedMotion } from "@/test/setup";
import { duration, fadeUp, MotionProvider, page, Reveal, scaleIn, slideInRight, spring, stagger, useOffscreenPause, useSafeVariants } from ".";

afterEach(() => {
  setReducedMotion(false);
});

/** Every key a variant is allowed to animate. Anything else would break the motion rules. */
const ALLOWED = new Set(["opacity", "x", "y", "scale", "transition"]);

describe("motion rules (design/MOTION.md), enforced", () => {
  it("UI feedback durations stay under 200ms and nothing exceeds 800ms", () => {
    expect(duration.instant).toBeLessThan(0.2);
    expect(duration.quick).toBeLessThan(0.2);
    for (const value of Object.values(duration)) expect(value).toBeLessThanOrEqual(0.8);
    expect(duration.grand).toBe(0.8);
  });

  it("variants animate only transform and opacity", () => {
    for (const [name, variants] of Object.entries({ fadeUp, scaleIn, slideInRight, page })) {
      for (const [pose, target] of Object.entries(variants)) {
        for (const key of Object.keys(target as object)) {
          expect(ALLOWED.has(key), `${name}.${pose} animates "${key}"`).toBe(true);
        }
      }
    }
  });

  it("stagger only orchestrates children and adds no properties of its own", () => {
    const variants = stagger(0.05, 0.1);
    expect(variants["hidden"]).toEqual({});
    expect(variants["show"]).toEqual({ transition: { staggerChildren: 0.05, delayChildren: 0.1 } });
  });

  it("springs are well-damped (no long wobble)", () => {
    for (const s of Object.values(spring)) {
      // damping ratio = damping / (2 * sqrt(stiffness * mass)); below ~0.6 a spring visibly bounces
      const ratio = s.damping / (2 * Math.sqrt(s.stiffness * s.mass));
      expect(ratio).toBeGreaterThan(0.75);
    }
  });
});

describe("reduced motion", () => {
  it("keeps the real variant when motion is allowed", () => {
    const { result } = renderHook(() => useSafeVariants(fadeUp));
    expect(result.current).toBe(fadeUp);
  });

  it("swaps movement for a plain fade when the system asks for less motion", () => {
    setReducedMotion(true);
    const { result } = renderHook(() => useSafeVariants(slideInRight));
    expect(result.current).not.toBe(slideInRight);
    for (const target of Object.values(result.current)) {
      expect(Object.keys(target as object).filter((k) => k !== "transition")).toEqual(["opacity"]);
    }
  });

  it("Reveal still renders its content either way", () => {
    setReducedMotion(true);
    render(
      <MotionProvider>
        <Reveal>visible content</Reveal>
      </MotionProvider>,
    );
    expect(screen.getByText("visible content")).toBeInTheDocument();
  });
});

describe("useOffscreenPause", () => {
  function Probe() {
    const ref = useOffscreenPause<HTMLDivElement>();
    return <div ref={ref} data-testid="probe" />;
  }

  it("marks its element so CSS can pause animations, and follows tab visibility", () => {
    render(<Probe />);
    const el = screen.getByTestId("probe");
    expect(el.dataset["paused"]).toBe("false");

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(el.dataset["paused"]).toBe("true");

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(el.dataset["paused"]).toBe("false");
  });
});

describe("helpers", () => {
  it("cn merges conflicting classes and keeps the custom text size apart from colours", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-2xs", "text-muted")).toBe("text-2xs text-muted");
    expect(cn("text-muted", "text-ink")).toBe("text-ink");
    expect(cn("a", false, undefined, "b")).toBe("a b");
  });

  it("formats counts and timestamps deterministically", () => {
    expect(countWord(0)).toBe("no");
    expect(countWord(6)).toBe("six");
    expect(countWord(40)).toBe("40");
    expect(plural(1, "flag")).toBe("flag");
    expect(plural(2, "flag")).toBe("flags");
    expect(formatStamp("2026-10-10T11:42:00Z")).toBe("10 Oct, 11:42");
  });
});

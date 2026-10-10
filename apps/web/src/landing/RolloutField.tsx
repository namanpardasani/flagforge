import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { fieldBuckets, isLit, layoutField, pull, type FieldLayout } from "./field-model";

interface RolloutFieldProps {
  /** 0 to 100. */
  percentage: number;
  /** Roughly how many dots to draw. Fewer on small screens. */
  target: number;
  /** Animate ignitions and follow the cursor. Off for reduced motion: the field is then redrawn once per change. */
  lively: boolean;
  /** Told the real number of dots once the grid has been fitted to the box. */
  onTotal: (total: number) => void;
  label: string;
  className?: string;
}

/** Cursor reach in CSS pixels, and how far a dot may travel towards it. */
const REACH = 110;
const TRAVEL = 0.32;

/** Everything the animation loop touches. Kept outside React state: none of it should cause a render. */
interface Field {
  layout: FieldLayout;
  buckets: Uint16Array;
  /** 0 = off, 1 = fully lit. Eases towards its target each frame. */
  on: Float32Array;
  /** 1 at the moment of ignition, cooling to 0. Drawn as a brief swell. */
  heat: Float32Array;
  /** Frames to wait before a dot reacts, so a change ripples instead of snapping. */
  wait: Uint8Array;
  dx: Float32Array;
  dy: Float32Array;
}

const emptyField = (): Field => ({
  layout: layoutField(0, 0, 1),
  buckets: new Uint16Array(0),
  on: new Float32Array(0),
  heat: new Float32Array(0),
  wait: new Uint8Array(0),
  dx: new Float32Array(0),
  dy: new Float32Array(0),
});

/**
 * The hero: a grid of dots on a <canvas>, each one a user.
 *
 * Why canvas and not 1,200 DOM nodes: moving that many elements means the browser recalculates
 * style and layout for each of them every frame. A canvas is one element; we just paint squares
 * into it, which stays cheap even with the CPU slowed down four times.
 *
 * The loop is not always running. It stops by itself once every dot has settled and the cursor has
 * left, and it never runs while the field is off screen or the tab is hidden.
 */
export function RolloutField({ percentage, target, lively, onTotal, label, className }: RolloutFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [unsupported, setUnsupported] = useState(false);

  // The loop reads these through refs, so changing a prop never restarts the effect below.
  const percentageRef = useRef(percentage);
  const livelyRef = useRef(lively);
  const onTotalRef = useRef(onTotal);
  const kick = useRef<() => void>(() => {});
  useEffect(() => {
    const changed = percentageRef.current !== percentage;
    percentageRef.current = percentage;
    livelyRef.current = lively;
    onTotalRef.current = onTotal;
    if (changed) kick.current();
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d") ?? null;
    if (!canvas || !context) {
      setUnsupported(true);
      return;
    }

    const styles = getComputedStyle(canvas);
    const offColour = styles.getPropertyValue("--color-line-strong").trim() || "#3a372f";
    const onColour = styles.getPropertyValue("--color-ember").trim() || "#ff5a1f";

    let field = emptyField();
    let width = 0;
    let height = 0;
    let frame = 0;
    let inView = false;
    let shownPercentage = -1;
    const pointer = { x: 0, y: 0, inside: false };

    const fit = () => {
      const box = canvas.getBoundingClientRect();
      if (box.width === width && box.height === height) return;
      width = box.width;
      height = box.height;
      // Sharp on high-density screens, but capped: a 3x phone would paint nine times the pixels for no visible gain.
      const density = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * density);
      canvas.height = Math.round(height * density);
      context.setTransform(density, 0, 0, density, 0, 0);

      const layout = layoutField(width, height, target);
      if (layout.count !== field.layout.count) {
        const buckets = fieldBuckets(layout.count);
        const on = new Float32Array(layout.count);
        // After a resize, show the current state at once; only real rollout changes should animate.
        if (shownPercentage >= 0) for (let i = 0; i < layout.count; i++) on[i] = isLit(buckets[i]!, shownPercentage) ? 1 : 0;
        field = { layout, buckets, on, heat: new Float32Array(layout.count), wait: new Uint8Array(layout.count), dx: new Float32Array(layout.count), dy: new Float32Array(layout.count) };
        onTotalRef.current(layout.count);
      } else {
        field.layout = layout;
      }
    };

    /** Advances every dot one step and paints. Returns whether anything is still moving. */
    const step = (): boolean => {
      const { layout, buckets, on, heat, wait, dx, dy } = field;
      const now = percentageRef.current;
      const animate = livelyRef.current;

      if (now !== shownPercentage) {
        for (let i = 0; i < layout.count; i++) {
          const lit = isLit(buckets[i]!, now);
          const was = shownPercentage >= 0 && isLit(buckets[i]!, shownPercentage);
          // A cheap, repeatable scatter (no Math.random: the same change always ripples the same way).
          if (lit !== was) wait[i] = animate ? (i * 7919) % 14 : 0;
        }
        shownPercentage = now;
      }

      context.clearRect(0, 0, width, height);
      let moving = false;

      // Pass 1: every dot in its resting colour.
      context.globalAlpha = 1;
      context.fillStyle = offColour;
      for (let i = 0; i < layout.count; i++) {
        const lit = isLit(buckets[i]!, now);
        const goal = lit ? 1 : 0;

        if (wait[i]! > 0) {
          wait[i]!--;
          moving = true;
        } else if (on[i] !== goal) {
          if (!animate) on[i] = goal;
          else {
            if (lit && on[i]! < 0.05) heat[i] = 1; // just ignited
            on[i]! += (goal - on[i]!) * 0.16;
            if (Math.abs(goal - on[i]!) < 0.01) on[i] = goal;
            else moving = true;
          }
        }
        if (heat[i]! > 0) {
          heat[i]! *= 0.9;
          if (heat[i]! < 0.02) heat[i] = 0;
          else moving = true;
        }

        const baseX = layout.originX + (i % layout.cols) * layout.pitch;
        const baseY = layout.originY + Math.floor(i / layout.cols) * layout.pitch;

        let goalX = 0;
        let goalY = 0;
        if (pointer.inside && animate) {
          const awayX = pointer.x - baseX;
          const awayY = pointer.y - baseY;
          const strength = pull(Math.hypot(awayX, awayY), REACH) * TRAVEL;
          goalX = awayX * strength;
          goalY = awayY * strength;
        }
        dx[i]! += (goalX - dx[i]!) * 0.18;
        dy[i]! += (goalY - dy[i]!) * 0.18;
        if (Math.abs(goalX - dx[i]!) + Math.abs(goalY - dy[i]!) > 0.05) moving = true;
        else {
          dx[i] = goalX;
          dy[i] = goalY;
        }

        if (on[i]! < 1) context.fillRect(baseX + dx[i]! - 1, baseY + dy[i]! - 1, 2, 2);
      }

      // Pass 2: the lit ones on top, in ember. Two passes means fillStyle is set twice per frame, not per dot.
      context.fillStyle = onColour;
      for (let i = 0; i < layout.count; i++) {
        if (on[i]! <= 0) continue;
        const size = 2 + on[i]! * 1.6 + heat[i]! * 3.4;
        context.globalAlpha = on[i]!;
        context.fillRect(layout.originX + (i % layout.cols) * layout.pitch + dx[i]! - size / 2, layout.originY + Math.floor(i / layout.cols) * layout.pitch + dy[i]! - size / 2, size, size);
      }
      context.globalAlpha = 1;

      return moving || (pointer.inside && animate);
    };

    const loop = () => {
      frame = 0;
      if (!inView || document.hidden) return; // paused: nothing is scheduled until we are visible again
      if (step()) frame = requestAnimationFrame(loop);
    };
    const start = () => {
      if (frame === 0) frame = requestAnimationFrame(loop);
    };
    kick.current = start;

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return; // on touch a drag is a scroll, not a hover
      const box = canvas.getBoundingClientRect();
      pointer.x = event.clientX - box.left;
      pointer.y = event.clientY - box.top;
      pointer.inside = true;
      start();
    };
    const onLeave = () => {
      pointer.inside = false;
      start(); // let the dots drift home, then the loop stops by itself
    };

    const resize = new ResizeObserver(() => {
      fit();
      start();
    });
    resize.observe(canvas);
    const visibility = new IntersectionObserver((entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      if (inView) start();
    });
    visibility.observe(canvas);
    document.addEventListener("visibilitychange", start);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    fit();

    return () => {
      cancelAnimationFrame(frame);
      kick.current = () => {};
      resize.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", start);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [target]);

  if (unsupported) return <StaticField percentage={percentage} label={label} className={className} />;
  return <canvas ref={canvasRef} role="img" aria-label={label} data-cursor="field" className={cn("block size-full", className)} />;
}

/**
 * Shown when there is no canvas to draw on. A plain dotted pattern with the lit share covered in
 * ember from the left: less exact than the real field, but it says the same thing without scripts
 * doing any drawing.
 */
function StaticField({ percentage, label, className }: { percentage: number; label: string; className?: string }) {
  const dots = "bg-[radial-gradient(currentColor_1px,transparent_1.5px)] bg-[length:14px_14px]";
  return (
    <div role="img" aria-label={label} data-static-field className={cn("relative size-full overflow-hidden", className)}>
      <div className={cn("absolute inset-0 text-line-strong", dots)} />
      <div className={cn("absolute inset-y-0 left-0 text-ember", dots)} style={{ width: `${percentage}%` }} />
    </div>
  );
}

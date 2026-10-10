import { motion, useMotionValue, useSpring } from "motion/react";
import { useEffect, useState } from "react";
import { spring } from "@/motion";

type Mode = "default" | "action" | "field";

/** What is under the pointer decides the shape. `data-cursor` lets any element opt in. */
function modeFor(target: EventTarget | null): Mode {
  if (!(target instanceof Element)) return "default";
  if (target.closest('[data-cursor="field"]')) return "field";
  if (target.closest('a, button, [role="switch"], [role="slider"], [data-cursor="action"]')) return "action";
  return "default";
}

/**
 * The custom cursor: a small crosshair, like the registration marks on the frames.
 *  - over a link or button it closes into a square bracket around the target point;
 *  - over the dot field it opens into a wide reticle, showing the reach of the pull.
 *
 * Position is written to motion values, not React state, so moving the mouse renders nothing.
 * Only a change of SHAPE (three possible values) renders. The parent mounts this only for a fine
 * pointer with motion allowed, so touch devices and reduced-motion visitors keep the system cursor.
 */
export function Cursor() {
  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  // A stiff spring: the mark trails by a frame or two, enough to feel physical without lagging.
  const smoothX = useSpring(x, { stiffness: 1400, damping: 70, mass: 0.4 });
  const smoothY = useSpring(y, { stiffness: 1400, damping: 70, mass: 0.4 });
  const [mode, setMode] = useState<Mode>("default");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      x.set(event.clientX);
      y.set(event.clientY);
      setVisible(true);
    };
    const onOver = (event: PointerEvent) => setMode(modeFor(event.target));
    const onOut = () => setVisible(false);

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerover", onOver, { passive: true });
    document.documentElement.addEventListener("pointerleave", onOut);
    document.documentElement.classList.add("custom-cursor");
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerover", onOver);
      document.documentElement.removeEventListener("pointerleave", onOut);
      document.documentElement.classList.remove("custom-cursor");
    };
  }, [x, y]);

  const arm = "absolute bg-ink";
  return (
    <motion.div aria-hidden data-cursor-mark={mode} style={{ x: smoothX, y: smoothY, opacity: visible ? 1 : 0 }} className="pointer-events-none fixed left-0 top-0 z-[95]">
      {/* The crosshair. It shrinks to a point over actions and stretches over the field. */}
      <motion.span animate={{ scale: mode === "action" ? 0.25 : mode === "field" ? 1.6 : 1 }} transition={spring.snappy} className="absolute -left-2 -top-2 block size-4">
        <i className={`${arm} left-0 top-1/2 h-px w-full`} />
        <i className={`${arm} left-1/2 top-0 h-full w-px`} />
      </motion.span>
      {/* The bracket: a square outline that closes in around links and buttons. */}
      <motion.span
        animate={{ scale: mode === "action" ? 1 : 0.4, opacity: mode === "action" ? 1 : 0 }}
        transition={spring.snappy}
        className="absolute -left-3.5 -top-3.5 block size-7 rounded-xs border border-ink"
      />
      {/* The reticle: a diamond the width of the cursor's pull on the dots. */}
      <motion.span
        animate={{ scale: mode === "field" ? 1 : 0.5, opacity: mode === "field" ? 0.5 : 0, rotate: 45 }}
        transition={spring.gentle}
        className="absolute -left-9 -top-9 block size-[72px] border border-dashed border-muted"
      />
    </motion.div>
  );
}

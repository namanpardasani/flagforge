import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/cn";
import { quiet, slideInRight } from "@/motion";
import { dismissToast, pauseToasts, resumeToasts, useToasts, type ToastTone } from "@/stores/toasts";

const mark: Record<ToastTone, string> = { neutral: "bg-muted", live: "bg-ember", danger: "bg-danger" };

/**
 * The toast stack, bottom right. Rendered once, in the shell.
 *
 *  - Each toast slides in from the right on a spring and the others move up to make room
 *    (`layout`), instead of jumping.
 *  - `role="status"` + `aria-live="polite"`: screen readers announce a toast when they are next
 *    idle, without interrupting what is being read.
 *  - Hovering or focusing the stack pauses the countdown.
 */
export function Toaster() {
  const toasts = useToasts();
  return (
    <ol
      aria-label="Notifications"
      onMouseEnter={pauseToasts}
      onMouseLeave={resumeToasts}
      onFocus={pauseToasts}
      onBlur={resumeToasts}
      className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(340px,calc(100vw-2rem))] flex-col gap-2"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {toasts.map((t) => (
          <motion.li
            key={t.id}
            layout
            variants={slideInRight}
            initial="hidden"
            animate="show"
            exit="exit"
            transition={{ layout: quiet }}
            role="status"
            aria-live="polite"
            className="pointer-events-auto flex items-start gap-3 rounded-xs border border-hairline bg-raised px-3 py-2.5"
          >
            <span aria-hidden className={cn("mt-[7px] size-1.5 shrink-0 rounded-[1px]", mark[t.tone])} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-ink">{t.title}</p>
              {t.detail && <p className="mt-0.5 text-xs text-muted">{t.detail}</p>}
            </div>
            <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-xs text-faint hover:text-ink">
              <X className="size-3.5" strokeWidth={1.5} />
            </button>
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}

import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import type { ReactNode } from "react";
import { Crosshairs } from "@/components/blueprint/Frame";
import { duration, scaleIn } from "@/motion";
import { Button } from "./button";
import { HoldToConfirm } from "./hold-to-confirm";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  /** Require hold-to-confirm instead of a single click. Use for anything that touches Production. */
  hold?: boolean;
  tone?: "danger" | "ink";
}

/**
 * A blocking question. Radix Dialog supplies the hard parts (focus is trapped inside, Escape
 * closes, focus returns to what opened it); Motion supplies the spring entrance.
 *
 * `forceMount` + AnimatePresence: normally Radix removes the dialog from the page the instant it
 * closes, which would cut off the exit animation. Mounting it ourselves lets it animate out first.
 */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm, hold = false, tone = "danger" }: ConfirmDialogProps) {
  const confirm = () => {
    onConfirm();
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: duration.instant }} className="fixed inset-0 z-[60] bg-canvas/80" />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount>
              <motion.div
                variants={scaleIn}
                initial="hidden"
                animate="show"
                exit="exit"
                className="fixed left-1/2 top-[22vh] z-[60] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 rounded-xs border border-hairline bg-raised p-5 outline-none"
              >
                <Crosshairs />
                <Dialog.Title className="text-base font-medium tracking-tight text-ink">{title}</Dialog.Title>
                <Dialog.Description asChild>
                  <div className="mt-2 text-sm leading-relaxed text-muted">{description}</div>
                </Dialog.Description>
                <div className="mt-6 flex items-center justify-end gap-2">
                  <Dialog.Close asChild>
                    <Button variant="ghost">Cancel</Button>
                  </Dialog.Close>
                  {hold ? (
                    <HoldToConfirm tone={tone} onConfirm={confirm}>
                      {confirmLabel}
                    </HoldToConfirm>
                  ) : (
                    <Button variant={tone === "danger" ? "danger" : "solid"} onClick={confirm}>
                      {confirmLabel}
                    </Button>
                  )}
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

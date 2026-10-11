import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import { useState, type FormEvent } from "react";
import type { Project } from "@/api/types";
import { Crosshairs } from "@/components/blueprint/Frame";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { slugify } from "@/lib/slugify";
import { useCreateFlag } from "@/data/mutations";
import { duration, scaleIn } from "@/motion";

// The same rule the server applies. Checked here only to give an answer before the round trip.
const KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

export function NewFlagDialog({ project, open, onOpenChange }: { project: Project | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  const create = useCreateFlag(project);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState("");

  const shownKey = keyEdited ? key : slugify(name);
  const keyError = shownKey && (shownKey.length < 2 || !KEY_PATTERN.test(shownKey)) ? "Use lowercase letters, numbers, dots, underscores and hyphens (at least 2)." : null;
  const ready = name.trim().length > 0 && shownKey.length >= 2 && !keyError;

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setName("");
      setKey("");
      setKeyEdited(false);
      setDescription("");
      create.reset();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || create.isPending) return;
    create.mutate({ key: shownKey, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }, { onSuccess: () => close(false) });
  };

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: duration.instant }} className="fixed inset-0 z-[60] bg-canvas/80" />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <motion.form
                onSubmit={submit}
                variants={scaleIn}
                initial="hidden"
                animate="show"
                exit="exit"
                className="fixed left-1/2 top-[16vh] z-[60] w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 space-y-4 rounded-xs border border-hairline bg-raised p-5 outline-none"
              >
                <Crosshairs />
                <Dialog.Title className="text-base font-medium tracking-tight text-ink">New flag in {project?.name}</Dialog.Title>
                <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="One-tap checkout" autoFocus required />
                <Field
                  label="Key"
                  mono
                  value={shownKey}
                  onChange={(e) => {
                    setKeyEdited(true);
                    setKey(e.target.value.toLowerCase());
                  }}
                  maxLength={60}
                  placeholder="one-tap-checkout"
                  hint="What your code checks. It cannot be changed later."
                  error={keyError}
                  required
                />
                <Field label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
                {create.error && (
                  <p role="alert" className="text-sm text-danger">
                    {create.error.message}
                  </p>
                )}
                <div className="flex items-center justify-between gap-2 pt-1">
                  <p className="text-xs text-faint">Starts off in every environment.</p>
                  <div className="flex gap-2">
                    <Dialog.Close asChild>
                      <Button variant="ghost">Cancel</Button>
                    </Dialog.Close>
                    <Button type="submit" variant="solid" disabled={!ready || create.isPending}>
                      {create.isPending ? "Creating" : "Create flag"}
                    </Button>
                  </div>
                </div>
              </motion.form>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

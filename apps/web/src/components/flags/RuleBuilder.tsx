import type { Operator } from "@flagforge/core";
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from "lucide-react";
import { AnimatePresence, Reorder, useDragControls } from "motion/react";
import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ATTRIBUTE_HINTS, newRule, operatorKind, OPERATORS, validateRule } from "@/lib/targeting";
import type { TargetingRule } from "@/api/types";
import { duration, quiet } from "@/motion";

interface RuleBuilderProps {
  rules: TargetingRule[];
  onChange: (rules: TargetingRule[]) => void;
  disabled?: boolean;
}

const field = "h-8 min-w-0 rounded-xs border border-hairline bg-sunken px-2 text-sm text-ink placeholder:text-faint hover:border-line-strong disabled:opacity-40 aria-[invalid=true]:border-danger";

/**
 * Ordered list of targeting rules. Order matters: the first rule that matches a user decides, so
 * rows can be dragged (or moved with the arrow buttons, for keyboard users) to change priority.
 *
 * This is a form, so it sits in the "quiet zone": rows fade in and out and slide to their new
 * place with a plain 180ms ease. No spring, nothing bounces while someone is typing.
 *
 * `Reorder` is Motion's drag-to-sort list: it tracks the pointer, and the rows being passed slide
 * out of the way with layout animation (transforms), not by changing `top`.
 */
export function RuleBuilder({ rules, onChange, disabled }: RuleBuilderProps) {
  const update = (id: string, patch: Partial<TargetingRule>) => onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => onChange(rules.filter((r) => r.id !== id));
  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  return (
    <div>
      {rules.length === 0 ? (
        <p className="rounded-xs border border-dashed border-hairline px-4 py-6 text-center text-sm text-muted">
          No rules. Everyone is decided by the rollout percentage above.
        </p>
      ) : (
        <Reorder.Group as="ol" axis="y" values={rules} onReorder={onChange} aria-label="Targeting rules, in priority order" className="space-y-2">
          <AnimatePresence initial={false} mode="popLayout">
            {rules.map((rule, index) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                index={index}
                last={index === rules.length - 1}
                disabled={disabled}
                onUpdate={(patch) => update(rule.id, patch)}
                onRemove={() => remove(rule.id)}
                onMove={(by) => move(index, by)}
              />
            ))}
          </AnimatePresence>
        </Reorder.Group>
      )}

      <Button size="sm" className="mt-3" disabled={disabled || rules.length >= 20} onClick={() => onChange([...rules, newRule()])}>
        <Plus strokeWidth={1.5} /> Add rule
      </Button>
    </div>
  );
}

interface RuleRowProps {
  rule: TargetingRule;
  index: number;
  last: boolean;
  disabled?: boolean;
  onUpdate: (patch: Partial<TargetingRule>) => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
}

function RuleRow({ rule, index, last, disabled, onUpdate, onRemove, onMove }: RuleRowProps) {
  // Dragging starts only from the grip, so text can still be selected inside the inputs.
  const controls = useDragControls();
  const id = useId();
  const error = validateRule(rule);
  const kind = operatorKind(rule.operator);
  const position = index + 1;

  return (
    <Reorder.Item
      as="li"
      value={rule}
      dragListener={false}
      dragControls={controls}
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: duration.instant } }}
      whileDrag={{ opacity: 0.85 }}
      transition={quiet}
      className="relative rounded-xs border border-hairline bg-raised"
    >
      <div className="flex flex-wrap items-center gap-2 p-2">
        <button
          type="button"
          aria-label={`Drag rule ${position} to reorder`}
          disabled={disabled}
          onPointerDown={(event) => controls.start(event)}
          className="flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center text-faint hover:text-ink active:cursor-grabbing disabled:opacity-40"
        >
          <GripVertical className="size-4" strokeWidth={1.5} />
        </button>
        <span className="w-5 shrink-0 font-mono text-2xs text-faint">{String(position).padStart(2, "0")}</span>
        <span className="caption text-muted">if</span>

        <input
          aria-label={`Rule ${position} attribute`}
          aria-invalid={!rule.attribute.trim()}
          list={`${id}-attributes`}
          value={rule.attribute}
          disabled={disabled}
          placeholder="attribute"
          onChange={(event) => onUpdate({ attribute: event.target.value })}
          className={cn(field, "w-32 font-mono text-xs")}
        />
        <datalist id={`${id}-attributes`}>
          {ATTRIBUTE_HINTS.map((hint) => (
            <option key={hint} value={hint} />
          ))}
        </datalist>

        <select
          aria-label={`Rule ${position} operator`}
          value={rule.operator}
          disabled={disabled}
          onChange={(event) => onUpdate({ operator: event.target.value as Operator })}
          className={cn(field, "w-36 pr-1")}
        >
          {OPERATORS.map((operator) => (
            <option key={operator.value} value={operator.value}>
              {operator.label}
            </option>
          ))}
        </select>

        <input
          aria-label={`Rule ${position} value`}
          aria-invalid={!rule.value.trim()}
          value={rule.value}
          disabled={disabled}
          inputMode={kind === "number" ? "decimal" : "text"}
          placeholder={kind === "list" ? "a, b, c" : kind === "number" ? "number" : "value"}
          onChange={(event) => onUpdate({ value: event.target.value })}
          className={cn(field, "min-w-32 flex-1 font-mono text-xs")}
        />

        <span className="caption text-muted">serve</span>
        <span className="flex items-center gap-1">
          <input
            aria-label={`Rule ${position} percentage`}
            type="number"
            min={0}
            max={100}
            value={rule.rolloutPercentage}
            disabled={disabled}
            onChange={(event) => onUpdate({ rolloutPercentage: Number(event.target.value) })}
            className={cn(field, "w-14 text-right font-mono text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none")}
          />
          <span className="font-mono text-xs text-muted">%</span>
        </span>

        <span className="ml-auto flex items-center">
          <IconButton label={`Move rule ${position} up`} disabled={disabled || index === 0} onClick={() => onMove(-1)}>
            <ArrowUp />
          </IconButton>
          <IconButton label={`Move rule ${position} down`} disabled={disabled || last} onClick={() => onMove(1)}>
            <ArrowDown />
          </IconButton>
          <IconButton label={`Remove rule ${position}`} disabled={disabled} onClick={onRemove}>
            <X />
          </IconButton>
        </span>
      </div>
      {rule.more && rule.more.length > 0 && (
        // A rule made through the API can AND several conditions. This form edits the first; the
        // rest are shown so nothing is hidden, and are saved back unchanged.
        <p className="border-t border-hairline px-3 py-1.5 font-mono text-2xs text-muted">
          and also: {rule.more.map((c) => `${c.attribute} ${c.operator} ${Array.isArray(c.value) ? c.value.join(", ") : String(c.value)}`).join("; ")} <span className="text-faint">(set through the API, kept as is)</span>
        </p>
      )}
      {error && (
        // Not role="alert": that would interrupt a screen reader on every keystroke of a new rule.
        <p id={`${id}-error`} className="border-t border-hairline px-3 py-1.5 font-mono text-2xs text-danger">
          {error}
        </p>
      )}
    </Reorder.Item>
  );
}

function IconButton({ label, children, ...props }: { label: string; children: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} className="flex size-7 items-center justify-center rounded-xs text-faint hover:bg-canvas hover:text-ink disabled:opacity-30 [&_svg]:size-3.5 [&_svg]:stroke-[1.5]" {...props}>
      {children}
    </button>
  );
}

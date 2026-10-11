import { useState, type ReactNode } from "react";
import { Frame } from "@/components/blueprint/Frame";
import { FigCaption, LiveDot } from "@/components/blueprint/marks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FlagToggle } from "@/components/flags/FlagToggle";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { Ticker } from "@/components/ui/ticker";
import { toast } from "@/stores/toasts";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { formatStamp } from "@/lib/format";
import { stateOf, type Flag } from "@/api/types";
import { SAMPLE_FLAGS } from "./kit-samples";
import { fadeUp, Reveal, RevealGroup, RevealItem, scaleIn, slideInRight } from "@/motion";

const SWATCHES = [
  { name: "canvas", hex: "#0C0C0B", className: "bg-canvas", use: "Page background" },
  { name: "raised", hex: "#141412", className: "bg-raised", use: "Panels, inputs" },
  { name: "hairline", hex: "#26241F", className: "bg-hairline", use: "Borders, dividers" },
  { name: "ink", hex: "#E8E4DC", className: "bg-ink", use: "Primary text" },
  { name: "muted", hex: "#8A867D", className: "bg-muted", use: "Secondary text" },
  { name: "ember", hex: "#FF5A1F", className: "bg-ember", use: "Live / on / active only" },
  { name: "danger", hex: "#E5484D", className: "bg-danger", use: "Destructive, errors" },
] as const;

const columns: readonly Column<Flag>[] = [
  { header: "Key", cell: (f) => <span className="font-mono text-xs text-ink">{f.key}</span> },
  { header: "Name", cell: (f) => <span className="text-muted">{f.name}</span> },
  {
    header: "Prod",
    cell: (f) => (
      <span className="flex items-center gap-2 font-mono text-xs">
        <LiveDot on={stateOf(f, "prod").enabled} />
        {stateOf(f, "prod").enabled ? `${stateOf(f, "prod").rolloutPercentage}%` : "off"}
      </span>
    ),
  },
  { header: "Updated", align: "right", cell: (f) => <span className="font-mono text-2xs text-faint">{formatStamp(f.updatedAt)}</span> },
];

/** Every token and primitive on one page, so the design can be reviewed in one place. */
export function KitPage() {
  const [tab, setTab] = useState("tokens");
  const [on, setOn] = useState(true);
  const [checked, setChecked] = useState<boolean | "indeterminate">("indeterminate");
  const [replay, setReplay] = useState(0);
  const [flagOn, setFlagOn] = useState(false);
  const [held, setHeld] = useState(0);
  const [count, setCount] = useState(6);

  return (
    <div className="space-y-8">
      <header>
        <FigCaption index="9.0" label="UI kit" />
        <h1 className="mt-4 max-w-2xl text-3xl font-medium leading-[1.15] tracking-tight text-ink">
          The parts the dashboard is <span className="accent text-[1.1em]">drawn</span> from.{" "}
          <span className="text-muted">Tokens, primitives and motion, shown with the same mock data.</span>
        </h1>
      </header>

      <Tabs
        items={[
          { value: "tokens", label: "Tokens" },
          { value: "controls", label: "Controls" },
          { value: "data", label: "Data" },
          { value: "motion", label: "Motion" },
        ]}
        value={tab}
        onValueChange={setTab}
        label="UI kit sections"
      >
        <TabsContent value="tokens" className="mt-8 space-y-10 outline-none">
          <Block fig="9.1" label="Colour">
            <ul className="grid gap-px overflow-hidden rounded-xs border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
              {SWATCHES.map((swatch) => (
                <li key={swatch.name} className="flex items-center gap-3 bg-canvas p-3">
                  <span className={`size-9 shrink-0 rounded-xs border border-line-strong ${swatch.className}`} />
                  <span className="min-w-0">
                    <span className="block font-mono text-xs text-ink">{swatch.name}</span>
                    <span className="block font-mono text-2xs text-faint">{swatch.hex}</span>
                    <span className="block truncate text-xs text-muted">{swatch.use}</span>
                  </span>
                </li>
              ))}
              {/* completes the last row, so the grid's divider colour never shows as an empty block */}
              <li aria-hidden className="hidden bg-canvas sm:block" />
            </ul>
          </Block>

          <Block fig="9.2" label="Type">
            <Frame className="divide-y divide-hairline">
              <Specimen name="Geist Sans / UI">
                <p className="text-2xl font-medium tracking-tight text-ink">Roll out to a quarter of production</p>
              </Specimen>
              <Specimen name="Geist Mono / keys, numbers, captions">
                <p className="font-mono text-base text-ink">route-optimizer-v2 &nbsp; 25% &nbsp; 0123456789</p>
              </Specimen>
              <Specimen name="Instrument Serif italic / one accent word per headline">
                <p className="text-2xl font-medium tracking-tight text-ink">
                  Turn it <span className="accent text-[1.15em]">off</span> in one click
                </p>
              </Specimen>
            </Frame>
          </Block>

          <Block fig="9.3" label="Shape">
            <div className="grid gap-8 sm:grid-cols-3">
              {(["rounded-xs", "rounded-sm", "rounded-md"] as const).map((radius, i) => (
                <div key={radius} className={`flex h-20 items-end border border-hairline bg-raised p-3 ${radius}`}>
                  <span className="font-mono text-2xs text-muted">
                    {radius} / {[2, 3, 4][i]}px
                  </span>
                </div>
              ))}
            </div>
            <Frame className="mt-8 p-5">
              <FigCaption index="9.3a" label="Frame with crosshair corners" />
              <p className="mt-2 max-w-prose text-sm text-muted">Hairline border, no shadow. The crosses mark the corners the way registration marks do on a drawing.</p>
            </Frame>
          </Block>
        </TabsContent>

        <TabsContent value="controls" className="mt-8 space-y-10 outline-none">
          <Block fig="9.4" label="Buttons">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="solid">Create flag</Button>
              <Button>Edit rules</Button>
              <Button variant="ghost">Cancel</Button>
              <Button variant="danger">Delete flag</Button>
              <Button size="sm">Small</Button>
              <Button disabled>Disabled</Button>
            </div>
          </Block>

          <Block fig="9.5" label="Switch and checkbox">
            <div className="flex flex-wrap items-center gap-8">
              <label className="flex items-center gap-3 text-sm text-ink">
                <Switch checked={on} onCheckedChange={setOn} />
                <span className="font-mono text-xs">{on ? "on" : "off"}</span>
              </label>
              <label className="flex items-center gap-3 text-sm text-muted">
                <Switch disabled /> disabled
              </label>
              <label className="flex items-center gap-3 text-sm text-ink">
                <Checkbox checked={checked} onCheckedChange={setChecked} />
                <span className="font-mono text-xs">{String(checked)}</span>
              </label>
            </div>
          </Block>

          <Block fig="9.5a" label="Flag toggle, hold to confirm, ticker, toast">
            <div className="flex flex-wrap items-center gap-8">
              <FlagToggle checked={flagOn} onCheckedChange={setFlagOn} label="Example flag" showStatus />
              <HoldToConfirm key={held} onConfirm={() => { toast("Held for 0.7 seconds", { tone: "danger" }); setTimeout(() => setHeld((n) => n + 1), 600); }}>
                Hold to confirm
              </HoldToConfirm>
              <span className="flex items-center gap-3">
                <Button size="sm" onClick={() => setCount((n) => (n >= 90 ? 6 : n + 17))}>
                  Change number
                </Button>
                <Ticker value={count} className="text-2xl text-ink" />
              </span>
              <Button size="sm" onClick={() => toast("A toast", { detail: "Slides in from the right, leaves by itself.", tone: "live" })}>
                Show toast
              </Button>
            </div>
          </Block>

          <Block fig="9.6" label="Keys">
            <p className="flex items-center gap-2 text-sm text-muted">
              Open the palette with <Kbd>Ctrl</Kbd>
              <Kbd>K</Kbd>
            </p>
          </Block>
        </TabsContent>

        <TabsContent value="data" className="mt-8 space-y-10 outline-none">
          <Block fig="9.7" label="Data table with selection">
            <Frame>
              <DataTable rows={SAMPLE_FLAGS} columns={columns} label="Sample flags" rowLabel={(f) => `flag ${f.key}`} />
            </Frame>
          </Block>

          <Block fig="9.8" label="Skeleton">
            <SkeletonGroup className="max-w-md space-y-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </SkeletonGroup>
          </Block>

          <Block fig="9.9" label="Empty state">
            <EmptyState fig="9.9a" title="No flags in this project yet">
              Shown when a list has nothing in it. The parts arrive in sequence and the line keeps sweeping.
            </EmptyState>
          </Block>
        </TabsContent>

        <TabsContent value="motion" className="mt-8 space-y-10 outline-none">
          <Block fig="9.10" label="Variants">
            <Button size="sm" onClick={() => setReplay((n) => n + 1)}>
              Replay
            </Button>
            <div key={replay} className="mt-5 grid gap-5 sm:grid-cols-3">
              <Reveal variants={fadeUp}>
                <Sample name="fadeUp" note="Default entrance" />
              </Reveal>
              <Reveal variants={scaleIn}>
                <Sample name="scaleIn" note="Popovers, dialogs" />
              </Reveal>
              <Reveal variants={slideInRight}>
                <Sample name="slideInRight" note="Side panels" />
              </Reveal>
            </div>
            <RevealGroup key={`group-${replay}`} step={0.06} className="mt-5 grid gap-5 sm:grid-cols-4">
              {["01", "02", "03", "04"].map((n) => (
                <RevealItem key={n}>
                  <Sample name={`stagger ${n}`} note="Children in sequence" />
                </RevealItem>
              ))}
            </RevealGroup>
          </Block>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Block({ fig, label, children }: { fig: string; label: string; children: ReactNode }) {
  return (
    <section>
      <FigCaption index={fig} label={label} />
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Specimen({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="px-5 py-4">
      <p className="caption mb-2 text-faint">{name}</p>
      {children}
    </div>
  );
}

function Sample({ name, note }: { name: string; note: string }) {
  return (
    <div className="rounded-xs border border-hairline bg-raised p-4">
      <p className="font-mono text-xs text-ink">{name}</p>
      <p className="mt-1 text-xs text-muted">{note}</p>
    </div>
  );
}

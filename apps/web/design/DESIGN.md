# FlagForge design: "Control room blueprint"

Dark, technical, handmade. The interface should feel like an instrument panel drawn by an engineer:
hairlines instead of shadows, mono numerals, registration marks on the corners, one warm signal
colour that only ever means "this is live".

All tokens live in one file: `src/styles/index.css` (Tailwind v4 `@theme`). Nothing else defines a
colour, font or radius.

## Colour

| Token | Hex | Tailwind name | Use |
|---|---|---|---|
| bg | `#0C0C0B` | `canvas` | Page background |
| raised | `#141412` | `raised` | Panels, inputs, anything lifted one step |
| hairline | `#26241F` | `hairline` | Every border and divider |
| text | `#E8E4DC` | `ink` | Primary text |
| muted | `#8A867D` | `muted` | Secondary text, table headers |
| ember | `#FF5A1F` | `ember` | **Only** live / on / active |
| danger | `#E5484D` | `danger` | Destructive actions, errors |

Three derived steps exist and no more should be added without a reason:
`sunken #080807` (wells), `line-strong #3A372F` (hairline on hover), `faint #5C5952` (decorative marks).

The names `canvas` and `ink` are used instead of `bg` and `text` because Tailwind would otherwise
produce `bg-bg` and `text-text`.

**The default Tailwind palette is deleted** (`--color-*: initial`). `bg-blue-500` does not exist in
this project, so an off-token colour cannot be used by accident.

### The ember rule
Ember answers one question at a glance: *what is live right now?* It appears only on:
- a flag that is **on in the environment you are currently looking at** (dot, switch),
- the active item marker (sidebar tick, tab underline, environment marker).

A flag that is on in *another* environment's column is shown in `muted`, not ember. The first
version of the overview used ember for every "on" cell: eleven dots, and the eye had nowhere to
land. If a screen has more than a handful of ember marks, something is being called live that is not.

Never use ember for: decoration, links, primary buttons, illustrations, empty states.

Ember also marks a change that **arrived live** from somewhere else: the row flash. That is the
same idea (this is happening right now). Your own change flashes in ink, a Production kill in
danger, so ember keeps meaning "live" and nothing else.

In the rollout dot grid, lit squares are ember only when the flag is on in the environment being
viewed; otherwise they are `muted`. A square that differs from what is saved gets an outline: ink
for "would be added", danger for "would be removed".

On the landing page the same rule holds: ember is lit dots (users who have the flag), the pulse
that carries "on" (a pulse carrying "off" is ink), live connections, and nothing decorative.
Headlines there are heavy and tight (semibold, about -0.04em), with one serif italic word each.

### Production
Any change in Production needs a deliberate hold (700ms), never a single click. This applies in
one place in the code (`FlagGuard`), so the list, the detail page and the command palette cannot
disagree about it.

## Type

| Family | Package | Use |
|---|---|---|
| Geist Sans (variable) | `@fontsource-variable/geist` | All UI text |
| Geist Mono (variable) | `@fontsource-variable/geist-mono` | Keys, numbers, timestamps, captions |
| Instrument Serif italic | `@fontsource/instrument-serif` | One accent word per headline |

- Fonts are self-hosted through Fontsource (no request to a font CDN, works offline).
- `accent` utility = the serif italic word. **At most one per headline.** It marks the word that
  carries the meaning ("two *live* in production"), never a random one.
- `caption` utility = 11px mono, uppercase, tracked. Used for `FIG 0.1` labels and table headers.
- Mono always uses tabular figures and a slashed zero, so digits line up in columns.
- Headlines are two-tone: the fact in `ink`, the supporting detail continuing in `muted`.

## Shape

- Radius is 2px, 3px or 4px (`rounded-xs` / `-sm` / `-md`). Larger radii are removed from the theme.
- **No shadows** (`--shadow-*: initial`). Depth comes from a hairline, not from blur.
- `Frame` (`components/blueprint/Frame.tsx`): hairline box with crosshair marks on its corners.
  The marks sit outside the box, so a Frame must not be inside `overflow-hidden`.
- `FigCaption`: mono `FIG 0.1` label that numbers sections like figures in a manual.
- `Grain`: one static film-grain layer over the viewport (an inline SVG noise texture, about 4.5%
  opacity). It is never animated.
- `GridLines`: faint drafting grid. **Marketing surfaces only**, never inside the dashboard.
- `LiveDot`: the small square state mark (ember / muted / faint).

## Interaction states

- Hover and press are instant: no colour transition (see `MOTION.md`).
- Focus is one style everywhere: a 1px `ink` outline, 2px offset. Never a glow.
- Disabled is 40% opacity.
- Selection (checkboxes, selected rows) is `ink`, not ember: selecting something does not make it live.

## Banned

Purple or blue gradients, glassmorphism, gradient icon squares, three identical centred cards,
emoji, lorem ipsum, filler statistics, the default shadcn look, and marketing words such as
"supercharge", "unlock" or "seamless".

Every number shown in the UI is computed from data (from the API). Nothing is invented
to fill a card.

## Where things are

| Path | What |
|---|---|
| `src/styles/index.css` | Tokens and the custom utilities (`accent`, `caption`, `grain`, `grid-lines`) |
| `src/components/blueprint/` | Frame, crosshairs, FIG captions, grain, grid, live dot |
| `src/components/ui/` | Base primitives, restyled (see `THIRD_PARTY.md`) |
| `src/components/shell/` | Sidebar, top bar, command palette, layout |
| `src/landing/` | Landing page: hero dot field, boot sequence, cursor, and one file per section |
| `/kit` route | Every token and primitive on one page, for review |
| `design/references/` | Mood references (images are git-ignored) and `notes.txt` |

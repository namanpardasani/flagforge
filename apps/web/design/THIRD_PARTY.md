# Third-party source used in the UI

Source that was copied or adapted into this repo, as opposed to installed as a package.
Everything here is MIT licensed, which allows copying and modification as long as the licence
notice is kept. This file is that record.

## What shadcn/ui is (and is not)

shadcn/ui is not a library you install: it is a collection of component source files you copy into
your own project. Those files are thin, accessible wrappers around Radix primitives (which handle
keyboard, focus and ARIA) styled with Tailwind. Because the code then lives in this repo, it can be
restyled completely, which is what was done here. The base primitives in `src/components/ui/`
follow shadcn's structure but none of its default look.

Licence: MIT, Copyright (c) 2023 shadcn. https://github.com/shadcn-ui/ui

## Watermelon UI

https://ui.watermelon.sh, source at https://github.com/WatermelonCorp/watermelon-platform
Licence: MIT, "Copyright (c) 2026 Watermelon Platform Contributors" (verified in the repository's LICENSE file).

Each component was read before use. What was taken, and what was deliberately not:

| Watermelon component | Used in | What was taken | What was changed or left out |
|---|---|---|---|
| `data-table-1` | `ui/data-table.tsx` | Row-selection logic: a set of ids, select-all, the mixed "some selected" state | Made generic over the row type; fixed-width wrappers removed; restyled to tokens; sky-blue checked colour replaced with `ink` |
| `continuous-tabs` | `ui/tabs.tsx` | The sliding indicator: one element with a `layoutId` moved by a spring | It had no tab roles or keyboard support, so it is rebuilt on Radix Tabs. Its pill, gradients and shadows (all banned here) became a 1px underline. It also rendered nothing until mounted; that was dropped |
| `macos-sidebar` | `shell/Sidebar.tsx` | The hover highlight that slides between rows (`layoutId`), labels fading on collapse | It animated `width` and used a blur filter, both against our motion rules, and its toggle was a clickable icon rather than a button. Collapse is redone with a transform-based layout animation. `@hugeicons` replaced with `lucide-react` |
| `breadcrumb-1` | `ui/breadcrumbs.tsx` | The union type that makes a segment either a link or the current page | Rounded pill container removed; uses the router's `Link` |
| `command-search` | `shell/CommandPalette.tsx` | Only the quick fade-and-scale entrance | It handles arrow keys but has **no ARIA roles**, so the palette is built on Radix Dialog + `cmdk` instead |
| `switch-1`, `switch-3` | reviewed, not used | Nothing | They are usage demos of the shadcn switch with preset colours; our switch is written directly on Radix |

Not available in the Watermelon catalog, so written by hand: skeleton, empty state.

## Packages (installed, not copied)

`radix-ui` (accessible primitives), `cmdk` (command list), `motion` (animation), `lenis` (smooth
scroll, landing only), `lucide-react` (icons), `@tanstack/react-query`, `react-router`,
`class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, and the Fontsource packages
for Geist, Geist Mono and Instrument Serif. Their licences are in `node_modules`.

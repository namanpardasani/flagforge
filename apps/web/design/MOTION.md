# FlagForge motion

Motion here has one job: show what changed and where it went. It is never decoration.
Everything lives in `src/motion/`. Components do not invent their own timings.

## The four rules

1. **Animate only `transform` and `opacity`.**
   The browser can move and fade a layer on the GPU without recalculating layout or repainting.
   Animating `width`, `height`, `top`, `margin` or colours forces layout or paint work on every
   frame, which is what makes interfaces stutter.
2. **UI feedback stays under 200ms.** Hover, press, toggles, menus. Anything slower feels like lag.
3. **Big moments may take up to 800ms.** A screen arriving, an empty state appearing. Rare by design.
4. **Offscreen work is paused.** Looping animations stop when scrolled out of view or when the tab
   is hidden.

These are checked by tests (`src/motion/motion.test.tsx`): durations are bounded, every variant is
scanned for properties other than transform and opacity, and springs must be well damped.

## Tokens (`tokens.ts`)

| Duration | Value | Use |
|---|---|---|
| `instant` | 120ms | Press and hover feedback |
| `quick` | 180ms | Menus, tooltips, route changes |
| `base` | 320ms | Content entering |
| `grand` | 800ms | Large, rare moments |

| Spring | Feel | Use |
|---|---|---|
| `snappy` | Tight, no overshoot | Toggles, markers, hover highlight |
| `gentle` | Soft arrival | Content sliding in |
| `layout` | Firm, settles in about 350ms | Sidebar collapse, indicators sliding between items |

Springs are described by physics instead of time, so they stay natural when interrupted: click the
sidebar toggle twice quickly and it changes direction instead of restarting.

## Variants (`variants.ts`)

`fadeUp` (default entrance), `stagger()` (parent that reveals children in sequence), `scaleIn`
(popovers, dialogs), `slideInRight` (side panels), `page` (route changes).

Use them through the wrappers in `Reveal.tsx` instead of writing `initial`/`animate` by hand:

```tsx
<RevealGroup>              // staggers its children
  <RevealItem>...</RevealItem>
  <RevealItem variants={scaleIn}>...</RevealItem>
</RevealGroup>

<Reveal whenInView>...</Reveal>   // animates the first time it scrolls into view
```

## Reduced motion

Two layers, so nothing is missed:
- `MotionProvider` wraps the app in `<MotionConfig reducedMotion="user">`. When the operating
  system asks for less motion, Motion switches off transform and layout animation everywhere and
  keeps opacity.
- `Reveal` / `RevealItem` additionally swap their variant for a plain fade and drop the stagger
  delay, and a CSS rule shortens every CSS animation to effectively nothing.

Lenis (landing page only) turns its smoothing off by itself under reduced motion.

## How specific things are done

**Colour never animates.** Hover and press change instantly, which also suits the technical look.
Where a colour change must feel smooth it is done with opacity: the switch has an ember layer that
fades in over the track, rather than the track changing colour.

**Sidebar collapse without animating `width`.** The sidebar's width changes instantly in the layout.
Motion's `layout` prop measures the box before and after and plays the difference as a transform
(the FLIP technique: First, Last, Invert, Play). Three boxes take part: the sidebar, a 1px divider
and the content area.
- The content inside the sidebar is always 248px wide and is clipped, with labels fading out, so
  nothing is squashed. Icons keep the same x position in both states.
- The divider is its own element because a border on a box that is being scaled would stretch.
- `layoutDependency={collapsed}` makes Motion re-measure only when the sidebar toggles.

Measured in a real browser, frame by frame, during a collapse: sidebar 248px to 56px over about
370ms; label width, icon size and position, and page heading width all constant; divider 1px throughout.

**Sliding indicators** (tab underline, environment marker, sidebar hover highlight). The active
item renders one element with a `layoutId`. When another item becomes active, Motion animates that
same element from the old spot to the new one.

**Route transitions.** `AnimatePresence mode="wait"` around the routed page, keyed by pathname: the
old page fades out (120ms), then the new one fades up (180ms). Quick, because navigation is constant.

**Skeleton shimmer.** A band moved with `translateX` across the block, not an animated
`background-position` (which would repaint every frame).

**Pausing offscreen.** `useOffscreenPause` sets `data-paused` on an element when it leaves the
viewport or the tab is hidden; one CSS rule pauses every animation underneath. No re-render.

## The quiet zone (tables and forms)

Dense tables and forms are where people read and type, so nothing there may bounce. Inside the
flag list, the targeting form and the rule builder, use only the `quiet` transition
(`duration.quick`, ease-out) and hover states. Rows that move because of a filter, a sort or a
reorder slide with `quiet`, not with a spring. Springs are kept for small controls that respond to
a direct press: the switch thumb, a dialog or toast arriving.

## Flag screens

**Switch bloom.** When a flag turns on, a soft ember disc scales up from behind the thumb and fades
out (0.55s, transform and opacity). It plays only on a real off-to-on change, never on first
render, and never when turning off.

**Hold to confirm.** The ring fills over 700ms and rewinds if released early. It is one
MotionValue (0 to 1) driving two rotating half-rings behind clipping windows, so the fill is
rotation only: no stroke-dashoffset animation and no React re-render per frame. A click does
nothing; holding Space or Enter works the same as holding the pointer.

**Row flash.** An absolutely positioned layer over the row fades its opacity to zero. Ember, 1.2s,
for a change that arrived from elsewhere; ink, quick, for your own change; danger for a Production
kill. The 1.2s live-update flash is the one deliberate exception to the 800ms ceiling: it is
passive (it never delays an action) and it has to be noticed in peripheral vision. The mono
"updated just now" tag stays for 6 seconds.

**Number tickers.** Each digit is a column of 0 to 9 moved with `translateY`; only digits that
changed move. The real number is given to screen readers as plain text.

**Dot grid.** 100 squares, each with a lit layer and an outline layer that fade with opacity
(150ms CSS). Moving the slider re-renders the grid but hashes nothing: the sample is computed once
per flag.

**List.** Rows stagger in once on first load. After that, filter and sort move rows with
`layout="position"` and leaving rows fade out (`AnimatePresence mode="popLayout"`).

## Smooth scrolling

Lenis is used on the landing page only. It is imported in `pages/Landing.tsx`, which is
lazy-loaded, so the dashboard never downloads or runs it. A dashboard should scroll exactly the way
the operating system does.

## A note for whoever tests this

Headless-browser screenshots that use a virtual clock freeze on the landing page, because Lenis
keeps an animation-frame loop running. The content looks invisible (stuck at opacity 0) when it is
not. Capture in real time instead.

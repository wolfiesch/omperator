---
name: T4 Code
description: Desktop observability and control surface for OMP sessions — precise, capable, calm.
colors:
  background: "#ffffff"
  foreground: "oklch(0.269 0 0)"
  muted-foreground: "oklch(0.556 0 0)"
  secondary: "rgb(0 0 0 / 4%)"
  border: "rgb(0 0 0 / 8%)"
  input: "rgb(0 0 0 / 10%)"
  brand: "#e83174"
  primary: "oklch(0.52 0.185 5)"
  primary-foreground: "#ffffff"
  accent-text: "oklch(0.52 0.185 5)"
  destructive: "oklch(0.637 0.237 25.331)"
  destructive-foreground: "oklch(0.505 0.213 27.518)"
  info: "oklch(0.623 0.214 259.815)"
  info-foreground: "oklch(0.488 0.243 264.376)"
  success: "oklch(0.696 0.17 162.48)"
  success-foreground: "oklch(0.508 0.118 165.612)"
  warning: "oklch(0.769 0.188 70.08)"
  warning-foreground: "oklch(0.555 0.163 48.998)"
  status-working: "oklch(0.588 0.158 241.966)"
  status-approval: "oklch(0.666 0.179 58.318)"
  status-input: "oklch(0.511 0.262 276.966)"
  status-plan: "oklch(0.541 0.281 293.009)"
  status-done: "oklch(0.596 0.145 163.225)"
  status-error: "oklch(0.577 0.245 27.325)"
  mark-pin: "#0d0d0d"
typography:
  heading:
    fontFamily: "DM Sans Variable, -apple-system, Segoe UI, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1
  body:
    fontFamily: "DM Sans Variable, -apple-system, Segoe UI, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "DM Sans Variable, -apple-system, Segoe UI, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    letterSpacing: "0.025em"
  mono:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, SF Mono, SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  2xl: "16px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    height: "36px"
    padding: "0 11px"
  button-primary-hover:
    backgroundColor: "color-mix(in srgb, oklch(0.52 0.185 5) 90%, transparent)"
    textColor: "{colors.primary-foreground}"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "36px"
    padding: "0 11px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "36px"
    padding: "0 11px"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "#ffffff"
    rounded: "{rounded.lg}"
    height: "36px"
    padding: "0 11px"
  badge-default:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.sm}"
    height: "22px"
    padding: "0 3px"
  badge-success:
    backgroundColor: "color-mix(in srgb, oklch(0.696 0.17 162.48) 8%, transparent)"
    textColor: "{colors.success-foreground}"
    rounded: "{rounded.sm}"
    height: "22px"
    padding: "0 3px"
  tooltip:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
  dialog:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.2xl}"
---

# Design System: T4 Code

## 1. Overview

**Creative North Star: "The Quiet Control Room"**

T4 Code (powered by Oh My Pi) is the observability and control surface for a running agent runtime, and it looks like one: pure neutral light and dark surfaces, a strict two-tier Pi Pink identity, and semantic status hues that are never allowed to blur into brand. The interface carries the confidence of a mature developer tool — dense when the work demands it, quiet when it does not. Nothing decorates; every color, shadow, and motion token reports state. `packages/ui/src/tokens.css` is the only file allowed to contain raw color values; every component consumes tokens by CSS variable or Tailwind theme class. The product identity is the `BrandLockup`: the exact OMP pi/plugin mark beside the "T4 Code" wordmark, with the "Powered by Oh My Pi" byline reserved for onboarding, about, and the empty welcome.

The system explicitly rejects the generic AI dashboard: no oversized metric cards, no decorative agent graphs, no chat toys. It also deliberately overrides its own interaction reference (T3 Code): no turbulence/grain overlay, no warm cream or paper themes, no glass-card monoculture, no gradient text, no oversized rounding, no decorative side stripes. Surfaces are zero-chroma neutral; the Pi Pink accent appears only where identity or action genuinely lives.

Motion is vocabulary, not spectacle: 120 ms (`--motion-duration-fast`) hover/pressed/chevron feedback, 190 ms ease-out (`--motion-duration-base`, `cubic-bezier(0, 0, 0.2, 1)`) expand/collapse/popover, 240 ms (`--motion-duration-deliberate`) dialogs and large surfaces — the transition ceiling — and 500 ms (`--motion-duration-slow`) measured meters only, ping only on actively live status dots. Theme flips and panel drags suppress all transitions (`.no-transitions`); reduced motion zeroes every duration token and disables animation entirely.

**Key Characteristics:**

- Pure neutral surface ramps (zero chroma) in both themes; hue appears only with meaning.
- Two-tier Pi Pink: `#e83174` identity-only, `oklch(0.52 0.185 5)` contrast-safe action tier (~4.8:1 on white).
- Semantic status taxonomy (working/approval/input/plan/done/error) with brand pink banned from it.
- Hairline depth: 1px borders, top-edge bevel shadows, near-flat elevation.
- 4 px spacing grid, 0.625 rem base radius, 48 rem transcript measure, 6 px scrollbars.
- Deterministic bundled fonts: DM Sans Variable for UI, JetBrains Mono first in the mono stack.
- State-only motion with a full reduced-motion path.

## 2. Colors

A zero-chroma neutral chassis carrying one identity hue at two contrast tiers, plus a fixed semantic taxonomy that never borrows the accent.

### Primary

- **Pi Pink** (`--brand`, #e83174): identity only — the mark's plugin connector, selected indicators, non-text brand moments. Never body copy in light mode, never a wash, never a warning.
- **Raspberry Action Pink** (`--primary`, oklch(0.52 0.185 5)): the light-theme action tier, darkened until white foreground meets AA (~4.8:1 on white). Fills primary buttons and default badges; also `--ring` (focus) and `--accent-text` (accent body-copy tier). In dark theme `--primary` brightens to oklch(0.72 0.165 4) with near-black foreground oklch(0.145 0 0), and `--accent-text` lifts to oklch(0.78 0.13 4).

### Secondary

Semantic hues — fixed, distinct, and never brand pink:

- **Signal Red** (`--destructive`, oklch(0.637 0.237 25.331)): destructive fills; text tier `--destructive-foreground` oklch(0.505 0.213 27.518); solid fills always pair with `--destructive-solid-foreground` #ffffff.
- **Channel Blue** (`--info`, oklch(0.623 0.214 259.815)): informational tints; text tier oklch(0.488 0.243 264.376), also the markdown link color.
- **Steady Green** (`--success`, oklch(0.696 0.17 162.48)): success tints and diff-added backgrounds (at 12% alpha); text tier oklch(0.508 0.118 165.612).
- **Amber Caution** (`--warning`, oklch(0.769 0.188 70.08)): warning tints; text tier oklch(0.555 0.163 48.998). This is the warning hue — the brand pink never doubles as warning.

### Tertiary

Session status taxonomy (`--status-*`; each has a `-dot` fill and a text token; dark theme uses lighter alpha-blended variants):

- **Working Sky** (oklch(0.588 0.158 241.966) text / oklch(0.685 0.169 237.323) dot): working and connecting; the only pulsing dot.
- **Approval Amber** (oklch(0.666 0.179 58.318) / oklch(0.769 0.188 70.08)): pending approval.
- **Input Indigo** (oklch(0.511 0.262 276.966) / oklch(0.585 0.233 277.117)): awaiting input.
- **Plan Violet** (oklch(0.541 0.281 293.009) / oklch(0.606 0.25 292.717)): plan ready.
- **Done Emerald** (oklch(0.596 0.145 163.225) / oklch(0.696 0.17 162.48)): completed.
- **Error Crimson** (oklch(0.577 0.245 27.325) / oklch(0.637 0.237 25.331)): error.

### Neutral

All neutrals are zero-chroma; light-theme washes are black-alpha, dark-theme washes are white-alpha, so layers stay hue-free on any surface.

- **Paper White** (`--background`, #ffffff): app, card, and popover surface in light theme. Dark theme: color-mix(in srgb, oklch(0.145 0 0) 95%, #ffffff), with card/popover mixed 2% toward white.
- **Graphite Ink** (`--foreground`, oklch(0.269 0 0)): primary text in light theme; oklch(0.97 0 0) in dark.
- **Recede Gray** (`--muted-foreground`, oklch(0.556 0 0)): secondary text; oklch(0.708 0 0) in dark.
- **Four-Percent Wash** (`--secondary` / `--muted` / `--accent`, rgb(0 0 0 / 4%)): hover fills, muted panels, secondary buttons; rgb(255 255 255 / 4%) in dark.
- **Hairline** (`--border`, rgb(0 0 0 / 8%)): every border and divider; rgb(255 255 255 / 6%) in dark.
- **Field Line** (`--input`, rgb(0 0 0 / 10%)): input strokes and outline-button borders; rgb(255 255 255 / 8%) in dark.
- **Pin Black** (`--mark-pin`, #0d0d0d): the connector-pin ink inside the OMP mark, both themes.

The terminal owns a separate token family (`--terminal-*`): background/foreground bind to the app tokens, and a full 16-color ANSI palette per theme lives in tokens.css and reaches xterm through `XTERM_TOKEN_MAP` — the single palette rule; no second palette in terminal code.

### Named Rules

**The Two-Tier Pink Rule.** `#e83174` is identity; oklch(0.52 0.185 5) is action. Text or fills that must pass contrast never use raw `#e83174` in light mode.

**The Pink-Is-Never-Warning Rule.** Warning is `--warning` (amber). Status is the `--status-*` taxonomy. Pi Pink stays identity, always.

**The One Token File Rule.** Raw color values exist only in `packages/ui/src/tokens.css`. A raw color literal anywhere else is a defect.

## 3. Typography

**UI Font:** DM Sans Variable (with -apple-system, Segoe UI, system-ui, sans-serif) — bundled via `@fontsource-variable/dm-sans`.
**Heading Font:** DM Sans Variable (same stack; weight distinguishes headings, not family).
**Mono Font:** JetBrains Mono Variable, then JetBrains Mono (bundled via `@fontsource/jetbrains-mono`), SF Mono, SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace.

**Character:** A single geometric-humanist sans doing all the talking, with a workhorse mono for everything the runtime says. Bundled fonts guarantee deterministic metrics on Linux and macOS — visual tests depend on it.

### Hierarchy

- **Heading** (600, 1.25rem, leading-none): dialog, sheet, and empty-state titles via `font-heading font-semibold text-xl`.
- **Body** (400, 0.875rem at desktop widths, 1rem below the 640px breakpoint): default UI text; controls declare `text-base sm:text-sm` so touch-narrow windows read larger.
- **Control** (500, same responsive pair): buttons and badges are always `font-medium`.
- **Label** (500, 0.75rem, 0.025em tracking, uppercase where sectioning): status pills (sentence case) and gallery/section headers (`uppercase tracking-wide`).
- **Mono** (400, inherits size): terminal surfaces, code, paths. Partial code fences render plain monospace; highlighting waits until the fence settles.

### Named Rules

**The One Family Rule.** DM Sans carries every UI register through weight and size alone; the only second family is the mono, and it belongs to the runtime's output.

**The 48rem Measure Rule.** Transcript prose never exceeds `--transcript-measure` (48rem).

## 4. Elevation

Depth is hairline, not shadow theater. Surfaces sit flat on pure neutral backgrounds and separate through 1px `--border` strokes, 4% washes, and a signature top-edge bevel: raised surfaces paint `--surface-edge-shadow` (light: `0 1px rgb(0 0 0 / 4%)`; dark: `0 -1px rgb(255 255 255 / 6%)`) on an inset pseudo-element, and buttons carry a 1px inset `--bevel-highlight` (rgb(255 255 255 / 16%)) that flips to `--bevel-pressed` (rgb(0 0 0 / 8%)) when active. True drop shadows are reserved for the floating tier.

### Shadow Vocabulary

- **Surface edge** (`--surface-edge-shadow`: `0 1px rgb(0 0 0 / 4%)` light / `0 -1px rgb(255 255 255 / 6%)` dark): the hairline bevel on raised cards, outline buttons, popups.
- **Composer float** (`--composer-shadow`: `0 8px 24px rgb(0 0 0 / 8%)` light / 40% black dark): the composer, which also blurs its backdrop 12px over a 92% popover mix.
- **Overlay float** (`--overlay-shadow`: `0 16px 40px rgb(0 0 0 / 10%)` light / 50% black dark): dialogs and overlay panels; utility tiers `shadow-xs/5`–`shadow-lg/5` (5% alpha) cover buttons through popups.
- **Backdrop** (`--overlay-backdrop`: 60% background mix): modal backdrops at `bg-background/60` with `backdrop-blur-xs`.

### Named Rules

**The Hairline Bevel Rule.** Rest-state depth is a 1px edge, never a blur. If a resting card casts a visible drop shadow, it is wrong.

**The Floating-Tier Rule.** Real shadows belong only to things that float: composer, dialogs, sheets, tooltips, overlays.

## 5. Components

Primitives live in `packages/ui/src/primitives` on Base UI, styled entirely through tokens; the fixture gallery (`PrimitiveGallery`) renders every variant in both themes plus reduced-motion and narrow variants.

### Buttons

- **Shape:** softly rounded chassis (10px, `--radius-lg`), 1px border, 36px tall (32px at ≥640px), 11px horizontal padding, medium weight.
- **Primary:** `--primary` fill, white text, `shadow-primary/24 shadow-xs` plus the 1px `--bevel-highlight` inset; hover dims fill to 90%; active swaps the bevel to `--bevel-pressed` and drops the shadow.
- **Hover / Focus:** transitions are shadow-only; focus is a 2px `--ring` ring with 1px background offset. Disabled is 64% opacity, never a color swap.
- **Outline:** `--input` border on popover background with the surface-edge bevel; hover washes with `--accent`/50.
- **Ghost:** transparent border, `--accent` wash on hover; icons inside render `--muted-foreground`.
- **Secondary:** borderless `--secondary` wash. **Destructive:** `--destructive` fill with solid white text; **destructive-outline** tints toward destructive on hover.
- **Icon buttons:** the same chassis restricted to square sizes (24–44px), ghost by default, with a compile-time-required `aria-label`.

### Chips (Badges)

- **Style:** compact 22px (18px ≥640px) rounded-sm (6px) units, medium weight.
- **Solid:** primary or destructive fill with solid foreground. **Tint:** semantic 8% tints (16% in dark) with the matching `-foreground` text — `info`, `success`, `warning`, `error`. **Outline:** `--input` border on background.

### Status Pills

The signature indicator: a 6px colored dot plus a sentence-case label at `text-xs font-medium`, colored by exactly one `--status-*` pair. Working/connecting pulse via `animate-ping`; the pulse hides under reduced motion and the pill is never color-only — hidden labels persist as `aria-label`. Parent rows surface the highest-priority child status (error > approval > input > working > plan > done).

### Cards / Containers

- **Corner Style:** 10px (`--radius-lg`) for inline panels, 16px (`--radius-2xl`) for dialogs and inset sheets.
- **Background:** `--card`/`--popover` (white in light; +2% white mix in dark).
- **Shadow Strategy:** surface-edge bevel at rest; floating tier only for overlays (see Elevation).
- **Border:** always 1px `--border`.
- **Internal Padding:** 24px (`p-6`) for dialog/sheet regions; 12px (`p-3`) for dense panels; 4px grid throughout.

### Inputs / Fields

- **Style:** `--input` stroke (10% black / 8% white) on popover background — the outline-button treatment defines the field chassis.
- **Focus:** 2px `--ring` (accent action tier) ring, offset 1px from the fill; meets 3:1 non-text contrast in both themes.
- **Disabled:** 64% opacity, pointer events off.

### Navigation

Rail defaults to 256px (min 208px, collapsed 48px) beside a 52px topbar and 40px subheaders; the right pane docks above 980px (min 320px, target `min(42vw, 448px)`) and becomes a sheet below. Resize handles are keyboard-operable separators with the standard focus ring; widths persist per session on drag release. 6px scrollbars with 3px-radius thumbs (`--scrollbar-thumb`) and transparent tracks.

### Overlays (Dialog / Sheet / Tooltip)

Dialogs: 16px-radius popover cards over a blurred 60% backdrop, 200ms ease-in-out scale (98%→100%) and fade, bottom-stuck full-width below 640px; nested dialogs stack with scale/translate offsets. Sheets: side-anchored (right default, max-w-md), 200ms translate+fade, same bevel. Tooltips: 8px-radius popover chips at `text-xs`, scale-98 enter/exit, instant when moving between triggers.

### The OMP Mark (Signature)

The pi glyph draws in `currentColor` so it sits on any surface; the plugin connector stays `--brand` Pi Pink in both themes with `--mark-pin` (#0d0d0d) pins. Decorative dots at 80% opacity. Geometry is copied verbatim from oh-my-pi `assets/icon.svg`; do not redraw it.

## 6. Do's and Don'ts

### Do:

- **Do** keep every raw color in `packages/ui/src/tokens.css`; consume tokens by CSS variable or theme class everywhere else.
- **Do** use oklch(0.52 0.185 5) for accent actions and focus rings in light mode, reserving #e83174 for non-text identity.
- **Do** express state through the fixed status taxonomy and semantic hues — distinct, color-blind-safe, never brand pink.
- **Do** hold the 4px spacing grid, 0.625rem base radius, 1px borders, and hairline bevels.
- **Do** honor reduced motion completely: zero duration tokens, no ping, no smooth scrolling, no transitions during theme flips or drags.
- **Do** keep the right pane closed by default and earn attention with badges; only plan review may auto-open it.
- **Do** pair every status dot with a text label (visible or `aria-label`) and keep focus rings at 3:1 non-text contrast.

### Don't:

- **Don't** build generic AI workflow dashboards, oversized metric cards, decorative agent graphs, or chat toys.
- **Don't** import T3 Code's cloud, Clerk, relay, billing, or provider assumptions; T3 is an interaction and visual reference, not a product model.
- **Don't** use broad accent washes, pink or orange warning semantics, warm cream or paper themes, glass-card monoculture, gradient text, fake grain, turbulence, or sketch effects — the T3 turbulence/grain overlay is explicitly banned.
- **Don't** add permanent dashboard side panes, modal-first workflows, noisy auto-opening panels, or decorative continuous motion.
- **Don't** scrape terminals, let the renderer own runtime truth, create hidden duplicate settings stores, or send interactive input into an agent-owned shell.
- **Don't** use oversized rounding or decorative side stripes; 16px (`--radius-2xl`) is the ceiling, and a colored `border-left` stripe is a defect.
- **Don't** invent lane-specific status colors, a second terminal palette, or any raw color outside tokens.css.

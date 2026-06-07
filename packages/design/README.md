# @cinatra-ai/design

Cinatra design tokens, fonts, and brand assets — the tech-stack-independent foundation of the Cinatra design system.

## Capabilities

- ✓ CSS custom properties for the Cinatra palette (paper-cream / ink / mustard / indigo / red / burgundy / sea-green)
- ✓ Tailwind v4 `@theme inline` mapping (`bg-foreground`, `text-primary`, `border-line`, etc.)
- ✓ Cinatra-canonical utility classes (`.soft-panel`, `.divider-etched`, `.ink-button`, `.section-kicker`)
- ✓ Inter / Archivo / JetBrains Mono font binding (via Google Fonts CDN — self-hosted fonts are a consumer concern)
- ✓ Brand asset exports (logo SVG path data, favicon `icon.svg`, app icon `apple-icon.png`)
- ✓ TypeScript exports for embed bundles and third-party widgets

## Works with

- Next.js 16 + Tailwind v4
- Any CSS-aware bundler (Vite, Astro, Remix, etc.)
- Plain HTML + raw `<link>` tag

## Quick start

```css
/* In your app's globals.css */
@import "tailwindcss";
@import "@cinatra-ai/design/index.css";
```

That single import wires fonts + tokens + Tailwind v4 theme + canonical utilities in the correct order.

For finer control, import individual layers:

```css
@import "@cinatra-ai/design/fonts.css";      /* Inter / Archivo / JetBrains Mono */
@import "@cinatra-ai/design/tokens.css";     /* :root / .cinatra / .dark vars */
@import "@cinatra-ai/design/theme.css";      /* Tailwind v4 @theme inline */
@import "@cinatra-ai/design/utilities.css";  /* .soft-panel / .divider-etched / ... */
```

## TypeScript exports

```ts
import { CINATRA_THEME, CINATRA_STATUS, CINATRA_CHART_PALETTE } from "@cinatra-ai/design/brand/colors";
import { CINATRA_LOGO } from "@cinatra-ai/design/brand/logo";

// Use the indigo accent in an embed bundle's inline style:
const buttonStyle = { background: CINATRA_THEME.accent, color: CINATRA_THEME.accentForeground };

// Render the fedora logo as a raw SVG:
const logoSvg = `<svg viewBox="${CINATRA_LOGO.viewBox}"><path d="${CINATRA_LOGO.brim}" /><path d="${CINATRA_LOGO.crown}" /></svg>`;
```

## Brand assets

The package ships two static assets:

- `@cinatra-ai/design/brand/icon.svg` — 512×512 favicon SVG (white surface, mustard fedora, navy hairline border, rx=88)
- `@cinatra-ai/design/brand/apple-icon.png` — 180×180 app icon (mustard fedora on navy ground, larger corner radius)

The single source of truth for fedora path geometry is `CINATRA_LOGO` from `brand/logo.ts`. When updating the path, manually re-sync `icon.svg` (static SVG cannot import a TS module).

## Design-system rules

The full operational rulebook for Cinatra design lives in the public design-system reference at https://docs.cinatra.ai/references/design/ (resolutions, token map, conformance matrix, exception policy, uncovered-UI register). This package ships the tokens, fonts, and utilities those rules reference — it does not ship the rules themselves.

## Versioning

Tracks the `cinatra` repo's design-system release cadence. Breaking token name changes or palette shifts bump the minor version. Patch versions ship value-only adjustments and bug fixes.

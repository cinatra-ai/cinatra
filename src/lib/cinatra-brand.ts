// Single source of truth for the Cinatra logo SVG paths and brand theme colors.
// Update here -> changes propagate to CinatraLogo component, icon.svg, WordPress widget,
// and any future external integration (embeds, iframes, third-party widgets).
// When updating: also manually sync icon.svg (static SVG can't import TS modules).

// Brand colors matching CSS variables defined in src/app/globals.css (.cinatra theme).
// External integrations (WordPress widget, embeds, etc.) should import these instead of
// hardcoding color values so they stay in sync with Cinatra look & feel changes.
// Mustard wordmark color used by the BrandMark wordmark on light surfaces
// and by the embed bundle widget chrome. Matches --brand-mustard in
// .cinatra theme tokens (src/app/globals.css).
const WORDMARK_COLOR = "#c79545";

export const CINATRA_THEME = {
  background: "#f1f1ed",
  foreground: "#15213a",
  // `accent` is the canonical desaturated indigo. Matches `--accent` /
  // `--primary` in .cinatra tokens.
  accent: "#364e81",
  // ~10% darker than `accent` for hover state (hand-tuned; no CSS var
  // for hover state in .cinatra tokens, this lives only in embed bundles).
  accentHover: "#2d416c",
  accentForeground: "#ffffff",
  accentSoft: "#e6ede7",
  accentSoftHover: "#d8e7db",
  surface: "#f7f7f3",
  surfaceStrong: "#ffffff",
  surfaceMuted: "#e8e8e3",
  muted: "#5a6477",
  // `line` is the navy hairline at ~8% alpha. Matches --line in .cinatra
  // tokens (rgba 21,33,58,0.14 -> equivalent #15213a23). Full hex+alpha
  // is fine for embed-bundle CSS.
  line: "#15213a14",
  sidebar: "#eceeea",
  // Primary wordmark + brand chrome color (mustard). Used in the sidebar
  // header, embed widget headers, and the BrandMark wordmark.
  // The semantic name matches the current mustard wordmark.
  wordmarkColor: WORDMARK_COLOR,
  /**
   * @deprecated Use `wordmarkColor` for the mustard wordmark token.
   * Existing internal consumers (the WordPress + Drupal widget bundles
   * in `src/app/api/{wordpress,drupal}/bundle.js/route.ts`) keep working unchanged
   * through this alias while their visuals use the current mustard token.
   * Remove only after verifying no external embed references this name.
   */
  logoColor: WORDMARK_COLOR,
  // Brand typography — Archivo is the Cinatra heading/wordmark font.
  // No quotes around "Archivo" — single-word names don't need them in CSS,
  // and quotes here would break single-quoted JS strings in the widget IIFE.
  fontFamily: "Archivo, system-ui, sans-serif",
  // Includes italic 800 for the spec-conform wordmark (§I: Archivo italic 800).
  fontUrl: "https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,400;0,500;0,600;1,800&display=swap",
} as const;

export const CINATRA_LOGO = {
  // viewBox crop that frames the hat tightly for the React component
  viewBox: "60 50 392 208",
  // Full canvas dimensions used in icon.svg and the WordPress widget
  fullViewBox: "0 0 512 320",
  brim: "M72 214 C 72 200 96 190 130 188 C 168 186 196 200 256 210 C 316 220 358 214 400 200 C 426 192 440 196 440 208 C 440 222 420 234 388 242 C 340 254 288 256 256 256 C 202 256 132 248 100 238 C 80 232 72 224 72 214 Z",
  crown:
    "M146 188 C 150 130 176 86 212 72 C 226 66 240 64 252 64 C 262 64 270 70 268 80 L 264 100 C 272 88 288 82 300 82 C 332 82 356 118 362 188 Z",
} as const;

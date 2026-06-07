/**
 * Cinatra brand color tokens — for tech-stack-agnostic consumers.
 *
 * Mirrors the CSS custom properties defined in `tokens.css` (`.cinatra` block).
 * Use these constants for embed bundles, third-party widgets, and any
 * consumer that cannot read the CSS variables at runtime.
 *
 * CSS-aware consumers should prefer the Tailwind utilities or the raw vars:
 *   className="bg-surface text-foreground border-line"
 *   style={{ background: 'var(--brand-mustard)' }}
 */

export const WORDMARK_COLOR = "#c79545" as const;

export const CINATRA_THEME = {
  background: "#f1f1ed",
  foreground: "#15213a",
  /** Canonical desaturated indigo. Matches `--accent` / `--primary`. */
  accent: "#364e81",
  /** Hand-tuned ~10% darker than `accent` for hover. */
  accentHover: "#2d416c",
  accentForeground: "#ffffff",
  accentSoft: "#e6ede7",
  accentSoftHover: "#d8e7db",
  surface: "#f7f7f3",
  surfaceStrong: "#ffffff",
  surfaceMuted: "#e8e8e3",
  muted: "#5a6477",
  /** Navy hairline at ~8% alpha. Matches `--line`. */
  line: "#15213a14",
  lineStrong: "#15213a",
  sidebar: "#eceeea",
  /** Mustard wordmark color for sidebar header + embed bundles. */
  wordmarkColor: WORDMARK_COLOR,
  /** Burgundy logo color — exclusive to `.cinatra` themed mode. */
  logoColor: "#7a2e3a",
  /** Brand red. */
  red: "#a6384f",
  /** Brand typography — Archivo is the Cinatra heading/wordmark font. */
  fontFamily: "Archivo, system-ui, sans-serif",
} as const;

export const CINATRA_STATUS = {
  success: "#3f6e6b",
  successForeground: "#ffffff",
  warning: "#c79545",
  warningForeground: "#15213a",
  info: "#364e81",
  infoForeground: "#ffffff",
  destructive: "#a6384f",
  destructiveForeground: "#ffffff",
} as const;

export const CINATRA_CHART_PALETTE = [
  "#364e81", // chart-1 indigo
  "#3f6e6b", // chart-2 sea-green
  "#c79545", // chart-3 mustard
  "#7a2e3a", // chart-4 burgundy
  "#a6384f", // chart-5 red
] as const;

export type CinatraTheme = typeof CINATRA_THEME;
export type CinatraStatus = typeof CINATRA_STATUS;

/**
 * `@cinatra-ai/design` — Cinatra design tokens, brand colors, and logo data.
 *
 * The TypeScript layer of the design package. CSS files are loaded via
 * separate `*.css` entry points (`@cinatra-ai/design/tokens.css`, etc.).
 *
 * Two TypeScript exports:
 *   - `@cinatra-ai/design/brand/colors` — brand + status color constants
 *   - `@cinatra-ai/design/brand/logo`   — Cinatra logo SVG path data
 *
 * The default export (`@cinatra-ai/design`) re-exports both for convenience.
 */

export * from "./brand/colors.js";
export * from "./brand/logo.js";

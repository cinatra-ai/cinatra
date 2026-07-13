// Single source of truth for the Cinatra logo SVG paths.
// Update here -> changes propagate to CinatraLogo component, BrandMark, and
// icon.svg. When updating: also manually sync icon.svg (static SVG can't
// import TS modules).
//
// Brand THEME tokens for tech-stack-agnostic consumers (embed bundles,
// third-party widgets) live in @cinatra-ai/design (packages/design/src/brand/
// colors.ts). The legacy in-host CINATRA_THEME copy was removed with its only
// consumers — the dead pre-Option-A /api/{wordpress,drupal}/bundle.js widget
// routes (cinatra#411 disposition, executed by cinatra#977); the shipped
// widget source is vendored in the plugin/module repos and carries its own
// styles (docs/internals/contracts/widget-source-of-truth.md).

export const CINATRA_LOGO = {
  // viewBox crop that frames the hat tightly for the React component
  viewBox: "60 50 392 208",
  // Full canvas dimensions used in icon.svg
  fullViewBox: "0 0 512 320",
  brim: "M72 214 C 72 200 96 190 130 188 C 168 186 196 200 256 210 C 316 220 358 214 400 200 C 426 192 440 196 440 208 C 440 222 420 234 388 242 C 340 254 288 256 256 256 C 202 256 132 248 100 238 C 80 232 72 224 72 214 Z",
  crown:
    "M146 188 C 150 130 176 86 212 72 C 226 66 240 64 252 64 C 262 64 270 70 268 80 L 264 100 C 272 88 288 82 300 82 C 332 82 356 118 362 188 Z",
} as const;

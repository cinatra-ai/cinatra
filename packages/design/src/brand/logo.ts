/**
 * Cinatra logo — SVG path data.
 *
 * Single source of truth for the Cinatra fedora logo. Used by both pure-CSS
 * consumers (embed bundles, third-party widgets) and the React `<CinatraLogo>`
 * primitive in `@cinatra-ai/sdk-ui`.
 *
 * When updating: also manually sync `brand/icon.svg` (static SVG cannot
 * import TS modules).
 */

export const CINATRA_LOGO = {
  viewBox: "0 0 512 320",
  /** Fedora brim. */
  brim: "M72 214 C 72 200 96 190 130 188 C 168 186 196 200 256 210 C 316 220 358 214 400 200 C 426 192 440 196 440 208 C 440 222 420 234 388 242 C 340 254 288 256 256 256 C 202 256 132 248 100 238 C 80 232 72 224 72 214 Z",
  /** Fedora crown + pinch. */
  crown: "M146 188 C 150 130 176 86 212 72 C 226 66 240 64 252 64 C 262 64 270 70 268 80 L 264 100 C 272 88 288 82 300 82 C 332 82 356 118 362 188 Z",
} as const;

export type CinatraLogoData = typeof CINATRA_LOGO;

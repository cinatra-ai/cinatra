"use client";

import * as React from "react";
import { CINATRA_LOGO } from "@/lib/cinatra-brand";
import { cn } from "@/lib/utils";

/**
 * BrandMark — fedora + italic "Cinatra" wordmark as a SINGLE composed <svg>.
 *
 * Spec §I (design-system.html) Logo rules:
 *   1. "Same height as the wordmark" — the fedora svg renders at height =
 *      wordmark font-size, width = 1.6× that (full 0 0 512 320 canvas, exactly
 *      as the §I swatches: width=45 height=28 at font-size 28).
 *   2. Same colour, always — fedora + wordmark share one colour (currentColor).
 *   4. Sparkles animate inside the logo AND the wordmark in the product UI.
 *   6. No drop-shadow on the wordmark.
 *
 * Single composed SVG (one coordinate system) so the fedora/wordmark height
 * relationship is exact and ALL sparkles share one radius. The reference
 * geometry uses 2 fedora sparkles (clipPath-gated) + 7 wordmark sparkles
 * (mask-gated), reprojected into the unified viewBox. `@keyframes bm-spark` +
 * prefers-reduced-motion override live once in globals.css.
 *
 * `size` (default 28) = the wordmark font-size in CSS px (also the fedora
 * render height per rule 1). `variant`: "animated" | "static". `tone`
 * selects colour via the Tailwind className → currentColor.
 */

export type BrandMarkProps = {
  variant?: "animated" | "static";
  tone?: "mustard" | "ink" | "paper" | "black";
  size?: number;
  className?: string;
  ariaLabel?: string;
};

const TONE_CLASS = {
  mustard: "text-brand-mustard",
  ink: "text-foreground",
  paper: "text-background",
  black: "text-black",
} as const satisfies Record<NonNullable<BrandMarkProps["tone"]>, string>;

// Full brand canvas (CINATRA_LOGO.fullViewBox "0 0 512 320"). The §I swatches
// use this exact canvas so the rendered fedora is identical to the spec.
const FEDORA_CANVAS = { w: 512, h: 320 } as const;

// Artist-reference coordinate facts (viewBox 0 0 280 80, wordmark fontSize 56).
const REFERENCE = {
  wordmarkX: 60,
  fontSize: 56,
  letterSpacing: -1.3,
  sparkleRadius: 2.5,
} as const;

const GAP_PX = 10;
// Measured Archivo italic-800 "Cinatra" advance ÷ font-size (getEndPositionOfChar
// of the final glyph minus the text x, over font-size). Used both to size the
// wordmark region AND to anchor the per-letter sparkles, so they stay aligned.
const WORDMARK_WIDTH_PER_EM = 3.52;

// Fedora sparkle positions in the full-canvas (0..512 / 0..320) source coords.
const FEDORA_SPARKLES = [
  { cx: 220, cy: 160, delay: "0s" },
  { cx: 340, cy: 215, delay: "2s" },
] as const;

// One sparkle per glyph of "Cinatra" — including the trailing "tra", which the
// reference's hand-tuned absolute positions missed once rendered in Archivo.
// `fx` = each letter's measured centre as a fraction of the rendered wordmark
// width (getStartPositionOfChar/getEndPositionOfChar midpoint ÷ width); `fy` =
// fraction of the SVG height (upper-middle band where every glyph has a stroke,
// so the glyph mask never clips the spark out). Font-intrinsic ratios, so they
// hold at any `size`.
const WORDMARK_SPARKLES = [
  { fx: 0.103, fy: 0.37, delay: "0.2s" }, // C
  { fx: 0.244, fy: 0.45, delay: "0.8s" }, // i
  { fx: 0.368, fy: 0.37, delay: "1.4s" }, // n
  { fx: 0.539, fy: 0.45, delay: "2.0s" }, // a
  { fx: 0.674, fy: 0.37, delay: "2.6s" }, // t
  { fx: 0.778, fy: 0.42, delay: "3.2s" }, // r
  { fx: 0.916, fy: 0.45, delay: "3.6s" }, // a
] as const;

export function BrandMark({
  variant = "animated",
  tone = "mustard",
  size = 28,
  className,
  ariaLabel = "Cinatra",
}: BrandMarkProps) {
  const reactId = React.useId();
  const safeId = reactId.replace(/:/g, "_");
  const sparkleGradId = `bm-grad-${safeId}`;
  const fedoraClipId = `bm-fclip-${safeId}`;
  const wordmarkMaskId = `bm-wmask-${safeId}`;

  // One SVG unit == one CSS px (width/height match viewBox).
  // Spec §I rule 1: fedora height = wordmark font-size (size); width = 1.6×.
  const fedoraScale = size / FEDORA_CANVAS.h; // 320 → size
  const fedoraWidth = FEDORA_CANVAS.w * fedoraScale; // = 1.6 × size
  const fedoraTransform = `scale(${fedoraScale})`;

  // Wordmark: font-size = size; baseline placed so its em box centres against
  // the fedora box (flex align-items:center equivalent).
  const wordmarkFontSize = size;
  const wordmarkScale = wordmarkFontSize / REFERENCE.fontSize;
  const wordmarkX = fedoraWidth + GAP_PX;
  const wordmarkBaselineY = size * 0.8;
  const wordmarkLetterSpacing = REFERENCE.letterSpacing * wordmarkScale;
  const wordmarkWidth = size * WORDMARK_WIDTH_PER_EM;

  const totalWidth = fedoraWidth + GAP_PX + wordmarkWidth;
  const totalHeight = size;

  // Identical radius for fedora + wordmark sparkles. Use the wordmark's
  // reference radius so both match the wordmark sparks.
  const sparkleRadius = REFERENCE.sparkleRadius * wordmarkScale;

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      width={totalWidth}
      height={totalHeight}
      viewBox={`0 0 ${totalWidth} ${totalHeight}`}
      fill="currentColor"
      className={cn("inline-block align-middle", TONE_CLASS[tone], className)}
      style={{ overflow: "visible" }}
    >
      <defs>
        <radialGradient id={sparkleGradId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={1} />
          <stop offset="42%" stopColor="#fffce0" stopOpacity={0.85} />
          <stop offset="100%" stopColor="#fff5d8" stopOpacity={0} />
        </radialGradient>

        <clipPath id={fedoraClipId} clipPathUnits="userSpaceOnUse">
          <path d={CINATRA_LOGO.brim} transform={fedoraTransform} />
          <path d={CINATRA_LOGO.crown} transform={fedoraTransform} />
        </clipPath>

        <mask
          id={wordmarkMaskId}
          maskUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={totalWidth}
          height={totalHeight}
          style={{ maskType: "luminance" }}
        >
          <rect x={0} y={0} width={totalWidth} height={totalHeight} fill="black" />
          <text
            x={wordmarkX}
            y={wordmarkBaselineY}
            fill="white"
            fontFamily="var(--font-display), Archivo, sans-serif"
            fontStyle="italic"
            fontWeight={800}
            fontSize={wordmarkFontSize}
            letterSpacing={wordmarkLetterSpacing}
          >
            Cinatra
          </text>
        </mask>
      </defs>

      <g transform={fedoraTransform}>
        <path d={CINATRA_LOGO.brim} />
        <path d={CINATRA_LOGO.crown} />
      </g>

      <text
        x={wordmarkX}
        y={wordmarkBaselineY}
        fill="currentColor"
        fontFamily="var(--font-display), Archivo, sans-serif"
        fontStyle="italic"
        fontWeight={800}
        fontSize={wordmarkFontSize}
        letterSpacing={wordmarkLetterSpacing}
      >
        Cinatra
      </text>

      {variant === "animated" && (
        <>
          <g clipPath={`url(#${fedoraClipId})`}>
            {FEDORA_SPARKLES.map((sparkle) => (
              <circle
                key={`${sparkle.cx}-${sparkle.cy}`}
                cx={sparkle.cx * fedoraScale}
                cy={sparkle.cy * fedoraScale}
                r={sparkleRadius}
                fill={`url(#${sparkleGradId})`}
                className="bm-spark"
                style={{ animationDelay: sparkle.delay }}
              />
            ))}
          </g>

          <g mask={`url(#${wordmarkMaskId})`}>
            {WORDMARK_SPARKLES.map((sparkle) => (
              <circle
                key={`${sparkle.fx}-${sparkle.fy}`}
                cx={wordmarkX + sparkle.fx * wordmarkWidth}
                cy={sparkle.fy * totalHeight}
                r={sparkleRadius}
                fill={`url(#${sparkleGradId})`}
                className="bm-spark"
                style={{ animationDelay: sparkle.delay }}
              />
            ))}
          </g>
        </>
      )}
    </svg>
  );
}

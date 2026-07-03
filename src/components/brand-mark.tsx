"use client";

import * as React from "react";
import { CINATRA_LOGO } from "@/lib/cinatra-brand";
import { cn } from "@/lib/utils";

/**
 * BrandMark — the official horizontal lockup (fedora + italic "Cinatra"
 * wordmark) as a SINGLE <svg>, using the published lockup geometry verbatim
 * (design reference §I, docs.cinatra.ai/references/design/design-system.html).
 *
 * The lockup construction (baked into LOCKUP below, not re-derived here):
 *   - C = wordmark cap-height = 100 viewBox units. Everything is keyed to it.
 *   - Fedora ink (368×192 artwork crop) scaled to exactly 1C tall, bottom on
 *     the wordmark baseline (y = 105.54).
 *   - Fedora → wordmark gap = 0.4C.
 *   - Wordmark = "Cinatra" in Archivo ExtraBold Italic (-0.022em tracking)
 *     converted to OUTLINED PATHS — no font dependency, so the type treatment
 *     cannot drift from the brand lockup at render time.
 *   - One colour via currentColor (`tone` → Tailwind text class). §I rule 2:
 *     fedora + wordmark always share one colour.
 *
 * Sparkles (§I rule 4: they animate inside the logo AND the wordmark in the
 * product UI) overlay the lockup, clipped to the fedora / wordmark ink.
 * `@keyframes bm-spark` + prefers-reduced-motion override live in globals.css.
 *
 * `size` (default 28) keeps its historical meaning — the wordmark font-size
 * equivalent in CSS px. The rendered cap-height is ARCHIVO_CAP × size (the
 * cap-height Archivo yields at that font size), so existing call sites keep
 * their wordmark at the same visual size; the fedora proportion and the 0.4C
 * gap snap to the official lockup.
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

// Archivo cap-height per em (OS/2 sCapHeight 686 / unitsPerEm 1000) — maps the
// `size` prop (a font-size in px) to the lockup's C unit.
const ARCHIVO_CAP = 0.686;

// Official horizontal-lockup geometry (viewBox units; C = cap-height = 100).
// Copied verbatim from the published lockup master — do not tweak by hand;
// re-copy from the design reference if the lockup ever changes.
const LOCKUP = {
  viewBox: "0 0 743.33 107.29",
  width: 743.33,
  height: 107.29,
  // Places the fedora source artwork (512×320 canvas, ink at 72..440 × 64..256)
  // at 1C tall with its bottom on the wordmark baseline (y = 105.54).
  fedoraTransform: "translate(0 105.54) scale(0.52) translate(-72 -256)",
  // Fedora ink — the same canonical paths every brand surface shares.
  fedoraBrim: CINATRA_LOGO.brim,
  fedoraCrown: CINATRA_LOGO.crown,
  // Outlined "Cinatra" wordmark (Archivo ExtraBold Italic → paths).
  wordmark: "M275.84 107.29L275.84 107.29Q254.26 107.29 242.96 97.67Q231.67 88.05 231.67 68.22L231.67 68.22Q231.67 64.58 232.03 60.86Q232.40 57.14 232.98 53.35L232.98 53.35Q235.89 37.46 243.33 26.31Q250.76 15.16 262.57 9.40Q274.38 3.64 290.12 3.64L290.12 3.64Q302.95 3.64 312.50 7.29Q322.05 10.93 327.29 18.08Q332.54 25.22 332.54 35.86L332.54 35.86Q332.54 37.90 332.32 40.16Q332.10 42.42 331.81 44.61L331.81 44.61L306.16 44.61Q306.45 43.29 306.52 42.06Q306.59 40.82 306.59 39.80L306.59 39.80Q306.59 34.69 304.55 31.20Q302.51 27.70 298.65 25.87Q294.79 24.05 289.25 24.05L289.25 24.05Q282.98 24.05 278.17 26.02Q273.36 27.99 269.86 31.56Q266.36 35.13 264.03 40.23Q261.70 45.34 260.53 51.46L260.53 51.46Q259.80 55.25 259.36 57.73Q258.93 60.20 258.71 61.95Q258.49 63.70 258.42 65.01Q258.34 66.33 258.34 67.49L258.34 67.49Q258.34 73.62 260.38 77.99Q262.42 82.36 266.65 84.62Q270.88 86.88 277.29 86.88L277.29 86.88Q284.44 86.88 289.76 84.48Q295.08 82.07 298.58 77.55Q302.07 73.03 303.24 66.62L303.24 66.62L327.88 66.62Q325.69 80.17 318.77 89.21Q311.84 98.25 300.98 102.77Q290.12 107.29 275.84 107.29ZM372.19 18.37L348.28 18.37L351.49 0L375.40 0L372.19 18.37ZM357.03 105.54L333.12 105.54L346.68 28.72L370.59 28.72L357.03 105.54ZM395.81 105.54L371.90 105.54L385.46 28.72L404.99 28.72L404.99 39.80L406.01 39.80Q409.22 35.71 413.45 32.87Q417.67 30.03 422.56 28.50Q427.44 26.97 432.40 26.97L432.40 26.97Q439.68 26.97 444.79 29.23Q449.89 31.49 452.66 35.93Q455.43 40.38 455.43 47.23L455.43 47.23Q455.43 49.42 455.14 51.82Q454.84 54.23 454.41 56.85L454.41 56.85L445.81 105.54L421.90 105.54L430.06 59.33Q430.21 58.02 430.43 56.78Q430.65 55.54 430.65 54.52L430.65 54.52Q430.65 51.60 429.55 49.64Q428.46 47.67 426.42 46.72Q424.38 45.77 421.46 45.77L421.46 45.77Q418.26 45.77 415.19 46.87Q412.13 47.96 409.80 50.15Q407.47 52.33 405.79 55.39Q404.12 58.45 403.53 62.24L403.53 62.24L395.81 105.54ZM488.66 107.29L488.66 107.29Q480.35 107.29 474.23 104.01Q468.11 100.73 464.83 94.31Q461.55 87.90 461.55 78.57L461.55 78.57Q461.55 75.66 461.84 72.52Q462.13 69.39 462.72 65.89L462.72 65.89Q465.05 52.62 470.08 44.02Q475.11 35.42 482.54 31.20Q489.98 26.97 499.31 26.97L499.31 26.97Q504.26 26.97 508.42 28.13Q512.57 29.30 515.78 31.71Q518.98 34.11 521.17 38.05L521.17 38.05L522.19 38.05L527.88 28.72L547.12 28.72L543.62 47.52Q542.75 52.77 541.72 58.16Q540.70 63.56 539.83 68.37Q538.96 73.18 538.23 77.11Q537.50 81.05 537.13 83.53Q536.77 86.01 536.77 86.73L536.77 86.73Q536.77 88.78 537.86 89.72Q538.96 90.67 540.70 90.67L540.70 90.67L545.22 90.67L542.75 104.66Q540.27 105.69 536.91 106.49Q533.56 107.29 529.92 107.29L529.92 107.29Q525.54 107.29 522.26 106.05Q518.98 104.81 516.94 102.19L516.94 102.19Q515.92 101.02 515.27 99.27Q514.61 97.52 514.32 95.63L514.32 95.63L513.30 95.63Q508.63 101.31 502.22 104.30Q495.81 107.29 488.66 107.29ZM497.99 88.63L497.99 88.63Q501.64 88.63 504.70 87.17Q507.76 85.71 510.09 83.09Q512.42 80.47 514.03 76.82Q515.63 73.18 516.36 68.80L516.36 68.80Q516.94 65.89 517.16 64.07Q517.38 62.24 517.45 61.01Q517.53 59.77 517.53 58.89L517.53 58.89Q517.53 54.81 516.29 51.82Q515.05 48.83 512.42 47.23Q509.80 45.63 505.57 45.63L505.57 45.63Q500.18 45.63 496.54 47.74Q492.89 49.85 490.70 54.15Q488.52 58.45 487.35 64.58L487.35 64.58Q486.62 68.37 486.26 70.55Q485.89 72.74 485.82 74.13Q485.75 75.51 485.75 76.38L485.75 76.38Q485.75 82.36 488.59 85.50Q491.43 88.63 497.99 88.63ZM576.42 107.29L576.42 107.29Q569.71 107.29 565.34 105.54Q560.97 103.79 558.78 100.36Q556.59 96.94 556.59 91.84L556.59 91.84Q556.59 90.38 556.89 87.97Q557.18 85.57 557.76 81.63L557.76 81.63L564.03 46.06L553.97 46.06L556.89 28.72L567.82 28.72L576.71 6.27L594.79 6.27L590.85 28.72L605.86 28.72L602.80 46.06L587.79 46.06L581.96 79.15Q581.81 80.47 581.59 82.00Q581.38 83.53 581.38 84.40L581.38 84.40Q581.38 87.03 582.76 88.48Q584.14 89.94 587.50 89.94L587.50 89.94L595.08 89.94L592.45 104.81Q590.41 105.39 587.50 106.05Q584.58 106.71 581.67 107.00Q578.75 107.29 576.42 107.29ZM625.84 105.54L601.93 105.54L615.49 28.72L634.87 28.72L634.87 40.52L635.89 40.52Q638.23 36.59 641.29 33.45Q644.35 30.32 648.21 28.57Q652.07 26.82 656.74 26.82L656.74 26.82Q659.51 26.82 661.62 27.33Q663.74 27.84 664.76 28.43L664.76 28.43L661.11 49.27L653.53 49.27Q649.01 49.27 645.37 50.58Q641.72 51.90 639.10 54.37Q636.48 56.85 634.73 60.57Q632.98 64.29 632.25 69.10L632.25 69.10L625.84 105.54ZM684.87 107.29L684.87 107.29Q676.56 107.29 670.44 104.01Q664.32 100.73 661.04 94.31Q657.76 87.90 657.76 78.57L657.76 78.57Q657.76 75.66 658.05 72.52Q658.34 69.39 658.93 65.89L658.93 65.89Q661.26 52.62 666.29 44.02Q671.32 35.42 678.75 31.20Q686.19 26.97 695.52 26.97L695.52 26.97Q700.47 26.97 704.63 28.13Q708.78 29.30 711.99 31.71Q715.19 34.11 717.38 38.05L717.38 38.05L718.40 38.05L724.09 28.72L743.33 28.72L739.83 47.52Q738.96 52.77 737.93 58.16Q736.91 63.56 736.04 68.37Q735.17 73.18 734.44 77.11Q733.71 81.05 733.34 83.53Q732.98 86.01 732.98 86.73L732.98 86.73Q732.98 88.78 734.07 89.72Q735.17 90.67 736.91 90.67L736.91 90.67L741.43 90.67L738.96 104.66Q736.48 105.69 733.12 106.49Q729.77 107.29 726.13 107.29L726.13 107.29Q721.75 107.29 718.47 106.05Q715.19 104.81 713.15 102.19L713.15 102.19Q712.13 101.02 711.48 99.27Q710.82 97.52 710.53 95.63L710.53 95.63L709.51 95.63Q704.84 101.31 698.43 104.30Q692.02 107.29 684.87 107.29ZM694.20 88.63L694.20 88.63Q697.85 88.63 700.91 87.17Q703.97 85.71 706.30 83.09Q708.63 80.47 710.24 76.82Q711.84 73.18 712.57 68.80L712.57 68.80Q713.15 65.89 713.37 64.07Q713.59 62.24 713.66 61.01Q713.74 59.77 713.74 58.89L713.74 58.89Q713.74 54.81 712.50 51.82Q711.26 48.83 708.63 47.23Q706.01 45.63 701.78 45.63L701.78 45.63Q696.39 45.63 692.75 47.74Q689.10 49.85 686.91 54.15Q684.73 58.45 683.56 64.58L683.56 64.58Q682.83 68.37 682.47 70.55Q682.10 72.74 682.03 74.13Q681.96 75.51 681.96 76.38L681.96 76.38Q681.96 82.36 684.80 85.50Q687.64 88.63 694.20 88.63Z",
  // Wordmark extent in viewBox units (x 231.67 → 743.33) — anchors sparkles.
  wordmarkX: 231.67,
  wordmarkWidth: 511.66,
  // Cap band: top of a capital .. baseline.
  capTop: 5.54,
  cap: 100,
} as const;

// Sparkle radius in viewBox units. The reference geometry uses r=2.5 at
// font-size 56 (2.5/56 em); one em is 100/ARCHIVO_CAP viewBox units, so the
// radius is size-independent in lockup space: (2.5/56) × (100/0.686) ≈ 6.51.
const SPARKLE_RADIUS = 6.51;

// Fedora sparkle positions in lockup viewBox units (the reference's 512×320
// source coords {220,160} and {340,215} pushed through fedoraTransform).
const FEDORA_SPARKLES = [
  { cx: 76.96, cy: 55.62, delay: "0s" },
  { cx: 139.36, cy: 84.22, delay: "2s" },
] as const;

// One sparkle per glyph of "Cinatra". `fx` = each letter's measured centre as
// a fraction of the wordmark width (unchanged from the live-text measurements —
// same face, weight and tracking). `fy` = fraction of the cap band (top of a
// capital → baseline), an upper-middle band where every glyph has a stroke so
// the glyph clip never drops the spark.
const WORDMARK_SPARKLES = [
  { fx: 0.103, fy: 0.37, delay: "0.2s" }, // C
  { fx: 0.244, fy: 0.49, delay: "0.8s" }, // i
  { fx: 0.368, fy: 0.37, delay: "1.4s" }, // n
  { fx: 0.539, fy: 0.49, delay: "2.0s" }, // a
  { fx: 0.674, fy: 0.37, delay: "2.6s" }, // t
  { fx: 0.778, fy: 0.45, delay: "3.2s" }, // r
  { fx: 0.916, fy: 0.49, delay: "3.6s" }, // a
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
  const wordmarkClipId = `bm-wclip-${safeId}`;

  // C (cap-height) in CSS px for this `size`, then the rendered box follows
  // the lockup's fixed proportions.
  const capPx = ARCHIVO_CAP * size;
  const pxPerUnit = capPx / LOCKUP.cap;
  const renderWidth = LOCKUP.width * pxPerUnit;
  const renderHeight = LOCKUP.height * pxPerUnit;

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      width={renderWidth}
      height={renderHeight}
      viewBox={LOCKUP.viewBox}
      fill="currentColor"
      className={cn("inline-block align-middle", TONE_CLASS[tone], className)}
      style={{ overflow: "visible" }}
    >
      {variant === "animated" && (
        <defs>
          <radialGradient id={sparkleGradId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={1} />
            <stop offset="42%" stopColor="#fffce0" stopOpacity={0.85} />
            <stop offset="100%" stopColor="#fff5d8" stopOpacity={0} />
          </radialGradient>

          <clipPath id={fedoraClipId} clipPathUnits="userSpaceOnUse">
            <path d={LOCKUP.fedoraBrim} transform={LOCKUP.fedoraTransform} />
            <path d={LOCKUP.fedoraCrown} transform={LOCKUP.fedoraTransform} />
          </clipPath>

          <clipPath id={wordmarkClipId} clipPathUnits="userSpaceOnUse">
            <path d={LOCKUP.wordmark} />
          </clipPath>
        </defs>
      )}

      <g transform={LOCKUP.fedoraTransform}>
        <path d={LOCKUP.fedoraBrim} />
        <path d={LOCKUP.fedoraCrown} />
      </g>

      <path d={LOCKUP.wordmark} />

      {variant === "animated" && (
        <>
          <g clipPath={`url(#${fedoraClipId})`}>
            {FEDORA_SPARKLES.map((sparkle) => (
              <circle
                key={`${sparkle.cx}-${sparkle.cy}`}
                cx={sparkle.cx}
                cy={sparkle.cy}
                r={SPARKLE_RADIUS}
                fill={`url(#${sparkleGradId})`}
                className="bm-spark"
                style={{ animationDelay: sparkle.delay }}
              />
            ))}
          </g>

          <g clipPath={`url(#${wordmarkClipId})`}>
            {WORDMARK_SPARKLES.map((sparkle) => (
              <circle
                key={`${sparkle.fx}-${sparkle.fy}`}
                cx={LOCKUP.wordmarkX + sparkle.fx * LOCKUP.wordmarkWidth}
                cy={LOCKUP.capTop + sparkle.fy * LOCKUP.cap}
                r={SPARKLE_RADIUS}
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

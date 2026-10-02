import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Design Fixtures — Header band opacity — Cinatra",
  description:
    "Internal route scrolling a known content string under the app shell's own sticky header band, so the header-band-opacity conformance gate can assert the band is chrome and not a window onto the page.",
};

/**
 * /design-fixtures/header-band-opacity.
 *
 * Internal, unlinked route. The pixel harness for cinatra#3142 §3: the shell's
 * sticky header band is CHROME — the ratified drawing: "The top-bar is chrome,
 * not content" — and chrome takes an opaque ground. Drawn at ninety per cent
 * alpha with a backdrop blur, the band composited ten per cent of whatever
 * scrolled beneath it into itself, and the page's own agent-name line was
 * photographed ghosted across the breadcrumb row on run-page frame after frame.
 *
 * The header this is measured against is the REAL one — every route renders
 * inside `AppShell` (src/app/layout.tsx) — so the fixture supplies only the
 * other half: a tall run of bare page ground, then a loud, full-width, known
 * content string, then room to scroll it under the band. The paired
 * tests/e2e/design/conformance/header-band-opacity.spec.ts scrolls to each of
 * those two states and compares the band's own PIXELS: a band that lets content
 * through renders differently with the string beneath it than with bare ground
 * beneath it, whatever its class list says.
 *
 * Kept OFF the pixel-diffed /design-fixtures index (same convention as the
 * header-rule and overlay-header-band fixtures) so the committed pixel
 * baselines stay untouched; coverage here is a pixel COMPARISON between two
 * scroll states of this same page, not a snapshot against a baseline.
 */

/** The known content string the band must never composite into itself. */
const PROBE = "HEADER-BLEED-PROBE";

export default function HeaderBandOpacityFixturePage() {
  return (
    <main className="px-8 pb-[160vh]">
      {/* A tall run of bare page ground — the "nothing under the band" reading. */}
      <div data-testid="fixture-blank-run" className="h-[140vh]" />

      {/* The known string, drawn as wide and as loud as page content ever is, so
          a bleed at any alpha is a visible difference and not a rounding one. */}
      <div data-testid="fixture-probe">
        {Array.from({ length: 14 }).map((_, i) => (
          <p
            key={i}
            className="text-4xl leading-tight font-bold tracking-tight text-foreground"
          >
            {PROBE}
          </p>
        ))}
      </div>
    </main>
  );
}

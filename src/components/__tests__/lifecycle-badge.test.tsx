/**
 * LifecycleBadge — the canonical per-extension lifecycle status badge (#957).
 *
 * Invariants pinned here:
 *   - The status union covers the FULL canonical extension lifecycle
 *     (active | archived | locked) — "locked" must never be dropped.
 *   - Active renders live/green (StatusPill "approved", check icon).
 *   - Archived renders muted grey with the roster's ARCHIVE BOX — the one
 *     Archived pill the approved drawing draws (specs/app.html, the pill roster
 *     and block V.1; cinatra#4296) — and never the red failed treatment. The
 *     Extensions lifecycle chip's grey cross is the marked text of
 *     installed-status-indicator.tsx, not this pill.
 *   - Locked renders live/green styling with a distinct "Locked" label.
 *   - Icon-led: every badge carries an inline SVG glyph, never a bare dot.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { LifecycleBadge, type LifecycleStatus } from "../lifecycle-badge";
import { StatusPill } from "../ui/status-pill";

// Glyph fingerprints (path data) from StatusPill's StatusIcon.
const CHECK_GLYPH = "M20 6 9 17l-5-5";
const CROSS_GLYPH_A = "M18 6 6 18";
const BOX_GLYPH_A = "M21 8v13H3V8";
const BOX_GLYPH_B = "M1 3h22v5H1z";

function render(status: LifecycleStatus): string {
  return renderToStaticMarkup(<LifecycleBadge status={status} />);
}

describe("LifecycleBadge", () => {
  it("covers the full canonical lifecycle — active, archived, locked all render", () => {
    const all: LifecycleStatus[] = ["active", "archived", "locked"];
    for (const s of all) {
      const html = render(s);
      expect(html).toContain('data-slot="lifecycle-badge"');
      expect(html).toContain(`data-lifecycle="${s}"`);
    }
  });

  it("active → live/green StatusPill 'approved' with a check icon and 'Active' label", () => {
    const html = render("active");
    expect(html).toContain('data-status="approved"');
    expect(html).toContain(CHECK_GLYPH);
    expect(html).toContain(">Active<");
  });

  it("archived → muted StatusPill 'archived' with the roster's archive box and 'Archived' label", () => {
    const html = render("archived");
    expect(html).toContain('data-status="archived"');
    expect(html).toContain(BOX_GLYPH_A);
    expect(html).toContain(BOX_GLYPH_B);
    expect(html).toContain(">Archived<");
  });

  it("archived NEVER renders the cross, nor red failed styling", () => {
    const html = render("archived");
    expect(html).not.toContain(CROSS_GLYPH_A);
    expect(html).not.toContain('data-status="failed"');
    expect(html).not.toContain('data-status="declined"');
  });

  it("locked → live/green styling with a distinct 'Locked' label + tooltip (never dropped)", () => {
    const html = render("locked");
    expect(html).toContain('data-status="approved"');
    expect(html).toContain(">Locked<");
    expect(html).not.toContain(">Active<");
    expect(html).toContain("cannot be archived or uninstalled");
    // Live styling: never archived/muted, never red.
    expect(html).not.toContain('data-status="archived"');
    expect(html).not.toContain('data-status="failed"');
  });

  it("is icon-led for every status — an inline SVG glyph, never a bare dot", () => {
    const all: LifecycleStatus[] = ["active", "archived", "locked"];
    for (const s of all) {
      expect(render(s)).toContain("<svg");
    }
  });

  it("children override the default label but keep the status treatment", () => {
    const html = renderToStaticMarkup(
      <LifecycleBadge status="archived">Archived (v2)</LifecycleBadge>,
    );
    expect(html).toContain('data-status="archived"');
    expect(html).toContain("Archived (v2)");
  });

  it("a caller-supplied title wins over the built-in locked tooltip", () => {
    const html = renderToStaticMarkup(
      <LifecycleBadge status="locked" title="Custom tooltip" />,
    );
    expect(html).toContain('title="Custom tooltip"');
  });
});

describe("StatusPill archived icon (specs/app.html, the pill roster and block V.1)", () => {
  it("renders the roster's archive box in the archived case, never the cross", () => {
    const html = renderToStaticMarkup(<StatusPill status="archived" />);
    expect(html).toContain(BOX_GLYPH_A);
    expect(html).toContain(BOX_GLYPH_B);
    expect(html).not.toContain(CROSS_GLYPH_A);
  });

  it("keeps the muted-grey archived colourway (token classes, not raw colours)", () => {
    const html = renderToStaticMarkup(<StatusPill status="archived" />);
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toMatch(/\b(?:bg|text|border)-(?:gray|slate|zinc|neutral|stone)-\d+/);
  });
});

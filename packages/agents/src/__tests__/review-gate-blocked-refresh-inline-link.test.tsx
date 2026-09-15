// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// THE BLOCKED CARD'S REFRESH IS AN INLINE LINK (cinatra#3238).
// ---------------------------------------------------------------------------
// The ratified drawing draws the blocked card's second sentence and its escape
// hatch as ONE paragraph. Agent run & review §VII, the `review-gate-blocked`
// example, and Lifecycle cards §IV, "No longer open", carry the same line:
//
//   <p style="margin:5px 0 0;font-size:11.5px;color:var(--muted);line-height:1.5;">
//     The gate was already decided or the run moved on.
//     <a class="btn link" style="padding:0;font-size:11.5px;cursor:pointer;">Refresh</a>
//   </p>
//
// and the link rule those two words are drawn by:
//
//   .btn.link { background: transparent; border-color: transparent;
//               color: var(--blue); text-decoration: underline;
//               text-underline-offset: 3px; padding: 7px 4px; }
//
// The sentence and the affordance share the paragraph. The affordance is
// phrasing content at the END of the sentence — the reader's eye finishes the
// line and the way out is right there — and it is a LINK: underlined, in the
// accent the palette calls a link. What shipped instead was the same `Button`
// rendered as a SIBLING block under the paragraph (`className="mt-1"`), which
// opens a line box of its own, and whose underline appears only on hover — so
// at rest it reads as a plain word rather than as a link.
//
// WHAT THIS FILE MEASURES, AND WHAT IT LEAVES TO THE PROOF.
// jsdom lays nothing out: it has no line boxes and no cascade, so a computed
// `color` or a measured line count would be a number this file invented. What
// it CAN measure, and does, is (1) the DOM the layout is made of — the control
// is phrasing content inside the sentence's own paragraph and carries no
// display or margin utility that would give it a box of its own — and (2) that
// the tokens it is drawn with are DECLARED in `src/app/globals.css`, and
// declared distinctly per palette. That second half is a declaration reading,
// not a contrast measurement and not a visual check: nothing here resolves a
// cascade. The live reading of both palettes on the running application is the
// proof this issue asks for at close.
//
// THE DARK PALETTE'S LINK COLOUR IS THE APPLICATION'S, NOT THIS PANEL'S. The
// app's `--primary` is the drawing's indigo `#364e81` in the light palette and
// a near-white in the dark one, by the dark palette's own declaration
// (`--primary: var(--accent)`). `run-made-step-surface.tsx` settled that
// question for this package already: "drawing a bespoke blue here would make
// this one row the only link in the app that ignores the palette". So the
// control takes `text-primary` — the design system's link button's own token,
// which the theme registers — and the dark token itself stays the
// application-wide item it already is.
//
// Run:
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/review-gate-blocked-refresh-inline-link.test.tsx
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { reviewBlockedCopy } from "@/lib/artifacts/review-surface-model";

import { ReviewGateBlocked } from "../review-gate-states";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, push: vi.fn(), replace: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  nav.refresh.mockClear();
});

const COPY = reviewBlockedCopy("no-longer-pending");
const REFRESH = '[data-action="refresh-gate -> live-gate"]';
const PANEL = '[data-conformance-id="review-gate-blocked"]';

/** The two palettes, and the selector each one is declared under in the
 *  shipped stylesheet. `:root` is the light palette the app boots in; `.dark`
 *  is the class next-themes puts on the document element. */
const PALETTES = [
  { palette: "light", selector: ":root" },
  { palette: "dark", selector: ".dark" },
] as const;

const GLOBALS = readFileSync(
  path.resolve(__dirname, "../../../../src/app/globals.css"),
  "utf8",
);

/** The `@theme inline` block is where a `--color-*` utility becomes real: a
 *  `text-x` whose token is not registered there emits no rule at all and the
 *  text silently falls back to the inherited ink. */
function registersColourToken(name: string): boolean {
  return new RegExp(`--color-${name}\\s*:`).test(GLOBALS);
}

/** One palette's declaration block, read out of the shipped stylesheet. */
function paletteBlock(selector: string): string {
  const open = GLOBALS.indexOf(`\n${selector} {`);
  expect(open, `${selector} is declared in globals.css`).toBeGreaterThan(-1);
  const start = open + selector.length + 3;
  const close = GLOBALS.indexOf("\n}", start);
  expect(close, `${selector} closes`).toBeGreaterThan(start);
  return GLOBALS.slice(start, close);
}

/** A token's value INSIDE one palette, following `var(--x)` hops through that
 *  same palette — which is how the palette resolves on the element that
 *  declares it. */
function resolveToken(block: string, name: string, depth = 0): string {
  const declared = new RegExp(`^\\s*--${name}:\\s*([^;]+);`, "m").exec(block);
  expect(declared, `--${name} is declared in this palette`).not.toBeNull();
  const value = declared![1].trim();
  const hop = /^var\(\s*--([a-z0-9-]+)\s*\)$/.exec(value);
  if (hop && depth < 8) return resolveToken(block, hop[1], depth + 1);
  return value;
}

function classTokens(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** Render the panel inside a wrapper carrying the palette in force. */
function renderBlocked(palette: string, onRefresh?: () => void) {
  const { container } = render(
    <div className={palette === "dark" ? "dark" : undefined}>
      <ReviewGateBlocked reason="no-longer-pending" onRefresh={onRefresh} />
    </div>,
  );
  const panel = container.querySelector<HTMLElement>(PANEL);
  expect(panel, "the blocked panel is drawn").not.toBeNull();
  const control = panel!.querySelector<HTMLElement>(REFRESH);
  expect(control, "the refresh affordance is drawn").not.toBeNull();
  const body = Array.from(panel!.querySelectorAll("p")).find((p) =>
    (p.textContent ?? "").startsWith(COPY.body),
  );
  expect(body, "the second sentence is drawn").toBeDefined();
  return { panel: panel!, control: control!, body: body! };
}

// ---------------------------------------------------------------------------
// Acceptance 1 — "Refresh sits inline at the end of the second sentence, inside
// the same paragraph (one line box, not two)".
// ---------------------------------------------------------------------------
describe("the Refresh affordance sits inside the sentence it ends", () => {
  for (const { palette } of PALETTES) {
    it(`${palette} — it is phrasing content in the body paragraph, not a block after it`, () => {
      const { body, control } = renderBlocked(palette);

      expect(body.contains(control)).toBe(true);
      expect(control.parentElement).toBe(body);
      // The whole reading is ONE paragraph: the ratified sentence, then the way
      // out, in that order and with a single space between them.
      expect(body.textContent).toBe(`${COPY.body} Refresh`);
      expect(control.textContent).toBe("Refresh");
    });

    it(`${palette} — it opens no line box of its own`, () => {
      const { control } = renderBlocked(palette);
      const tokens = classTokens(control);

      // Inline, so it sits in the sentence's own last line box and takes that
      // line's metrics instead of forming an atomic inline box of its own.
      expect(tokens).toContain("inline");
      for (const display of ["inline-flex", "flex", "block", "grid", "inline-grid"]) {
        expect(tokens, `${display} would give the control a box of its own`).not.toContain(
          display,
        );
      }
      // The second line came from the control being a BLOCK-level sibling of
      // the paragraph; `mt-1` is that block affordance's signature and means
      // nothing on phrasing content, so it goes with it.
      expect(tokens.filter((t) => /^-?(m|mt|mb|my)-/.test(t))).toEqual([]);
      // A fixed control height and control padding are the other half of the
      // block box: an inline link takes the line's own metrics.
      expect(tokens).toContain("h-auto");
      expect(tokens).toContain("p-0");
    });
  }
});

// ---------------------------------------------------------------------------
// Acceptance 2 — "Refresh is drawn as the design system's link button —
// underlined, link accent — in both palettes".
// ---------------------------------------------------------------------------
describe("the Refresh affordance is drawn as the design system's link button", () => {
  for (const { palette, selector } of PALETTES) {
    it(`${palette} — underlined at rest, not only under the pointer`, () => {
      const { control } = renderBlocked(palette);
      const tokens = classTokens(control);

      // `.btn.link { text-decoration: underline; text-underline-offset: 3px }`
      // — the drawing underlines the word itself, at its own offset.
      // `hover:underline` alone leaves it a plain word at rest, which is the
      // reading this issue filed; and `underline-offset-4` is the design
      // system's default, not the offset this rule is drawn at —
      // `run-made-step-surface.tsx` transcribes the same rule as
      // `underline underline-offset-[3px]`.
      expect(tokens).toContain("underline");
      expect(tokens).toContain("underline-offset-[3px]");
      expect(tokens).not.toContain("underline-offset-4");
      expect(control.getAttribute("data-variant")).toBe("link");
    });

    it(`${palette} — it takes the link accent the theme registers`, () => {
      const { control } = renderBlocked(palette);
      const tokens = classTokens(control);

      expect(tokens).toContain("text-primary");
      expect(registersColourToken("primary")).toBe(true);
    });

    it(`${palette} — the link accent is not the ink the paragraph is drawn in`, () => {
      const { control, body } = renderBlocked(palette);
      expect(classTokens(control)).toContain("text-primary");
      expect(classTokens(body)).toContain("text-muted-foreground");

      const block = paletteBlock(selector);
      const accent = resolveToken(block, "primary");
      const paragraphInk = resolveToken(block, "muted-foreground");
      const bodyInk = resolveToken(block, "foreground");

      for (const value of [accent, paragraphInk, bodyInk]) {
        expect(value, "a palette value resolves to a colour").toMatch(/^(#|oklch|rgb|hsl)/);
      }
      expect(accent).not.toBe(paragraphInk);
      expect(accent).not.toBe(bodyInk);
    });
  }
});

// ---------------------------------------------------------------------------
// The card-local refresh seam survives the move (the component's own contract:
// "on the review PAGE the Refresh still re-renders the route (unchanged
// default), but a card sitting in a chat transcript must re-resolve ITSELF").
// ---------------------------------------------------------------------------
describe("the refresh seam, from inside the paragraph", () => {
  it("calls the card-local onRefresh and never the route refresh", () => {
    const onRefresh = vi.fn();
    const { control } = renderBlocked("light", onRefresh);

    fireEvent.click(control);

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("falls back to the route refresh when the host gives no seam", () => {
    const { control } = renderBlocked("light");

    fireEvent.click(control);

    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});

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
// declared in root/default and dark blocks. That half is a declaration reading,
// not a contrast measurement and not a visual check: nothing here resolves a
// cascade. The live reading of both palettes on the running application is the
// proof this issue asks for at close.
//
// THE LINK COLOUR IS THE DRAWING'S PALETTE-INVARIANT INDIGO.
// The shared Button link uses text-primary, whose dark action colour is near
// white. This blocked reading names the drawing's --blue (#364e81), so its
// local class uses the already registered indigo-ink token. The shared Button
// and theme remain untouched. These tests check the real DOM and declarations;
// the companion Playwright pin reads actual computed styles and inline flow.
// Native success does not claim that browser execution or a stale-gate grade.
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

/** A type-size utility: a standard step, a named type-scale token or a bracket form. */
const TYPE_SIZE =
  /^text-(?:xs|sm|base|lg|[2-9]?xl|badge-(?:xs|2xs)|listing-title|page-title-(?:sm|md|lg)|\[[^\]]*\])$/;

/** Two native case/declaration guards. The light case reads .cinatra declarations; the dark case reads .dark.
 *  Root fallback models declaration inheritance only, never computed cascade.
 *  App-owned actual .cinatra/.dark computed proof remains owed. */
const PALETTES = [
  { palette: "light", selector: ".cinatra" },
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

/** Follow var(--x) hops within the selected source declaration block only.
 *  This does not resolve actual inherited theme values or a browser cascade. */
function resolveToken(block: string, name: string, depth = 0): string {
  const pattern = new RegExp(`^\\s*--${name}:\\s*([^;]+);`, "m");
  const declared = pattern.exec(block) ?? pattern.exec(paletteBlock(":root"));
  expect(declared, `--${name} is declared in this palette`).not.toBeNull();
  const value = declared![1].trim();
  const hop = /^var\(\s*--([a-z0-9-]+)\s*\)$/.exec(value);
  if (hop && depth < 8) return resolveToken(block, hop[1], depth + 1);
  return value;
}

function classTokens(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** Tag the dark DOM case; no stylesheet or rendered palette cascade is supplied. */
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

    it(`${palette} — it is drawn at the sentence's own size, not a size of its own`, () => {
      const { body, control } = renderBlocked(palette);

      // §VII draws the sentence at 11.5px and repeats 11.5px on the link only
      // to cancel the `.btn` rule's own 13px: the link is the size of the
      // sentence it ends. So the control names no type size of its own and
      // defers to the paragraph with `text-[length:inherit]`, the one bracket
      // form the type rules allow; the paragraph keeps its own ramp token.
      // jsdom resolves no cascade: the computed equality is the browser pin's.
      expect(classTokens(control).filter((t) => TYPE_SIZE.test(t))).toEqual([
        "text-[length:inherit]",
      ]);
      expect(classTokens(body).filter((t) => TYPE_SIZE.test(t))).toEqual(["text-xs"]);
    });
  }
});

// ---------------------------------------------------------------------------
// Acceptance 2 structural/declaration controls only: shared link Button and
// resting underline and registered drawing link colour. These native controls
// do not resolve a browser cascade; the companion browser pin must run hosted.
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

      expect(tokens).toContain("text-indigo-ink");
      expect(tokens).not.toContain("text-primary");
      expect(registersColourToken("indigo-ink")).toBe(true);
    });

    it(`${palette} — the link accent is not the ink the paragraph is drawn in`, () => {
      const { control, body } = renderBlocked(palette);
      expect(classTokens(control)).toContain("text-indigo-ink");
      expect(classTokens(body)).toContain("text-muted-foreground");

      const block = paletteBlock(selector);
      const accent = resolveToken(block, "indigo-ink");
      const paragraphInk = resolveToken(block, "muted-foreground");
      const bodyInk = resolveToken(block, "foreground");

      for (const value of [accent, paragraphInk, bodyInk]) {
        expect(value, "a palette value resolves to a colour").toMatch(/^(#|oklch|rgb|hsl)/);
      }
      expect(accent).toBe("#364e81");
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

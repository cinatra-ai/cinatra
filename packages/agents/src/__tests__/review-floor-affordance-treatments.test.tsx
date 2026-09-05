// @vitest-environment jsdom
//
// THE THREE AFFORDANCES' TREATMENTS (cinatra#3080, fix leg 8).
//
// WHAT THE NINTH ROUND'S PIXELS SHOWED. Comment drew in ink with a
// speech-bubble glyph in front of it; Regenerate drew on a FILLED muted ground;
// Continue drew its arrow BEFORE the label. All three are the issue's own
// subject, and all three depart from the ratified drawing.
//
// THE DRAWING, IN ITS OWN MARKUP (Agent run & review §VI, "Example — the
// decision bar", reproduced verbatim on Lifecycle cards §XIII.1):
//
//   <button class="btn ghost"   style="…color:var(--muted);">Comment</button>
//   <button class="btn outline" …><svg …/>Regenerate</button>
//   <button class="btn primary" …>Continue<svg …/></button>
//
// and the page's own rules for those classes:
//
//   .btn.ghost   { background: transparent;      border-color: transparent; }
//   .btn.outline { background: var(--surface);   color: var(--ink);
//                  border-color: var(--line-strong); }
//   .btn.primary { background: var(--blue);      color: var(--surface-strong);
//                  border-color: var(--blue); }
//
// So, read off the drawing and nothing else: Comment is the ghost treatment in
// var(--muted) and carries NO glyph; Regenerate is the OUTLINED ground (a
// var(--surface) fill inside a var(--line-strong) stroke), never the filled
// var(--surface-muted) of `.btn.secondary`, and its glyph leads; Continue keeps
// the primary ground and its arrow FOLLOWS the label.
//
// WHY THE COLOURS ARE READ OUT OF THE STYLESHEET. jsdom implements neither
// Tailwind's utility generation nor custom-property substitution, so no
// `getComputedStyle` here can tell a wrong colour from no declaration at all
// (the reasoning `src/app/__tests__/review-gate-design-tokens.test.ts` already
// records). What is read exactly is the pair the defect lives in: which
// utilities the bar ASKS FOR, and what those utilities resolve to in each
// palette the stylesheet declares. The live boot takes the computed styles.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { ReviewDecisionBar } from "../review-decision-bar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderBar() {
  return render(
    <ReviewDecisionBar
      permissions={{ canDecide: true, canComment: true }}
      submitAction={vi.fn(async () => ({ kind: "annotated" }) as never)}
    />,
  );
}

const control = (action: string): HTMLElement =>
  screen.getByText((_t, el) => el?.getAttribute("data-action") === action) as HTMLElement;

const COMMENT = "comment-review -> annotated";
const REGENERATE = "regenerate-review -> changes-requested";
const CONTINUE = "continue-review -> resolved";

function classesOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** Where the glyph sits relative to the label, read off the DOM order. */
function glyphPlacement(button: HTMLElement): "none" | "leading" | "trailing" {
  const svg = button.querySelector("svg");
  if (!svg) return "none";
  const label = Array.from(button.childNodes).find(
    (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
  );
  if (!label) return "leading";
  return svg.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING
    ? "leading"
    : "trailing";
}

describe("§VI — Comment is the ghost treatment in var(--muted), with no glyph", () => {
  it("carries NO glyph at all", () => {
    renderBar();
    expect(glyphPlacement(control(COMMENT))).toBe("none");
  });

  it("asks for the ghost variant and the muted ink", () => {
    renderBar();
    const button = control(COMMENT);
    expect(button.getAttribute("data-variant")).toBe("ghost");
    expect(classesOf(button)).toContain("text-muted-foreground");
  });
});

describe("§VI — Regenerate stands on the OUTLINED ground, its glyph leading", () => {
  it("is not the filled secondary ground the ninth round drew", () => {
    renderBar();
    expect(control(REGENERATE).getAttribute("data-variant")).not.toBe("secondary");
  });

  it("asks for the outline variant, the surface fill and the strong stroke", () => {
    renderBar();
    const button = control(REGENERATE);
    expect(button.getAttribute("data-variant")).toBe("outline");
    const classes = classesOf(button);
    expect(classes).toContain("bg-surface");
    expect(classes).toContain("border-line-strong");
  });

  it("asks for the same two tokens in the DARK reading", () => {
    // The shared outline variant carries its own dark ground and stroke; the
    // drawing names ONE pair for both palettes, and those tokens are redefined
    // per palette rather than swapped for different ones.
    renderBar();
    const classes = classesOf(control(REGENERATE));
    expect(classes).toContain("dark:bg-surface");
    expect(classes).toContain("dark:border-line-strong");
  });

  it("keeps its glyph in FRONT of the label, as the drawing sets it", () => {
    renderBar();
    expect(glyphPlacement(control(REGENERATE))).toBe("leading");
  });
});

describe("§VI — Continue keeps the primary ground and its arrow FOLLOWS the label", () => {
  it("draws the arrow after the word", () => {
    renderBar();
    expect(glyphPlacement(control(CONTINUE))).toBe("trailing");
  });

  it("is still the primary affordance", () => {
    renderBar();
    expect(control(CONTINUE).getAttribute("data-variant")).toBe("default");
  });

  it("strokes the same blue it is filled with", () => {
    // `.btn.primary { background: var(--blue); border-color: var(--blue); }` —
    // one colour edge to edge. The shared variant strokes `--line-strong`.
    renderBar();
    expect(classesOf(control(CONTINUE))).toContain("border-primary");
  });
});

// ---------------------------------------------------------------------------
// The colours the utilities resolve to, in BOTH palettes the stylesheet declares.
// ---------------------------------------------------------------------------

// The stylesheet lives at the repository root; this suite runs from the agents
// package, so the path is taken from this file rather than from the cwd.
const GLOBALS_CSS = readFileSync(
  join(__dirname, "..", "..", "..", "..", "src", "app", "globals.css"),
  "utf8",
);

/** Every `--color-*` registration in the `@theme inline` block. */
function registeredColors(): Map<string, string> {
  const out = new Map<string, string>();
  const block = /@theme inline\s*\{([\s\S]*?)\n\}/.exec(GLOBALS_CSS);
  if (!block) return out;
  for (const part of block[1]!.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const m = /^\s*(--color-[A-Za-z0-9-]+)\s*:\s*([\s\S]+)$/.exec(part);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

describe("the utilities the bar asks for are registered colours in every palette", () => {
  const REGISTERED = registeredColors();

  for (const [utility, token] of [
    ["--color-muted-foreground", "var(--muted-foreground)"],
    ["--color-surface", "var(--surface)"],
    ["--color-line-strong", "var(--line-strong)"],
    ["--color-primary", "var(--primary)"],
  ] as const) {
    it(`registers ${utility} against the drawing's own token`, () => {
      expect(REGISTERED.get(utility)).toBe(token);
    });
  }

  for (const token of ["--muted", "--surface", "--line-strong"]) {
    it(`declares ${token} in the dark palette as well as the light one`, () => {
      const stripped = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
      const declarations = stripped.match(
        new RegExp(`${token}\\s*:\\s*[^;]+;`, "g"),
      );
      // Light (`:root`), the explicit light block, and the dark palette.
      expect((declarations ?? []).length).toBeGreaterThanOrEqual(2);
    });
  }
});

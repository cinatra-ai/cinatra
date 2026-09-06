// @vitest-environment jsdom
//
// THE PILL IS DRAWN AS A PILL (cinatra#3062, the fourth proof
// round's second departure).
//
// The ratified drawing declares this chip exactly once, and it declares a
// FULL-ROUND shape:
//
//   .skchip { display: inline-flex; align-items: center; gap: 8px;
//             padding: 5px 11px 5px 7px; border: 1px solid var(--line);
//             border-radius: 9999px; background: var(--surface-strong);
//             font-size: 12px; color: var(--ink); white-space: nowrap; }
//
// and §V calls the thing it draws by that shape's name throughout — "one pill
// per skill", "A pill carries a checkbox, the skill's name and its vendor, and
// nothing else". A 9999px radius on a 26 pixel box is a stadium: the two ends
// are half-circles and there is no straight run of edge left between them.
//
// The shipped row carried `rounded-chip` instead — the design package's SHARED
// chip radius, `--r-chip: 0.5rem`, i.e. 8px — which at the 26 pixel height the
// fourth proof round measured reads as a rounded RECTANGLE, not a pill. The graded
// reading recorded exactly that, in both palettes, on every one of the eight
// frames.
//
// WHAT IS PINNED HERE:
//
//   1. the pill declares a FULL-ROUND radius and no longer declares the shared
//      8px chip radius;
//   2. measured rather than spelled: with the two utilities' own declarations in
//      the document, the pill computes a radius of at least half its own drawn
//      height — the definition of a stadium — and not the 8px it computed
//      before;
//   3. the fix is LOCAL TO THIS PILL. `--r-chip` is still 0.5rem in the design
//      package, and `.rounded-chip` is still declared there: many unrelated
//      chips across the app consume that token, and the drawing gives a
//      full-round shape to THIS chip, not to all of them;
//   4. the shape is the same in every reading — held, editable-before-start and
//      read-only — because the drawing draws one `.skchip` for all three.
//
// WHAT THIS FILE CANNOT PROVE, said plainly. jsdom lays out nothing, so arm 2
// measures the radius the declarations in the document resolve to, not the
// radius a browser paints. The painted radius is read on the graded pictures on
// this pull request, with `getComputedStyle` on the real node in both palettes.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-step-pill-is-drawn-as-a-pill.test.tsx
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(),
  confirmRunRecommendationAction: vi.fn(),
  skipRunRecommendationAction: vi.fn(),
}));
vi.mock("../server-actions", () => ({ getRunRecommendedSkillsAction: vi.fn(async () => []) }));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import {
  RunRecommendationChipRow,
  type RunRecommendationDecision,
} from "../run-recommendation-chip-row";

// The height the fourth proof round MEASURED on the shipped pill, in both palettes.
// A shape is a stadium when its corner radius reaches half its height; anything
// below that leaves a straight run of edge and reads as a rectangle.
const MEASURED_PILL_HEIGHT_PX = 26;

// THE DESIGN PACKAGE'S OWN SOURCES, READ OFF DISK. The shared chip radius is
// taken from the token that declares it rather than transcribed into this file,
// so the arms below measure the radius the app actually ships for
// `.rounded-chip` and cannot pass against a stale literal copied in here.
const DESIGN_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../design/src",
);
const DESIGN_TOKENS_CSS = readFileSync(path.join(DESIGN_SRC, "tokens.css"), "utf8");
const DESIGN_UTILITIES_CSS = readFileSync(path.join(DESIGN_SRC, "utilities.css"), "utf8");

function rChipDeclarations(): string[] {
  return [...DESIGN_TOKENS_CSS.matchAll(/--r-chip\s*:\s*([^;]+);/g)].map((m) =>
    m[1]!.trim().replace(/\s+/g, " "),
  );
}

// `--r-chip` in pixels, resolved from the token's own declared value.
const R_CHIP_PX = (() => {
  const declared = new Set(rChipDeclarations());
  if (declared.size !== 1) {
    throw new Error(`--r-chip is declared ${declared.size} different ways: ${[...declared].join(", ")}`);
  }
  const value = [...declared][0]!;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) throw new Error(`--r-chip is not a length: ${value}`);
  return value.endsWith("rem") ? n * 16 : n;
})();

// The two utilities' declarations, mirrored into the document so the arms below
// measure a radius rather than compare a class string. The chip side is the
// design package's own value, resolved above. The full-round side is the
// FRAMEWORK's stock utility, which this repo never redefines (pinned below) —
// jsdom cannot resolve the infinite-length form a framework build can emit for
// it, so a finite full-round stand-in stands here, and the PAINTED radius is
// read in a real browser engine against the app's compiled stylesheet, on the
// graded pictures on this pull request.
const UTILITY_CSS = `
  .rounded-chip { border-radius: ${R_CHIP_PX}px; }
  .rounded-full { border-radius: 9999px; }
`;

const CANDIDATES = [
  { skillId: "@cinatra-ai/blog-image-matcher-skill:blog-image-matcher", name: "Blog Image Matcher Skill" },
  { skillId: "@cinatra-ai/blog-writing-skill:blog-writing", name: "Blog Writing Skill" },
  { skillId: "@cinatra-ai/brand-voice-matcher-skill:brand-voice-matcher", name: "Brand Voice Matcher Skill" },
  { skillId: "@cinatra-ai/web-research-skill:web-research", name: "Web Research Skill" },
].map((c, i) => ({
  ...c,
  vendorName: null,
  skillRevisionId: `${c.skillId}@1`,
  recommended: i !== 1,
  score: 0.8,
  rank: i + 1,
  scoredFeatures: [],
}));

const HELD: RunRecommendationDecision = { kind: "pending" };

// The recorded reading a run that has NOT started falls to — the pills stay
// editable and Continue stays beneath them. The drawing draws the same
// `.skchip` here as it does live.
const SETTLED_BEFORE_START: RunRecommendationDecision = {
  kind: "confirmed",
  skillNames: [CANDIDATES[0].name],
  runStarted: false,
  decided: CANDIDATES.map((c, i) => ({
    skillId: c.skillId,
    name: c.name,
    mark: i === 1 ? ("skipped" as const) : ("confirmed" as const),
  })),
  candidates: CANDIDATES,
};

// The same recorded set once the run HAS started: read-only, no Continue. Same
// shape again.
const SETTLED_AFTER_START: RunRecommendationDecision = {
  ...SETTLED_BEFORE_START,
  runStarted: true,
};

const READINGS = [
  ["held", HELD],
  ["parked before start", SETTLED_BEFORE_START],
  ["read-only once started", SETTLED_AFTER_START],
] as const;

function mount(decision: RunRecommendationDecision) {
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <RunRecommendationChipRow
        runId="run-3062-pill-shape"
        agentPackageName="@cinatra-ai/blog-draft-writer-agent"
        decision={decision}
        holdRef="hold-ref-3062"
        initialRecommendations={CANDIDATES}
      />
    </LifecycleCardSurfaceProvider>,
  );
}

const pillsIn = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-skills-step-pill]"));

let styleEl: HTMLStyleElement;

beforeEach(() => {
  styleEl = document.createElement("style");
  styleEl.textContent = UTILITY_CSS;
  document.head.append(styleEl);
});

afterEach(() => {
  styleEl.remove();
  cleanup();
  vi.clearAllMocks();
});

describe.each(READINGS)("the Skills step's pill, %s", (_reading, decision) => {
  it("declares the drawing's FULL-ROUND shape, not the shared 8px chip radius", () => {
    const { container } = mount(decision);
    const pills = pillsIn(container);
    expect(pills).toHaveLength(CANDIDATES.length);
    for (const pill of pills) {
      const cls = pill.className.split(/\s+/);
      // The drawing's `border-radius: 9999px`.
      expect(cls).toContain("rounded-full");
      // …and NOT the design package's shared 8px chip radius, which is what the
      // fourth proof round measured on this pill.
      expect(cls).not.toContain("rounded-chip");
      // Exactly one radius utility, so no later class quietly wins the cascade.
      expect(cls.filter((c) => c.startsWith("rounded-"))).toHaveLength(1);
    }
  });

  it("computes a stadium: a radius of at least half the pill's own drawn height", () => {
    const { container } = mount(decision);
    for (const pill of pillsIn(container)) {
      const radius = window.getComputedStyle(pill).getPropertyValue("border-radius").trim();
      const px = Number.parseFloat(radius);
      expect(Number.isFinite(px), `border-radius did not resolve to a length: "${radius}"`).toBe(
        true,
      );
      // The stadium test.
      expect(px).toBeGreaterThanOrEqual(MEASURED_PILL_HEIGHT_PX / 2);
      // And explicitly not the rounded rectangle that was measured: the shared
      // chip radius on a 26 pixel box leaves a straight run of edge on each side.
      expect(px).toBeGreaterThan(R_CHIP_PX);
    }
  });
});

describe("the shared chip radius is left where it is", () => {
  // The design package's `--r-chip` is consumed by chips all over the app that
  // this drawing says nothing about. The departure was THIS pill reaching for
  // that token, not the token's value — so the fix moves the pill, never the
  // token.
  it("keeps --r-chip at 0.5rem in the design tokens", () => {
    // Read as a VALUE and normalised, so a reformatting of the stylesheet cannot
    // fail this arm and a changed radius cannot pass it.
    const declared = rChipDeclarations();
    expect(declared.length).toBeGreaterThan(0);
    for (const value of declared) expect(value).toBe("0.5rem");
  });

  it("keeps .rounded-chip declared over the shared token", () => {
    // Matched INSIDE the rule's own body, so an unrelated mention of either
    // string elsewhere in the file cannot satisfy it.
    const rule = DESIGN_UTILITIES_CSS.match(/\.rounded-chip\s*\{([^}]*)\}/);
    expect(rule, ".rounded-chip is no longer declared in the design utilities").not.toBeNull();
    expect(rule![1]!.replace(/\s+/g, " ").trim()).toMatch(
      /^border-radius:\s*var\(--r-chip\);?$/,
    );
  });

  it("leaves .rounded-full to the framework, so the class keeps its full-round meaning", () => {
    // The pill's new radius utility is the framework's stock full round. If this
    // repo ever declared a `.rounded-full` rule of its own, the pill's shape
    // would stop being the drawing's 9999px and this file's stand-in
    // declaration would stop standing for anything.
    expect(DESIGN_UTILITIES_CSS).not.toMatch(/\.rounded-full\s*\{/);
    expect(DESIGN_TOKENS_CSS).not.toMatch(/\.rounded-full\s*\{/);
  });
});

// ---------------------------------------------------------------------------
// THE GROUND, RE-READ RATHER THAN RE-FIXED (cinatra#3062, the fourth proof
// round's third item).
//
// The fourth proof round measured, on the card at rest: "pill ground
// rgb(255,255,255) and border 1px solid rgba(21,33,58,0.14) on the set pill and
// the clear pill alike — one unconditional ground". It reported that as the
// second capture's tint still being absent.
//
// THE DRAWING GIVES ONE GROUND, so that reading CONFORMS and there is nothing
// to fix. The drawing declares this chip exactly once:
//
//   .skchip { … border: 1px solid var(--line); … background: var(--surface-strong); … }
//
// and it declares no checked variant of it anywhere. Its ONLY checked accent is
// on the box:
//
//   .skchip .cbx.on { background: var(--blue); border-color: var(--blue); }
//
// and §V says the pill carries "a checkbox, the skill's name and its vendor, and
// nothing else". A set pill and a clear pill therefore stand on the same ground
// inside the same border, and what a box is set to is stated by the box.
//
// This block PINS that reading so the retired state tint cannot come back under
// the pill: the ground is a property of the pill, never of its state.
describe("the pill stands on ONE ground, set or clear", () => {
  it("draws the set pill and the clear pill on the same ground, in every reading", () => {
    for (const [, decision] of READINGS) {
      const { container } = mount(decision);
      const pills = pillsIn(container);
      const set = pills.filter((p) => p.getAttribute("data-skill-applied") === "true");
      const clear = pills.filter((p) => p.getAttribute("data-skill-applied") === "false");
      // The frame the round graded carried both readings at once, and so does this.
      expect(set.length).toBeGreaterThan(0);
      expect(clear.length).toBeGreaterThan(0);
      // ONE declaration: every pill's class list is the SAME class list, so no
      // ground, border or radius can be conditioned on the box's state.
      const classLists = new Set(pills.map((p) => p.className.trim()));
      expect(classLists.size).toBe(1);
      const only = [...classLists][0]!;
      // The drawing's own two declarations, named rather than implied.
      expect(only).toContain("border-line");
      expect(only).toContain("bg-surface-strong");
      // And no state-conditional variant of either, on any Tailwind state prefix.
      expect(only).not.toMatch(/(^|\s)[a-z-]+:(bg|border)-/);
      cleanup();
    }
  });

  it("puts the only checked accent on the box, which is where the drawing puts it", () => {
    const { container } = mount(HELD);
    const set = container.querySelector<HTMLElement>('[data-skill-applied="true"]')!;
    const clear = container.querySelector<HTMLElement>('[data-skill-applied="false"]')!;
    const box = (p: HTMLElement) => p.querySelector<HTMLElement>("[data-skills-step-checkbox]")!;
    // The state IS drawn — on the box, and read there.
    expect(box(set).getAttribute("aria-checked")).toBe("true");
    expect(box(clear).getAttribute("aria-checked")).toBe("false");
    expect(box(set).getAttribute("data-state")).toBe("checked");
    expect(box(clear).getAttribute("data-state")).toBe("unchecked");
    // THE ACCENT ITSELF, not merely the state that would carry it. The box
    // declares a checked GROUND and a checked BORDER as state-conditional
    // utilities of its own — the drawing's `.skchip .cbx.on { background:
    // var(--blue); border-color: var(--blue) }` — so the colour arrives on the
    // box, and only when the box is set.
    for (const b of [box(set), box(clear)]) {
      expect(b.className).toMatch(/data-\[state=checked\]:bg-/);
      expect(b.className).toMatch(/data-\[state=checked\]:border-/);
    }
    // …and the pill's own root declares NO conditional ground or border at all,
    // in any variant form, bracketed ones included: nothing on the pill can turn
    // a colour on when its box is set.
    for (const pill of [set, clear]) {
      expect(pill.className).not.toMatch(/(^|\s)\S*:(bg|border)-/);
    }
    // …and it is stated on the pill's own root as data, not as a colour.
    expect(set.getAttribute("data-skill-applied")).toBe("true");
    expect(clear.getAttribute("data-skill-applied")).toBe("false");
  });
});

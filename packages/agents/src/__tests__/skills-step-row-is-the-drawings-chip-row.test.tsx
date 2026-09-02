// @vitest-environment jsdom
//
// THE SKILLS STEP'S ROW IS THE DRAWING'S CHIP-ROW, ON EVERY HOST (cinatra#3062).
//
// The ratified drawing draws the Skills step as ONE chip-row and gives that row
// exactly one layout: `display:flex; flex-wrap:wrap; gap:8px`. §V reproduces the
// row from the run-and-review drawing rather than redrawing it — "The row is
// reproduced from Agent run & review §II" — so the SAME row, with the SAME
// layout, is what the chat and the widget draw. The card's chrome travels.
//
// WHAT IS PINNED HERE:
//
//   1. the row is a WRAPPING FLEX ROW with the drawing's own 8px gap — never a
//      grid, and never a column, on any host;
//   2. one pill per skill sits directly in that row, so nothing re-groups the
//      pills into columns of its own;
//   3. no pill carries a placeholder byline. That is a LAYOUT invariant as much
//      as a wording one: the drawing draws its rows on one line, and a
//      placeholder standing in for an absent vendor more than doubles a pill's
//      drawn width, which is what pushed the row onto a second line;
//   4. a pill has ONE ground, whether its box is set or clear. The drawing
//      declares `.skchip` once — `border: 1px solid var(--line); background:
//      var(--surface-strong)` — with no checked variant of it anywhere, and puts
//      its ONLY checked accent on the box: `.skchip .cbx.on { background:
//      var(--blue); border-color: var(--blue) }`;
//   5. Continue is seated in the drawing's own footer: `display:flex;
//      justify-content:flex-end; margin-top:12px; padding-top:12px; border-top:
//      1px solid var(--line)`, and the label carries a TRAILING ARROW GLYPH.
//
// Measured against the drawing's own stylesheet: at the width the chat draws the
// card at, four pills reading name-alone sit on ONE line, and the same four
// pills carrying a placeholder byline wrap onto two.
//
// WHAT THIS FILE CANNOT PROVE, said plainly. jsdom computes no layout, so these
// arms pin the layout the row DECLARES — the utilities it carries and the ones
// it must not — and not the pixels a browser lays out from them. A stylesheet
// that overrode those utilities, or an equivalent row authored in plain CSS
// instead, would read differently here. The one-line geometry itself is proved
// where geometry can be measured: the graded picture on this pull request. This
// file's job is that no host quietly re-declares the row as a grid or a column,
// and that no pill regains the placeholder width that pushed it off the line.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-step-row-is-the-drawings-chip-row.test.tsx
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

import { VENDOR_BY_CONNECTIVE, VENDOR_MISSING_LABEL } from "@/lib/vendor-presentation";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import {
  RunRecommendationChipRow,
  type RunRecommendationDecision,
} from "../run-recommendation-chip-row";

// The four skills the recorded pass of this card put on both hosts, each carried
// here with NO vendor.
//
// The absence is the FIXTURE'S, and it is deliberate: what this file measures is
// the row's geometry, and its third invariant is that a pill whose vendor does
// not resolve draws no placeholder standing in for one. Feeding the row a
// vendorless candidate is how that invariant is put under load, so the fixture
// keeps `vendorName: null` whatever the shipped packages declare. It is NOT a
// claim about these four packages: they declare their vendor identity in their
// own manifests, which is pinned where that identity is resolved, in
// `packages/skills/src/graded-skill-packages-declare-their-vendor.test.ts`, and
// drawn from a candidate carrying it in
// `skills-step-pill-names-its-vendor.test.tsx`.
const CANDIDATES = [
  { skillId: "@cinatra-ai/blog-image-matcher-skill:blog-image-matcher", name: "Blog Image Matcher Skill" },
  { skillId: "@cinatra-ai/blog-writing-skill:blog-writing", name: "Blog Writing Skill" },
  { skillId: "@cinatra-ai/brand-voice-matcher-skill:brand-voice-matcher", name: "Brand Voice Matcher Skill" },
  { skillId: "@cinatra-ai/web-research-skill:web-research", name: "Web Research Skill" },
].map((c, i) => ({
  ...c,
  vendorName: null,
  skillRevisionId: `${c.skillId}@1`,
  recommended: true,
  score: 0.8,
  rank: i + 1,
  scoredFeatures: [],
}));

// The SAME four skills with one box left clear, so a set pill and a clear pill
// are measured side by side in one row: the drawing gives them one ground.
const MIXED = CANDIDATES.map((c, i) => ({ ...c, recommended: i !== 1 }));

const HELD: RunRecommendationDecision = { kind: "pending" };

// EVERY host the row is drawn on — the four `SKILLS_CHECKLIST_HOSTS` the card
// itself declares, not a sample of them, so a host cannot keep a layout of its
// own by never being covered here. The drawing reproduces ONE row for all four.
const HOSTS = ["run_card", "page_gate_region", "chat_thread", "site_widget"] as const;

// The widget is not a cookie-session host: it MUST declare a broker credential
// with `credentials: "omit"`, or the provider fails closed and declares no host
// at all. That is the embed's own shape, and the row draws only under it.
const WIDGET_AUTH = {
  headers: () => ({ Authorization: "Bearer cit_site" }),
  credentials: "omit" as const,
};

function mount(host: (typeof HOSTS)[number], candidates = CANDIDATES) {
  return render(
    <LifecycleCardSurfaceProvider
      host={host}
      {...(host === "site_widget" ? { auth: WIDGET_AUTH } : {})}
    >
      <RunRecommendationChipRow
        runId="run-3062-chiprow"
        agentPackageName="@cinatra-ai/blog-draft-writer-agent"
        decision={HELD}
        holdRef="hold-ref-3062"
        initialRecommendations={candidates}
      />
    </LifecycleCardSurfaceProvider>,
  );
}

const list = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-skills-step-list]")!;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe.each(HOSTS)("the Skills step's row, on %s", (host) => {
  it("is the drawing's wrapping flex chip-row with its 8px gap — never a grid, never a column", () => {
    const { container } = mount(host);
    const cls = list(container).className.split(/\s+/);
    // The drawing's `.chiprow`: display:flex; flex-wrap:wrap; gap:8px.
    expect(cls).toContain("flex");
    expect(cls).toContain("flex-wrap");
    // gap-2 IS the drawing's 8px.
    expect(cls).toContain("gap-2");
    // Not a grid, and not turned on its side into a column.
    expect(cls).not.toContain("grid");
    expect(cls.some((c) => c.startsWith("grid-cols"))).toBe(false);
    expect(cls.some((c) => c.startsWith("flex-col"))).toBe(false);
  });

  it("puts ONE pill per skill directly in that row, with nothing re-grouping them", () => {
    const { container } = mount(host);
    const row = list(container);
    const pills = row.querySelectorAll("[data-skills-step-pill]");
    expect(pills).toHaveLength(CANDIDATES.length);
    // Directly in the row: each pill is a CHILD of it, not nested in a column
    // wrapper of the row's own making.
    for (const pill of Array.from(pills)) expect(pill.parentElement).toBe(row);
  });

  it("gives a set box and a clear one the SAME pill ground — the drawing draws no checked tint", () => {
    // `.skchip` is declared ONCE in the drawing and carries no checked variant:
    // one hairline `var(--line)` border over one `var(--surface-strong)` ground,
    // whichever way the box is set. The accent belongs to the box alone.
    const { container } = mount(host, MIXED);
    const pills = Array.from(
      list(container).querySelectorAll<HTMLElement>("[data-skills-step-pill]"),
    );
    expect(pills).toHaveLength(MIXED.length);
    // Both readings really are on screen, or this arm proves nothing.
    expect(new Set(pills.map((p) => p.getAttribute("data-skill-applied")))).toEqual(
      new Set(["true", "false"]),
    );
    // …and every one of them declares the same ground and the same border.
    const grounds = pills.map((p) =>
      p.className
        .split(/\s+/)
        .filter((c) => c.startsWith("bg-") || c.startsWith("border-"))
        .sort()
        .join(" "),
    );
    expect(new Set(grounds).size).toBe(1);
    for (const pill of pills) {
      const cls = pill.className.split(/\s+/);
      expect(cls).toContain("bg-surface-strong");
      expect(cls).toContain("border-line");
      // No accent of ANY kind on the pill itself — the measured defect was a
      // green ground and a green border on the set pill.
      expect(cls.some((c) => /-(success|blue|primary)(\/|$)/.test(c))).toBe(false);
    }
  });

  it("seats Continue in the drawing's right-aligned footer, over its hairline rule, with the trailing glyph", () => {
    // The drawing's own wrapper for this control:
    //   display:flex; justify-content:flex-end; margin-top:12px;
    //   padding-top:12px; border-top:1px solid var(--line)
    // …and the label reads `Continue` followed by an arrow glyph. The step's
    // root supplies the 12px margin as its own `gap-3`.
    const { container } = mount(host);
    const button = container.querySelector<HTMLElement>("[data-skills-step-continue]");
    expect(button).not.toBeNull();
    const floor = button!.parentElement!;
    const cls = floor.className.split(/\s+/);
    expect(cls).toContain("flex");
    expect(cls).toContain("justify-end");
    // The hairline rule the row is separated from, and the drawing's 12px above it.
    expect(cls).toContain("border-t");
    expect(cls).toContain("border-line");
    expect(cls).toContain("pt-3");
    // The 12px between the row and the rule is the step root's own gap.
    expect(floor.parentElement!.className.split(/\s+/)).toContain("gap-3");
    // The word, and then the glyph after it.
    expect(button!.textContent).toContain("Continue");
    const glyph = button!.querySelector("svg");
    expect(glyph).not.toBeNull();
    expect(button!.lastElementChild).toBe(glyph);
  });

  it("draws no placeholder byline, so each pill keeps the drawn width", () => {
    const { container } = mount(host);
    const row = list(container);
    expect(row.querySelectorAll("[data-skills-step-vendor]")).toHaveLength(0);
    expect(row.textContent).not.toContain(VENDOR_MISSING_LABEL);
    expect(row.textContent).not.toContain(VENDOR_BY_CONNECTIVE);
    // Every pill still names its skill.
    for (const c of CANDIDATES) expect(row.textContent).toContain(c.name);
  });
});

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
//      drawn width, which is what pushed the row onto a second line.
//
// Measured against the drawing's own stylesheet: at the width the chat draws the
// card at, four pills reading name-alone sit on ONE line, and the same four
// pills carrying a placeholder byline wrap onto two.
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

// The four skills the recorded pass of this card put on both hosts: every one of
// them is owned by a package that declares a display name and NO vendor.
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

const HELD: RunRecommendationDecision = { kind: "pending" };

// The hosts §V's row is drawn on. The drawing reproduces ONE row for all of them.
const HOSTS = ["run_card", "chat_thread", "site_widget"] as const;

// The widget is not a cookie-session host: it MUST declare a broker credential
// with `credentials: "omit"`, or the provider fails closed and declares no host
// at all. That is the embed's own shape, and the row draws only under it.
const WIDGET_AUTH = {
  headers: () => ({ Authorization: "Bearer cit_site" }),
  credentials: "omit" as const,
};

function mount(host: (typeof HOSTS)[number]) {
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
        initialRecommendations={CANDIDATES}
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

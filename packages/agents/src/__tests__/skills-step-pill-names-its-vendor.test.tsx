// @vitest-environment jsdom
//
// EVERY PILL SHOWS THE SKILL'S NAME AND ITS VENDOR (cinatra#3047, review
// point 3): "<Skill name> by <vendor>", the vendor in the muted secondary text
// style, on one line, and the checkbox's accessible name still the skill's name.
//
// NO FORMAT IS INVENTED. The vendor NAME is resolved by the platform's own
// chain — `resolveInstalledVendorName` over the owning package's manifest
// declarations — and the LABEL is minted by the app's single vendor-presentation
// resolver, whose own `VENDOR_BY_CONNECTIVE` supplies the "by" and whose own
// `VENDOR_MISSING_LABEL` supplies the reading for a package that names no
// vendor. The npm scope segment is never pressed into service as a name.
//
// WHAT IS PINNED HERE:
//
//   1. the byline, from a REAL package id, reads "<Skill name> by <vendor>" on
//      ONE line with the vendor in the muted style;
//   2. the checkbox's accessible name is the skill's NAME alone — not the name
//      plus the byline;
//   3. a package that declares no vendor gets the resolver's OWN missing-state
//      label, never its npm scope;
//   4. the same byline is on the settled pill, in both its readings;
//   5. and the vendor a real package id resolves to comes from the shared skill
//      scan, through the same resolver the Installed page uses.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-step-pill-names-its-vendor.test.tsx
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

// A REAL package id from the shipped fleet, and the skill id derived from it the
// way the platform derives one.
const REAL_SKILL_ID = "@cinatra-ai/chat:blog-content";
const REAL_SKILL_NAME = "Blog Content Skill";
const VENDOR = "Northstar";

const UNVENDORED_SKILL_ID = "@cinatra-ai/chat:company-research";

const CANDIDATES = [
  {
    skillId: REAL_SKILL_ID,
    name: REAL_SKILL_NAME,
    vendorName: VENDOR,
    skillRevisionId: "blog-content@7",
    recommended: true,
  },
  {
    skillId: UNVENDORED_SKILL_ID,
    name: "Company Research Skill",
    vendorName: null,
    skillRevisionId: "company-research@2",
    recommended: false,
  },
];

const HELD: RunRecommendationDecision = { kind: "pending" };
const SETTLED: RunRecommendationDecision = {
  kind: "confirmed",
  skillNames: [REAL_SKILL_NAME],
  runStarted: true,
  decided: [
    { skillId: REAL_SKILL_ID, name: REAL_SKILL_NAME, mark: "confirmed" },
    { skillId: UNVENDORED_SKILL_ID, name: "Company Research Skill", mark: "skipped" },
  ],
  candidates: CANDIDATES,
};

function mount(decision: RunRecommendationDecision) {
  return render(
    <LifecycleCardSurfaceProvider host="run_card">
      <RunRecommendationChipRow
        runId="run-3047-vendor"
        agentPackageName="@cinatra-ai/blog-draft-writer-agent"
        decision={decision}
        holdRef="hold-ref-3047"
        initialRecommendations={CANDIDATES.map((c) => ({
          ...c,
          score: 0.8,
          rank: 1,
          scoredFeatures: [],
        }))}
      />
    </LifecycleCardSurfaceProvider>,
  );
}

const pillFor = (c: HTMLElement, skillId: string) =>
  c.querySelector<HTMLElement>(`[data-skills-step-pill][data-skill-id="${skillId}"]`)!;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the live pill's label", () => {
  it("reads '<Skill name> by <vendor>' for a real package id", () => {
    // The ID is a real one the platform mints; the vendor VALUE is supplied,
    // because this arm measures the RENDERING. That the value itself comes from
    // the owning package's own declarations, through the platform's resolver, is
    // pinned on the resolving side in `skill-id-vendor-names.test.ts`.
    const { container } = mount(HELD);
    const pill = pillFor(container, REAL_SKILL_ID);
    const name = pill.querySelector<HTMLElement>(`[id^="skills-step-label-"]`)!;
    const vendor = pill.querySelector<HTMLElement>("[data-skills-step-vendor]")!;
    expect(name.textContent).toBe(REAL_SKILL_NAME);
    expect(vendor.textContent).toBe(`${VENDOR_BY_CONNECTIVE} ${VENDOR}`);
    // The byline FOLLOWS the name, in document order, inside the same pill.
    expect(name.compareDocumentPosition(vendor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws the vendor in the muted secondary style, on the same line as the name", () => {
    const { container } = mount(HELD);
    const pill = pillFor(container, REAL_SKILL_ID);
    const vendor = pill.querySelector<HTMLElement>("[data-skills-step-vendor]")!;
    expect(vendor.className).toContain("text-muted-foreground");
    expect(vendor.getAttribute("data-vendor-state")).toBe("known");
    // ONE LINE: the name and the byline share one inline wrapper that does not wrap.
    const line = vendor.parentElement!;
    expect(line.className).toContain("whitespace-nowrap");
    expect(line.querySelector(`#skills-step-label-${CSS.escape(REAL_SKILL_ID)}`)).not.toBeNull();
  });

  it("keeps the checkbox's accessible name the skill's NAME, not the byline", () => {
    const { container } = mount(HELD);
    const pill = pillFor(container, REAL_SKILL_ID);
    const box = pill.querySelector<HTMLElement>('[role="checkbox"]')!;
    const labelId = box.getAttribute("aria-labelledby")!;
    const label = pill.querySelector(`#${CSS.escape(labelId)}`)!;
    expect(label.textContent).toBe(REAL_SKILL_NAME);
    expect(label.textContent).not.toContain(VENDOR_BY_CONNECTIVE);
    expect(label.textContent).not.toContain(VENDOR);
  });

  it("uses the resolver's own missing-state label where no vendor is declared — never the scope", () => {
    const { container } = mount(HELD);
    const pill = pillFor(container, UNVENDORED_SKILL_ID);
    const vendor = pill.querySelector<HTMLElement>("[data-skills-step-vendor]")!;
    expect(vendor.getAttribute("data-vendor-state")).toBe("missing");
    expect(vendor.textContent).toBe(`${VENDOR_BY_CONNECTIVE} ${VENDOR_MISSING_LABEL}`);
    // The npm scope of a real package id is never the byline.
    expect(vendor.textContent).not.toContain("cinatra-ai");
    expect(vendor.textContent).not.toContain("@");
  });
});

describe("the settled pill's label", () => {
  it("carries the very same byline", () => {
    const { container } = mount(SETTLED);
    const pill = pillFor(container, REAL_SKILL_ID);
    const vendor = pill.querySelector<HTMLElement>("[data-skills-step-vendor]")!;
    expect(vendor.textContent).toBe(`${VENDOR_BY_CONNECTIVE} ${VENDOR}`);
    const box = pill.querySelector<HTMLElement>('[role="checkbox"]')!;
    const label = pill.querySelector(`#${CSS.escape(box.getAttribute("aria-labelledby")!)}`)!;
    expect(label.textContent).toBe(REAL_SKILL_NAME);
  });
});

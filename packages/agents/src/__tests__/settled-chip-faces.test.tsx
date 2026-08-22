// @vitest-environment jsdom
/**
 * PER-CHIP SETTLED FACES ARE UNCHANGED (cinatra#2893) — proven by NORMALIZED DOM
 * EQUALITY on the named settled cells, not by prose.
 *
 * #2893 adds a reading to the settled branch of `RunRecommendationChipRow`: a
 * row whose recorded set names no skill draws §V's outcome panel instead of
 * vanishing. The claim that rides beside it is that the per-chip settled faces
 * — the ones cinatra#2841 redrew and the ones every settled capture is graded
 * against — did not move. "We did not touch them" is an assertion about intent;
 * this file is an assertion about bytes.
 *
 * HOW THE BASELINE WAS PRODUCED, and why it is evidence rather than a snapshot
 * of the change under test. `__fixtures__/settled-chip-faces.baseline.json` was
 * rendered by the renderer AS IT STANDS ON THE TRUNK THIS BRANCH WAS CUT FROM,
 * with this file's own fixture, in this file's own environment. It is therefore
 * a record of the OLD behaviour, and the assertions below are the new renderer
 * being held to it. A self-recorded snapshot would agree with whatever the code
 * happens to do; this one cannot.
 *
 * WHAT "NORMALIZED" REMOVES, and what it deliberately keeps. Attribute ORDER is
 * sorted and runs of whitespace between tags are collapsed — both are artifacts
 * of how JSX happens to be written, and neither is visible to a reader. Class
 * names are KEPT verbatim, because the class list is where every token of the
 * face lives: the tint, the edge, the type scale and the spacing, in both
 * themes (the theme is carried by the token the class resolves to, so a face
 * that is identical here is identical in light and in dark). The mark label,
 * the skill name, the `data-chip-mark` and the element structure are kept for
 * the same reason.
 *
 * Run:
 *   cd packages/agents && npx vitest run src/__tests__/settled-chip-faces.test.tsx
 */
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "SlidersHorizontal", "X", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../server-actions", () => ({ getRunRecommendedSkillsAction: vi.fn(async () => []) }));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

afterEach(cleanup);

/**
 * THE NAMED SETTLED CELLS. One per mark §V draws on a settled chip, named the
 * way the design names them, so a failure says WHICH face moved.
 */
export const SETTLED_FIXTURE = [
  { skillId: "skill-enrich", name: "Enrich contacts", mark: "confirmed" as const },
  { skillId: "skill-draft", name: "Draft email", mark: "adjusted" as const },
  { skillId: "skill-send", name: "Schedule send", mark: "skipped" as const },
];

/** Sort attributes, collapse inter-tag whitespace. Classes are kept verbatim. */
export function normalizeFace(el: Element): string {
  const attrs = [...el.attributes]
    .map((a) => `${a.name}="${a.value}"`)
    .sort()
    .join(" ");
  const inner = el.innerHTML.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
  return `<${el.tagName.toLowerCase()} ${attrs}>${inner}</${el.tagName.toLowerCase()}>`;
}

export async function renderSettledFaces(): Promise<Record<string, string>> {
  const { RunRecommendationChipRow } = await import("../run-recommendation-chip-row");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  render(
    <LifecycleCardSurfaceProvider host="run_card">
      <RunRecommendationChipRow
        runId="run-2893"
        agentPackageName="@cinatra-test/hold-fixture-agent"
        decision={{
          kind: "confirmed",
          skillNames: ["Enrich contacts", "Draft email"],
          decided: SETTLED_FIXTURE,
        }}
      />
    </LifecycleCardSurfaceProvider>,
  );
  await waitFor(() =>
    expect(document.querySelectorAll("[data-recommendation-chip]")).toHaveLength(3),
  );
  const out: Record<string, string> = {};
  for (const cell of SETTLED_FIXTURE) {
    const el = document.querySelector(
      `[data-recommendation-chip][data-skill-id="${cell.skillId}"]`,
    );
    if (!el) throw new Error(`no settled cell for ${cell.skillId}`);
    out[`settled-${cell.mark}`] = normalizeFace(el);
  }
  // The card ROOT is part of the settled reading too: the capture contract
  // identifies a `recommendation_hold` capture by the three attributes it
  // carries, so a root that moved would break every settled capture on file.
  const root = document.querySelector("[data-run-recommendation-chip-row]");
  if (!root) throw new Error("no card root");
  out["settled-card-root"] = normalizeFace(root).replace(/>[\s\S]*<\//, "></");
  return out;
}

const BASELINE = JSON.parse(
  readFileSync(
    path.join(__dirname, "__fixtures__", "settled-chip-faces.baseline.json"),
    "utf8",
  ),
) as { note: string; faces: Record<string, string> };

describe("§V per-chip settled faces — unchanged by the zero-chip addition (cinatra#2893)", () => {
  it("reproduces the pre-change DOM of every named settled cell, byte for byte", async () => {
    const faces = await renderSettledFaces();
    expect(faces).toEqual(BASELINE.faces);
  });

  it("NEGATIVE CONTROL: the comparison can fail — a mutated face is caught", async () => {
    const faces = await renderSettledFaces();
    const mutated = { ...faces, "settled-skipped": faces["settled-skipped"]!.replace("Skipped", "Dropped") };
    expect(mutated).not.toEqual(BASELINE.faces);
    // …and the untouched cells still match, so the control isolates one face.
    expect(mutated["settled-confirmed"]).toEqual(BASELINE.faces["settled-confirmed"]);
  });

  it("covers every mark §V draws on a settled chip, plus the card root", () => {
    expect(Object.keys(BASELINE.faces).sort()).toEqual([
      "settled-adjusted",
      "settled-card-root",
      "settled-confirmed",
      "settled-skipped",
    ]);
  });
});

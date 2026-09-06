// @vitest-environment jsdom
//
// The All-Agents card's description clamps at THREE lines (cinatra#3227).
//
//   pnpm exec vitest run src/components/extensions/__tests__/agent-all-card-description-clamp-3227.test.tsx
//
// The ratified drawing (specs/app-extensions.html §IV, the All-Agents agent
// card): "The description is capped at three lines." The card passed
// `descriptionLineClamp={2}` to the shared InstalledExtensionCard, which elects
// `line-clamp-2`, so a third of what each agent says about itself was hidden
// on the one page where a person chooses between them.
//
// jsdom applies no stylesheet, so the two geometry items are pinned as the
// CONTRACT that produces them: Tailwind's `line-clamp-3` is
// `display:-webkit-box; -webkit-line-clamp:3; overflow:hidden` — the box is
// exactly three line-heights tall when the text runs longer (the fourth line is
// clipped), and it reserves NO height when the text is shorter, so a one-line
// description keeps its one-line box; neither the paragraph nor its panel may
// carry a fixed or minimum height that would add dead space. The rendered
// heights are read in the real DOM by the proof round on a dev boot.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { AgentAllCard, type AgentAllCardRow } from "@/components/extensions/agent-all-card";

// The §V detail modal is not under test; a stub keeps the render to the card.
vi.mock("@/components/extensions/agent-detail-modal", () => ({
  AgentDetailModal: () => null,
}));

afterEach(cleanup);

const LONG_DESCRIPTION =
  "Researches a company from the open web, reads its recent announcements, " +
  "compares them against the sales playbook, drafts a one-page brief for the " +
  "account owner, and files the sources it used so the brief can be checked " +
  "line by line before it is shared with the wider team.";

function row(description: string): AgentAllCardRow {
  return {
    key: "local:agent-1",
    name: "Company Research",
    description,
    host: "local",
    runHref: "/agents/company-research/new",
    packageName: null,
    detailHref: null,
    unavailable: null,
  };
}

function descriptionParagraph(description: string): HTMLParagraphElement {
  const { container } = render(<AgentAllCard row={row(description)} />);
  const p = Array.from(container.querySelectorAll("p")).find(
    (el) => el.textContent === description,
  );
  if (!p) throw new Error("the card rendered no description paragraph");
  return p;
}

// Every value a caller passes for `descriptionLineClamp` under src/ and
// packages/ (production sources only).
function clampCallSites(): Array<{ file: string; value: string }> {
  const ROOT = join(__dirname, "..", "..", "..", "..");
  const hits: Array<{ file: string; value: string }> = [];
  const SKIP = new Set(["node_modules", "__tests__", "dist", ".next", ".turbo"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".tsx")) {
        const src = readFileSync(full, "utf8");
        for (const m of src.matchAll(/descriptionLineClamp=\{(\d)\}/g)) {
          hits.push({ file: full.slice(ROOT.length + 1), value: m[1] });
        }
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "packages"));
  return hits;
}

describe("AgentAllCard — the description is capped at three lines (cinatra#3227)", () => {
  it("1. the description element carries the three-line clamp, not the two-line clamp", () => {
    const p = descriptionParagraph(LONG_DESCRIPTION);
    expect(p.classList.contains("line-clamp-3")).toBe(true);
    expect(p.classList.contains("line-clamp-2")).toBe(false);
  });

  it("2. a longer description clips at the fourth line — the clamp is the only height rule on the paragraph", () => {
    const p = descriptionParagraph(LONG_DESCRIPTION);
    // `line-clamp-3` is the sole rule bounding the box: three line-heights,
    // the fourth line clipped. No other utility may bound the paragraph.
    const bounding = Array.from(p.classList).filter((c) =>
      /^(line-clamp-|max-h-|h-|overflow-)/.test(c),
    );
    expect(bounding).toEqual(["line-clamp-3"]);
  });

  it("3. a one-line description reserves no dead space — no fixed or minimum height on the paragraph or its panel", () => {
    const p = descriptionParagraph("Runs a nightly check.");
    const panel = p.parentElement!;
    const reserved = [...Array.from(p.classList), ...Array.from(panel.classList)].filter((c) =>
      /^(min-h-|h-\[|h-\d|basis-)/.test(c),
    );
    expect(reserved).toEqual([]);
    // The clamp is a ceiling, not a floor: the same `line-clamp-3` box holds
    // one line at one line-height.
    expect(p.classList.contains("line-clamp-3")).toBe(true);
  });

  it("4. only the All-Agents card changed value — every other mount of the shared card keeps the clamp it passes today", () => {
    const sites = clampCallSites();
    expect(sites).toEqual([
      { file: "src/components/extensions/agent-all-card.tsx", value: "3" },
    ]);
    // The installed-extensions listing passes no clamp, so it keeps the shared
    // card's two-line default (pinned by installed-extension-card.test.tsx).
    const ROOT = join(__dirname, "..", "..", "..", "..");
    const listing = readFileSync(
      join(ROOT, "packages", "extensions", "src", "screens", "registry-catalog-screen.tsx"),
      "utf8",
    );
    expect(listing).not.toMatch(/descriptionLineClamp/);
    const shared = readFileSync(
      join(ROOT, "src", "components", "extensions", "installed-extension-card.tsx"),
      "utf8",
    );
    expect(shared).toMatch(/descriptionLineClamp = 2,/);
  });
});

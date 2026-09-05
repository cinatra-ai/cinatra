/**
 * A SUB-ROUTE TAB MIRRORS THE TRAIL'S LEAF (cinatra#2934, fix leg 9,
 * convergence round).
 *
 * The ratified drawing: "The browser-tab title mirrors the resolved trail under
 * the same rules: an id-bearing route never shows a raw id in the tab."
 *
 * Fix leg 9 gave every id-bearing route under the run a SERVER title taken from
 * the trail. On a sub-route that title is the sub-route's own word - the trail's
 * leaf, "Schedule" above the schedule surface. The client effect the previous
 * leg added still preferred the PUBLISHED instance label over the trail, and the
 * run layout publishes that label on mount; the effect therefore re-ran and
 * replaced the mirrored leaf with the run's name, so the trail read
 * "Agents > Blog Pipeline Agent (1) > Schedule" while the tab read
 * "Blog Pipeline Agent (1)". That is the very divergence this leg exists to
 * close, one route family over.
 *
 * The trail is asserted purely. The shell's own decision is asserted on its
 * source for the reason the sibling anchor suite records: what regresses here is
 * which helper the branch reaches for, and jsdom cannot measure the live
 * ordering that a capture measures.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildBreadcrumbTrail,
  documentTitleLabelFromTrail,
} from "@/lib/breadcrumb-trail";

const RUN_ID = "2494bd7d-c047-4d90-a8fc-b6ae154956fc";
const INSTANCE_PATH = `/agents/acme/blog-pipeline/${RUN_ID}`;
const PUBLISHED = [{ prefix: INSTANCE_PATH, label: "Blog Pipeline Agent (1)" }];

describe("the trail's leaf is the sub-route's own word, name published or not", () => {
  it.each([
    ["trigger", "Schedule"],
    ["results", "Results"],
    ["data", "Data"],
    ["permissions", "Permissions"],
    ["optimization", "Optimization"],
    ["skills", "Skills"],
  ])("%s reads %s", (subRoute, expected) => {
    const trail = buildBreadcrumbTrail(`${INSTANCE_PATH}/${subRoute}`, {
      contributions: PUBLISHED,
    });
    expect(trail.at(-1)?.label).toBe(expected);
    expect(documentTitleLabelFromTrail(trail)).toBe(expected);
  });

  // RE-PINNED (cinatra#2934, fix leg 10). The review is the ONE sub-route that
  // draws no crumb of its own: the ratified components drawing gives a review no
  // trail outside its run's route, so the trail's leaf — and therefore the tab —
  // is the RUN, not the word "Review".
  it("the review draws no crumb of its own: the leaf is the run, and so is the tab", () => {
    const trail = buildBreadcrumbTrail(`${INSTANCE_PATH}/review/task-1`, {
      contributions: PUBLISHED,
    });
    expect(trail.map((c) => c.label)).toEqual([
      "Agents",
      "Blog Pipeline Agent (1)",
    ]);
    expect(documentTitleLabelFromTrail(trail)).toBe("Blog Pipeline Agent (1)");
  });

  it("and on the run's own page the leaf is the published run name", () => {
    const trail = buildBreadcrumbTrail(INSTANCE_PATH, { contributions: PUBLISHED });
    expect(documentTitleLabelFromTrail(trail)).toBe("Blog Pipeline Agent (1)");
  });
});

describe("the shell writes the trail's leaf on a sub-route", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/components/app-shell.tsx"),
    "utf8",
  );

  it("reaches the trail-only helper where the leaf is not the instance crumb", () => {
    expect(source).toContain("documentTitleLabelFromTrail");
    // The published instance label may decide the tab ONLY where the instance
    // crumb IS the leaf - the run's own page, four segments.
    expect(source).toMatch(/segments\.length\s*>=\s*5[\s\S]{0,400}documentTitleLabelFromTrail/);
  });

  it("still guards the run page's own reading through the single helper", () => {
    expect(source).toContain("documentTitleLabelForAgentInstance");
  });
});

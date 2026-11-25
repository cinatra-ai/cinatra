/**
 * THE RUN FRAME STACKS BELOW 620 PX (cinatra#4738).
 *
 * Application Design, Agent run & review §I (specs/app-artifact-review.html):
 * "the step rail collapses and the run detail reflows beneath it as width
 * narrows". The reference render states the width:
 * `@media (max-width: 620px) { .runframe { grid-template-columns: minmax(0, 1fr); } }`.
 * Above 620 px the rail stays beside the detail, so the wide reading is unchanged.
 *
 * Every two-column run frame in the app is pinned here, by its source, because
 * the run page and the review page are server components that no jsdom render
 * reaches. The rendered orchestrator column is also pinned in
 * `run-page-rail-width-3241.test.tsx`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

/** The opening tag of every element whose tag text contains `marker`. */
function openingTags(src: string, marker: string): string[] {
  const tags: string[] = [];
  let at = src.indexOf(marker);
  while (at !== -1) {
    const start = src.lastIndexOf("<div", at);
    const end = src.indexOf(">", at);
    tags.push(src.slice(start, end + 1));
    at = src.indexOf(marker, at + marker.length);
  }
  return tags;
}

const STACKS = ["max-[620px]:flex-col", "max-[620px]:items-stretch"];

const FRAMES: Array<{ name: string; file: string; marker: string; count: number }> = [
  { name: "the run page (setup and schedule branches)", file: "packages/agents/src/instance-screens.tsx", marker: 'data-run-detail-contract=""', count: 2 },
  { name: "the review page", file: "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx", marker: 'data-run-detail-contract=""', count: 1 },
  { name: "the orchestrator panel's own rail", file: "packages/agents/src/orchestrator-stepper-panel.tsx", marker: 'data-run-frame=""', count: 1 },
];

describe("every two-column run frame stacks its detail beneath the rail at 620 px and below", () => {
  for (const { name, file, marker, count } of FRAMES) {
    it(name, () => {
      const tags = openingTags(read(file), marker);
      expect(tags).toHaveLength(count);
      for (const tag of tags) {
        expect(tag).toContain("flex items-start gap-6");
        for (const token of STACKS) expect(tag).toContain(token);
      }
    });
  }
});

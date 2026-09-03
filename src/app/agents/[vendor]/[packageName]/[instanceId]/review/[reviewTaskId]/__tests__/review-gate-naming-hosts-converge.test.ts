/**
 * THE HEADER'S NAMING LINE ON THE REVIEW SCREEN (cinatra#3080, PR #3100, fix
 * leg 7, added at convergence).
 *
 * The ratified card drawing puts a mono line beside the header word — the agent,
 * the run, and where the gated step sits. Fix leg 7 drew it and sourced it from
 * the run card's host only. The REVIEW SCREEN is the other first-party host, and
 * it is the surface the proof round grades: it mounted the same card with every
 * naming prop left to its null default, so the drawn line was absent exactly
 * where it is measured.
 *
 * Every segment this page hands down is one it ALREADY resolved for the rail on
 * its left — the same template read, the same step ladder, the same active
 * index — so the line and the rail cannot disagree, and a run whose template
 * cannot be read hands down null and the header draws the word alone.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROUTE = path.resolve(__dirname, "..");
const PAGE = readFileSync(path.join(ROUTE, "page.tsx"), "utf8");

/** Strip comments so an assertion matches real code, never a docstring. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PAGE_CODE = code(PAGE);

describe("the review screen names the gate the way the drawing draws it", () => {
  it("hands the card the agent it already read for the rail", () => {
    expect(PAGE_CODE).toMatch(/templateName\s*=\s*template\?\.name/);
    expect(PAGE_CODE).toContain("agentLabel={templateName}");
  });

  it("hands the card the step the rail on the same page is showing", () => {
    expect(PAGE_CODE).toMatch(
      /step=\{steps\.length > 0 \? \{ index: activeStep, total: steps\.length \} : null\}/,
    );
  });

  it("carries the naming down from the ONE context that resolves the rail", () => {
    // Not a second read of the run: the naming rides the context the rail is
    // built from, so the two readings cannot drift apart.
    expect(PAGE_CODE).toMatch(
      /const \{ steps, activeStep, templateId, templateName \} = await loadRunStepsContext/,
    );
  });

  it("names the run on the card, as the header's middle segment", () => {
    expect(PAGE_CODE).toContain("runId={runId}");
  });
});

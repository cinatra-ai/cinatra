// THE CHAT COMPLETION CARD IS DRAWN BY THE CORE'S REVIEW SHELL (cinatra#2729).
//
// A finished run's produced artifact appears in a conversation as part of the
// review lifecycle, and the core already ships what a review target looks like:
// `ReviewTargetPanel`, the review page's own component, which `ReviewGateCard`
// renders through its island on every first-party host ("it reuses the shipped
// review components, it does not restyle them"). The run-completion card's
// `review-lifecycle` presentation copies that shell rather than inventing one.
//
// A copy drifts. This is the anti-drift pin: it reads BOTH sources as text and
// fails the moment the canonical component's shell, header, title, type pill,
// identity line or body class changes without the copy following. Text, not
// import, on purpose — both files are client components with heavy graphs, and
// the thing under test is a string that must stay equal to another string.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** The core's review target — the component the review page has always used. */
const CANONICAL = path.join(
  REPO_ROOT,
  "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel.tsx",
);
/** The copy that draws a produced artifact in a conversation. */
const COPY = path.join(
  REPO_ROOT,
  "packages/agents/src/run-completion-affordances.tsx",
);

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** Every `className="…"` literal in a source file. */
function classLiterals(source: string): string[] {
  return Array.from(source.matchAll(/className="([^"]+)"/g)).map((m) => m[1]);
}

/** The value of an exported `const NAME = "…"` string. */
function exportedConst(source: string, name: string): string {
  const m = source.match(
    new RegExp(`export const ${name}\\s*=\\s*\\n?\\s*"([^"]+)"`),
  );
  if (!m) throw new Error(`${name} is not an exported string constant`);
  return m[1];
}

const canonicalSource = read(CANONICAL);
const copySource = read(COPY);
const canonicalClasses = classLiterals(canonicalSource);

describe("the review-target shell the chat completion card copies", () => {
  it("still exists on the canonical component, with its conformance anchor", () => {
    expect(canonicalSource).toContain('data-conformance-id="review-target"');
  });

  it.each([
    ["REVIEW_TARGET_SHELL_CLASS"],
    ["REVIEW_TARGET_HEADER_CLASS"],
    ["REVIEW_TARGET_TITLE_CLASS"],
    ["REVIEW_TARGET_TYPE_PILL_CLASS"],
    ["REVIEW_TARGET_BODY_CLASS"],
  ])("%s is byte-identical to a class the canonical component applies", (name) => {
    const value = exportedConst(copySource, name);
    expect(canonicalClasses).toContain(value);
  });

  it("keeps the identity line's class, allowing for its leading margin", () => {
    const value = exportedConst(copySource, "REVIEW_TARGET_IDENTITY_CLASS");
    expect(canonicalClasses).toContain(value);
  });

  it("draws the produced artifact under the same conformance anchor", () => {
    expect(copySource).toContain('data-conformance-id="review-target"');
  });

  it("labels the type through the core's own model, never a local map", () => {
    expect(copySource).toContain(
      'from "@/lib/artifacts/review-surface-model"',
    );
    expect(copySource).toContain("reviewTypeLabel(output.type)");
    expect(copySource).toContain("reviewRevisionMarker(");
  });

  it("leaves the run-detail presentation on the shipped panel card", () => {
    // The default must stay `panel`: this change is scoped to the conversation
    // surface, and the run page's card is #2482's, not this issue's.
    expect(copySource).toMatch(/presentation\s*=\s*"panel"/);
  });
});

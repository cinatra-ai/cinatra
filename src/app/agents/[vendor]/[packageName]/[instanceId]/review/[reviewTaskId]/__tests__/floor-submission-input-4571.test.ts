/**
 * ONE INPUT VALIDATOR FOR BOTH ENTRIES TO THE REVIEW DECISION (cinatra#3080 fold,
 * pre-review finding 6).
 *
 * The decision helper has two entries: the gate-scoped decide route, and the
 * review page's route-bound server action. The route bounded the note and the
 * Regenerate prompt; the page action took its input with no runtime check at
 * all, so a client calling the exposed action could send a 10,001-character
 * note or prompt the route refuses. Both entries now parse the SAME schema, and
 * neither file carries a number of its own.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The validator module is loaded in each case, not at the top of the file: on
// the tests commit, before the module exists, each case then fails on its own
// with the missing module as its reason instead of the whole file not loading.
const validator = () => import("../floor-submission-input");

const ROUTE_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(ROUTE_DIR, "..", "..", "..", "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PAGE = "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx";
const DECIDE_ROUTE = "src/app/api/lifecycle-views/decide/route.ts";

describe("the shared floor-submission validator", () => {
  it("bounds the note and the Regenerate prompt at the route's 10,000 characters", async () => {
    const { REVIEW_FLOOR_TEXT_MAX_CHARS, reviewFloorSubmissionInputSchema } = await validator();
    expect(REVIEW_FLOOR_TEXT_MAX_CHARS).toBe(10_000);
    const at = "x".repeat(REVIEW_FLOOR_TEXT_MAX_CHARS);
    const over = "x".repeat(REVIEW_FLOOR_TEXT_MAX_CHARS + 1);
    expect(reviewFloorSubmissionInputSchema.safeParse({ disposition: "comment", comment: at }).success).toBe(true);
    expect(reviewFloorSubmissionInputSchema.safeParse({ disposition: "regenerate", comment: "again", regeneratePrompt: at }).success).toBe(true);
    expect(reviewFloorSubmissionInputSchema.safeParse({ disposition: "comment", comment: over }).success).toBe(false);
    expect(reviewFloorSubmissionInputSchema.safeParse({ disposition: "regenerate", comment: "again", regeneratePrompt: over }).success).toBe(false);
  });

  it("refuses a disposition outside the floor's words and a non-string note", async () => {
    const { reviewFloorSubmissionInputSchema } = await validator();
    expect(reviewFloorSubmissionInputSchema.safeParse({ disposition: "delete", comment: null }).success).toBe(false);
    expect(reviewFloorSubmissionInputSchema.safeParse({ disposition: "comment", comment: { evil: true } }).success).toBe(false);
  });

  it("normalizes a partition the same way for both entries (absent stays absent)", async () => {
    const { reviewFloorSubmissionInputSchema, partitionFromFloorSubmissionInput } = await validator();
    const parsed = reviewFloorSubmissionInputSchema.parse({ disposition: "continue", comment: null, suggestionDecisions: { accepted: ["s1"] } });
    expect(partitionFromFloorSubmissionInput(parsed)).toEqual({ accepted: ["s1"], dismissed: [] });
    expect(partitionFromFloorSubmissionInput(reviewFloorSubmissionInputSchema.parse({ disposition: "comment", comment: null }))).toBeNull();
  });
});

describe("both entries parse the one validator", () => {
  it("the review page's server action parses its input before it reaches the decision helper", () => {
    const page = stripComments(read(PAGE));
    expect(page).toMatch(/from "\.\/floor-submission-input"/);
    const action = page.slice(page.indexOf("async function submitAction("), page.indexOf("const gateCardRef"));
    expect(action).toMatch(/reviewFloorSubmissionInputSchema\.safeParse\(/);
    expect(action.indexOf("safeParse(")).toBeLessThan(action.indexOf("submitReviewDecisionAction("));
  });

  it("the decide route builds its body from the same fields and carries no bound of its own", () => {
    const route = stripComments(read(DECIDE_ROUTE));
    expect(route).toMatch(/floor-submission-input"/);
    expect(route).not.toMatch(/10_000|10000/);
    expect(stripComments(read(PAGE))).not.toMatch(/10_000|10000/);
  });
});

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

// NO NEW COPY FOR THE BOUNDS REFUSAL (#4571 fold join). An over-bound note sent
// through the decide route is refused with a 400, and the card answers every
// non-2xx from that route with one existing sentence, as `not-permitted`. The
// page action answers the same refusal with that same outcome, so the same
// press reads the same on every host and no sentence exists only on the page.
describe("the page action's bounds refusal reuses the decide road's answer", () => {
  const CARD = "packages/agents/src/review-gate-card.tsx";
  const SURFACE_SENTENCE =
    "This decision could not be recorded on this surface. Open the review to continue.";

  it("the card answers a refused decide response with the existing sentence", () => {
    const card = read(CARD);
    const refused = card.slice(card.indexOf("if (!response.ok) {"), card.indexOf("return asSubmitOutcome("));
    expect(refused).toContain('kind: "not-permitted"');
    expect(refused).toContain(JSON.stringify(SURFACE_SENTENCE));
  });

  it("the shared refusal is that sentence, and the page action answers it as not-permitted", async () => {
    const { REVIEW_FLOOR_SUBMISSION_INVALID } = await import("../floor-submission-input");
    expect(REVIEW_FLOOR_SUBMISSION_INVALID).toBe(SURFACE_SENTENCE);
    const page = stripComments(read(PAGE));
    const action = page.slice(page.indexOf("async function submitAction("), page.indexOf("const gateCardRef"));
    expect(action).toMatch(/return \{ kind: "not-permitted", message: REVIEW_FLOOR_SUBMISSION_INVALID \}/);
  });

  it("the validator module carries no sentence of its own", () => {
    const own = stripComments(read(`${PAGE.slice(0, PAGE.lastIndexOf("/"))}/floor-submission-input.ts`));
    expect(own).not.toMatch(/could not be sent|characters\./);
  });
});

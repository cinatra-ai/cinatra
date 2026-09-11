/**
 * THE TRAIL ABOVE THE REVIEW IS THE RUN'S OWN (cinatra#2934, fix leg 10).
 *
 * The ratified components drawing gives a review no trail of its own: it is read
 * on its run's route, under that run's trail, so the crumb above it must name the
 * RUN — "Agents > Blog Draft Writer Agent (1)" — and never an id, never the fixed
 * "Agent run" label a genuinely unresolvable run falls back to, and never a
 * "Review" leaf.
 *
 * The run page's own tabs already publish that identity over the ONE crumb
 * channel; this route published nothing, which is why the trail above it fell
 * through to the placeholder. It publishes the same contribution now, from the
 * server, strictly AFTER its own access checks.
 *
 * Source-text conformance, the established pattern for this route (see
 * `review-surface-conformance.test.ts`): the repo's root vitest runs in a node
 * environment, and the LIVE reading is the graded proof round on the PR.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROUTE = path.resolve(__dirname, "..");
const PAGE = readFileSync(path.join(ROUTE, "page.tsx"), "utf8");

describe("the review route publishes its run's name for the trail", () => {
  it("mounts the crumb-contribution island", () => {
    expect(PAGE).toMatch(/CrumbContributions/);
  });

  it("publishes the run's own identity — its title, else its template's name", () => {
    expect(PAGE).toMatch(/run\.title\?\.trim\(\)/);
    expect(PAGE).toMatch(/readRunCrumbLabel/);
  });

  it("targets the RUN's crumb, not the review's own path", () => {
    expect(PAGE).toMatch(/agentInstancePathname/);
  });

  // CONVERGENCE ROUND (fix leg 10): the earlier form of this case only asserted
  // that both strings EXIST — it never compared them, and the bare module name
  // matched its own import line before any call site. It now pins the ordering
  // that matters: every read of the run's name happens after an access
  // decision, and the refusal path returns before the gated branch reads
  // anything at all.
  it("reads the run's name only after an access decision", () => {
    const gateCall = PAGE.indexOf("await loadReviewGateSurface(");
    const verificationCheck = PAGE.indexOf("if (!access.ok)");
    expect(gateCall).toBeGreaterThan(-1);
    expect(verificationCheck).toBeGreaterThan(-1);
    const reads = [...PAGE.matchAll(/await readRunCrumbLabel\(/g)].map(
      (m) => m.index ?? -1,
    );
    expect(reads.length).toBeGreaterThan(0);
    const earliestDecision = Math.min(gateCall, verificationCheck);
    for (const at of reads) expect(at).toBeGreaterThan(earliestDecision);
  });

  it("refuses before it reads — the gated branch returns the panel first", () => {
    const gateCall = PAGE.indexOf("await loadReviewGateSurface(");
    const refusal = PAGE.indexOf("return <ReviewNotAuthorizedPanel />", gateCall);
    const readAfterGate = [...PAGE.matchAll(/await readRunCrumbLabel\(/g)]
      .map((m) => m.index ?? -1)
      .find((at) => at > gateCall);
    expect(refusal).toBeGreaterThan(gateCall);
    expect(readAfterGate).toBeGreaterThan(refusal);
  });

  it("draws no hardcoded Agent run eyebrow and no Review crumb of its own", () => {
    expect(PAGE).not.toMatch(/label="Agent run"/);
    expect(PAGE).not.toMatch(/<PageHeader\b/);
  });
});

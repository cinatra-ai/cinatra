/**
 * Stale-gate CAS rejection translation (#811).
 *
 * approveReviewTaskInternal guards approvals with a
 * run.status === "pending_approval" compare-and-swap. A submit that lands
 * after the run already re-queued is rejected with a raw internal message
 * ("Setup approval rejected: run … is not pending_approval (current status:
 * queued)"), which previously rendered verbatim in the panel
 * (SchemaFieldRenderer.submitError on the rethrow path) while the stepper
 * kept a live Continue button and a stale "pending approval" badge.
 *
 * The panel must detect this rejection at ALL THREE approveReviewTask submit
 * sites (handleContinue, the grouped-setup inline submit, the setup-loop
 * fallback submit) and translate it into a friendly processing state
 * (spinner + toast) instead of surfacing the raw message or rolling back to
 * the stale form.
 *
 * Tested via source-text analysis — mounting the panel requires extensive SDK
 * mocking in jsdom; the structural assertions are equivalent and faster
 * (mirrors orchestrator-stepper-panel-generic-object.test.ts).
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/orchestrator-stepper-panel-stale-gate.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = readFileSync(
  join(__dirname, "..", "orchestrator-stepper-panel.tsx"),
  "utf8",
);

describe("orchestrator-stepper-panel — stale-gate CAS rejection translation (#811)", () => {
  it("declares an isStaleGateRejection helper whose pattern matches the server CAS messages", () => {
    const helperMatch = SRC.match(
      /function isStaleGateRejection\(message: string\): boolean \{\s*return (\/[^/]+\/i)\.test\(\s*message,?\s*\)/,
    );
    expect(helperMatch, "isStaleGateRejection helper must be declared").toBeTruthy();

    // Rebuild the regex from source and run it against the real server-side
    // rejection strings from review-task-actions.ts.
    const body = helperMatch![1].slice(1, -2); // strip leading "/" and trailing "/i"
    const pattern = new RegExp(body, "i");
    expect(
      pattern.test(
        "Setup approval rejected: run abc is not pending_approval (current status: queued)",
      ),
    ).toBe(true);
    expect(
      pattern.test(
        "WayFlow approval rejected: run abc is not pending_approval (status: running)",
      ),
    ).toBe(true);
    expect(
      pattern.test(
        "Setup approval rejected: run abc left pending_approval before the approval committed (concurrent transition)",
      ),
    ).toBe(true);
    // TERMINAL statuses must NOT classify as stale — no later SSE frame is
    // guaranteed to clear the processing spinner, so those stay on the
    // generic error path.
    expect(
      pattern.test(
        "Setup approval rejected: run abc is not pending_approval (current status: failed)",
      ),
    ).toBe(false);
    expect(
      pattern.test(
        "WayFlow approval rejected: run abc is not pending_approval (status: completed)",
      ),
    ).toBe(false);
    expect(
      pattern.test(
        "Setup approval rejected: run abc is not pending_approval (current status: stopped)",
      ),
    ).toBe(false);
    // Must NOT swallow unrelated failures.
    expect(pattern.test("Could not continue this run.")).toBe(false);
    expect(
      pattern.test('Setup approval rejected: fieldName "url" is not present in the submitted values'),
    ).toBe(false);
  });

  it("translates the stale-gate rejection at all three approveReviewTask submit sites", () => {
    // handleContinue + grouped-setup inline submit + setup-loop fallback
    // submit must each check isStaleGateRejection in their catch handling.
    const callSites = SRC.match(/isStaleGateRejection\((?:msg|m)\)/g) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(3);
  });

  it("shows the human-readable message instead of the raw CAS error", () => {
    expect(SRC).toMatch(/const STALE_GATE_MESSAGE =/);
    expect(SRC).toMatch(/toast\.info\(STALE_GATE_MESSAGE\)/);
  });

  it("keeps the processing spinner instead of rolling back to the stale form", () => {
    // The stale-gate branches must not invoke onApproveRejected (that would
    // re-present the stale form); the setup-loop fallback branch flips the
    // panel to the spinner via onApproved.
    const staleBranches = SRC.split(/isStaleGateRejection\((?:msg|m)\)\)? ?\{/).slice(1);
    for (const branch of staleBranches) {
      // Inspect only the branch body (up to the closing of its block —
      // approximated by the next "} else" or "return;/}").
      const body = branch.slice(0, branch.indexOf("}"));
      expect(body).not.toMatch(/onApproveRejected/);
    }
    // The setup-loop fallback path (which never calls onApproved on submit)
    // must flip to the spinner in its stale-gate branch.
    expect(SRC).toMatch(/onApproved\?\.\(\);\s*toast\.info\(STALE_GATE_MESSAGE\)/);
  });
});

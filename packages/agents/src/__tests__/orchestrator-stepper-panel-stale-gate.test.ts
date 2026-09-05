/**
 * The stale-gate rejection routes to the DRAWN blocked state (cinatra#3219,
 * superseding the message-matching translation of #811).
 *
 * The run surface already draws, and already ships, the state this refusal
 * degrades to: `ReviewGateBlocked` with `reason="no-longer-pending"` —
 * "This review is no longer open / The gate was already decided or the run
 * moved on.", with a Refresh back to the live gate. The ratified drawing fixes
 * it for exactly this case: "A gate that cannot be prepared or decided shows a
 * single blocked state naming the reason from the closed set: the gate is no
 * longer pending (already decided, or the run moved on) ... A blocked gate
 * offers a refresh back to the live gate; it never lets a stale decision
 * through."
 *
 * #811 detected the refusal by matching the thrown error's MESSAGE at each
 * submit site. Next.js masks a Server Action error's message in production, so
 * the match never fired there and the setup-field path rendered the masked
 * framework string verbatim through SchemaFieldRenderer's `submitError`. The
 * detection is now a typed outcome the action RETURNS, and every submit site
 * renders the shipped blocked state.
 *
 * Tested via source-text analysis — mounting either panel requires extensive
 * SDK mocking in jsdom; the structural assertions are equivalent and faster
 * (mirrors orchestrator-stepper-panel-generic-object.test.ts).
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/orchestrator-stepper-panel-stale-gate.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const read = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");
const STEPPER = read("orchestrator-stepper-panel.tsx");
const AGENTIC = read("agentic-run-panel.tsx");
const FIELDS = read("schema-field-renderer.tsx");

describe("no submit site detects this rejection from a message any more", () => {
  it("the message-matching helper and its copy are gone from the stepper panel", () => {
    expect(STEPPER).not.toMatch(/isStaleGateRejection/);
    expect(STEPPER).not.toMatch(/STALE_GATE_MESSAGE/);
  });

  it("neither panel pattern-matches the server's rejection text", () => {
    for (const src of [STEPPER, AGENTIC]) {
      expect(src).not.toMatch(/not pending_approval/);
      expect(src).not.toMatch(/left pending_approval/);
    }
  });
});

describe("the stepper panel's three submit sites route to the drawn blocked state", () => {
  it("branches on the action's typed outcome at all three sites", () => {
    const branches = STEPPER.match(/if \(!outcome\.ok\) \{/g) ?? [];
    expect(branches.length).toBeGreaterThanOrEqual(3);
    const setters = STEPPER.match(/setGateBlocked\(outcome\.blocked\)/g) ?? [];
    expect(setters.length).toBeGreaterThanOrEqual(3);
  });

  it("holds the blocked reason from the ratified closed set", () => {
    expect(STEPPER).toMatch(
      /useState<"no-longer-pending" \| null>\(null\)/,
    );
  });

  it("mounts the SHIPPED component — no duplicate markup or copy", () => {
    expect(STEPPER).toMatch(/import \{[\s\S]*?ReviewGateBlocked[\s\S]*?\} from "\.\/review-gate-states"/);
    expect(STEPPER).toMatch(/<ReviewGateBlocked reason=\{gateBlocked\}/);
    // The ratified copy lives in reviewBlockedCopy — never restated here.
    expect(STEPPER).not.toMatch(/This review is no longer open/);
  });

  it("clears the blocked state when a new gate opens", () => {
    expect(STEPPER).toMatch(/setGateBlocked\(null\)/);
  });
});

describe("the agentic panel's two submit sites route to the drawn blocked state", () => {
  it("performGateSubmit branches on the typed outcome instead of rethrowing", () => {
    expect(AGENTIC).toMatch(/if \(!outcome\.ok\) \{/);
    expect(AGENTIC).toMatch(/setGateBlocked\(outcome\.blocked\)/);
  });

  it("the blocked outcome returns BEFORE the errorMode rethrow", () => {
    // The setup-field submit runs with errorMode "rethrow"; the rethrow is the
    // path that reached SchemaFieldRenderer's submitError. The blocked outcome
    // is handled in the try, so that path is never entered for this rejection.
    const blockedAt = AGENTIC.indexOf("setGateBlocked(outcome.blocked)");
    const rethrowAt = AGENTIC.indexOf('if (args.errorMode === "rethrow") throw err;');
    expect(blockedAt).toBeGreaterThan(-1);
    expect(rethrowAt).toBeGreaterThan(-1);
    expect(blockedAt).toBeLessThan(rethrowAt);
  });

  it("mounts the SHIPPED component — no duplicate markup or copy", () => {
    expect(AGENTIC).toMatch(/import \{[\s\S]*?ReviewGateBlocked[\s\S]*?\} from "\.\/review-gate-states"/);
    expect(AGENTIC).toMatch(/<ReviewGateBlocked reason=\{gateBlocked\}/);
    expect(AGENTIC).not.toMatch(/This review is no longer open/);
  });

  it("clears the blocked state when a new gate opens", () => {
    expect(AGENTIC).toMatch(/setGateBlocked\(null\)/);
  });
});

describe("schema-field-renderer never renders a raw message for this rejection", () => {
  it("still renders submitError for genuine field errors (unchanged)", () => {
    expect(FIELDS).toMatch(/setSubmitError\(/);
  });

  it("but the panels never hand it this rejection: the outcome is data, not a throw", () => {
    // The only route into submitError is the rethrow above, and the blocked
    // outcome returns before it. Nothing in the renderer knows about the gate's
    // status, and nothing should: it never sees this rejection at all.
    expect(FIELDS).not.toMatch(/pending_approval/);
    expect(FIELDS).not.toMatch(/no-longer-pending/);
  });
});

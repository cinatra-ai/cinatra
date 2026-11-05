/**
 * Per-field setup gate advance must reset the HITL input buffer (#810).
 *
 * Sequential per-field setup interrupts all reuse the SAME xRenderer
 * (schema-field-fallback) and the setup loop emits the next INTERRUPT with no
 * RUN_STARTED/RESUME frame in between, so HitlApprovalCard never unmounts
 * between fields. Two identity keys must therefore include the interrupt's
 * `fieldName`, not just the xRenderer:
 *
 *   (a) the RendererComponent React key (the setup gate's identity, which
 *       also holds the review task, cinatra#3562) — otherwise the renderer instance
 *       (and its internal input state, e.g. SchemaFieldRenderer's localValue)
 *       survives the field advance and field 1's typed text pre-fills
 *       field 2 (observed: postTitle value submitted as blogPostUrl);
 *   (b) the bufferedHitlValue reset key (`bufferKey`) — otherwise AI-assist
 *       merges buffered for field 1 bleed into field 2's value/payload.
 *
 * Tested via source-text analysis — mounting the panel requires extensive SDK
 * mocking in jsdom; the structural assertions are equivalent and faster
 * (mirrors orchestrator-stepper-panel-generic-object.test.ts).
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/orchestrator-stepper-panel-field-advance-reset.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = readFileSync(
  join(__dirname, "..", "orchestrator-stepper-panel.tsx"),
  "utf8",
);

describe("orchestrator-stepper-panel — per-field setup advance resets input state (#810)", () => {
  it("keys the RendererComponent by xRenderer AND the interrupt fieldName", () => {
    // The renderer key must be a composite of xRenderer and fieldName so a
    // field→field advance under one shared xRenderer remounts the renderer.
    // An xRenderer-only key regresses to the carryover bug. The key is the
    // setup gate's identity, which holds the review task too (cinatra#3562),
    // so the renderer is drawn keyed by it through its validity owner.
    const drawn = SRC.match(/<GateValidityOwner\b([\s\S]*?)\/>/);
    expect(drawn, "the renderer must be drawn through GateValidityOwner").toBeTruthy();
    expect(drawn![1]).toMatch(/\brenderer=\{RendererComponent\}/);
    expect(drawn![1]).toMatch(/\bkey=\{setupGateKey\}/);
    expect(SRC).toMatch(/const setupGateKey = setupGateIdentity\(interruptContext\);/);
    const identity = SRC.match(/function setupGateIdentity\([\s\S]*?\{\s*return ([^;]*);/);
    expect(identity, "setupGateIdentity must be declared").toBeTruthy();
    expect(identity![1]).toBe('[gate.reviewTaskId, gate.xRenderer, gate.fieldName ?? ""].join("::")');
    // No renderer key may remain xRenderer-only.
    expect(SRC).not.toMatch(/key=\{interruptContext\.xRenderer\}/);
  });

  it("includes the interrupt fieldName in the buffered-value reset key", () => {
    // bufferKey drives the per-gate bufferedHitlValue reset. It must change
    // when the setup loop advances to the next field even though the
    // xRenderer stays the same.
    const bufferKeyMatch = SRC.match(/const bufferKey =([\s\S]*?);/);
    expect(bufferKeyMatch, "bufferKey must be declared").toBeTruthy();
    expect(bufferKeyMatch![1]).toMatch(/xRenderer/);
    expect(bufferKeyMatch![1]).toMatch(/fieldName/);
  });

  it("keeps the null-flicker guard on the buffer reset (non-null → non-null transitions only)", () => {
    // The reset must still only fire between two DISTINCT NON-NULL keys —
    // a transient null interruptContext (SSE flicker) must remain a no-op,
    // and the composite key must collapse to null when the context is null.
    expect(SRC).toMatch(/interruptContext != null\s*\?/);
    expect(SRC).toMatch(
      /bufferKey !== null &&\s*prevBufferKeyRef\.current !== null &&\s*prevBufferKeyRef\.current !== bufferKey/,
    );
  });
});

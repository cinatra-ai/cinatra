/**
 * Per-field setup gate advance must reset the HITL input buffer (#810).
 *
 * Sequential per-field setup interrupts all reuse the SAME xRenderer
 * (schema-field-fallback) and the setup loop emits the next INTERRUPT with no
 * RUN_STARTED/RESUME frame in between, so HitlApprovalCard never unmounts
 * between fields. Two identity keys must therefore include the interrupt's
 * `fieldName`, not just the xRenderer; both now read the gate's identity,
 * `hitlGateIdentityKey` (cinatra#3380), which also carries the review task:
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
import { hitlGateIdentityKey } from "../hitl-gate-submit";

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
    // An injective encoding of the three parts (cinatra#3562), never a separator
    // join: the gate's identity, the one gate key of every run surface (cinatra#3380).
    expect(identity![1]).toBe("hitlGateIdentityKey(gate)");
    // A field→field advance under one shared xRenderer and one review task
    // changes that key.
    const field = (fieldName: string) =>
      hitlGateIdentityKey({ reviewTaskId: "setup-run", xRenderer: "@pack:field", fieldName });
    expect(field("postTitle")).not.toBe(field("blogPostUrl"));
    // A later gate with the same renderer (another review task) changes it too,
    // so its renderer starts with no pick (cinatra#3035).
    const gate = (reviewTaskId: string) =>
      hitlGateIdentityKey({ reviewTaskId, xRenderer: "@pack:ideas", fieldName: null });
    expect(gate("task-1")).not.toBe(gate("task-2"));
    // No renderer key may remain xRenderer-only.
    expect(SRC).not.toMatch(/key=\{interruptContext\.xRenderer\}/);
  });

  it("includes the interrupt fieldName in the buffered-value reset key", () => {
    // bufferKey drives the per-gate bufferedHitlValue reset. It must change
    // when the setup loop advances to the next field even though the
    // xRenderer stays the same.
    const bufferKeyMatch = SRC.match(/const bufferKey =([\s\S]*?);/);
    expect(bufferKeyMatch, "bufferKey must be declared").toBeTruthy();
    expect(bufferKeyMatch![1]).toMatch(/hitlGateIdentityKey\(interruptContext\)/);
    // That key changes with the renderer, the field and the review task
    // (cinatra#3562): a gate of another task with the same renderer and field
    // starts with an empty buffer.
    const key = (reviewTaskId: string, xRenderer: string, fieldName?: string) =>
      hitlGateIdentityKey({ reviewTaskId, xRenderer, fieldName });
    expect(key("t", "@pack:a", "f")).not.toBe(key("t", "@pack:b", "f"));
    expect(key("t", "@pack:a", "f")).not.toBe(key("t", "@pack:a", "g"));
    expect(key("t", "@pack:a", "f")).not.toBe(key("t2", "@pack:a", "f"));
    expect(key("t", "@pack:list-picker")).not.toBe(key("t2", "@pack:list-picker"));
  });

  it("keeps the null-flicker guard on the buffer reset (non-null → non-null transitions only)", () => {
    // The reset must still only fire between two DISTINCT NON-NULL keys —
    // a transient null interruptContext (SSE flicker) must remain a no-op,
    // and the composite key must collapse to null when the context is null.
    expect(SRC).toMatch(/interruptContext != null\s*\?/);
    expect(SRC).toMatch(/if \(bufferKey !== null && bufferKey !== prevBufferKey\) \{/);
    expect(SRC).toMatch(/if \(prevBufferKey !== null && Object\.keys\(bufferedHitlValue\)\.length > 0\) \{/);
    // One reset, in render (cinatra#3380, cinatra#3562): the clear sits inside the
    // non-null transition, the previous key moves in one place only, and the
    // clear is not deferred past the render.
    expect(SRC).toMatch(
      /if \(bufferKey !== null && bufferKey !== prevBufferKey\) \{\s*setPrevBufferKey\(bufferKey\);[\s\S]{0,200}?if \(prevBufferKey !== null && Object\.keys\(bufferedHitlValue\)\.length > 0\) \{\s*setBufferedHitlValue\(\{\}\);/,
    );
    expect(SRC.match(/setPrevBufferKey\(/g) ?? []).toHaveLength(1);
    expect(SRC).not.toMatch(/queueMicrotask\(\(\) => setBufferedHitlValue/);
  });
});

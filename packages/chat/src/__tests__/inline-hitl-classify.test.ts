/**
 * The chat-side inline HITL gate REGISTRY.
 *
 * AMENDED for cinatra#2934 (lifecycle-b W5c). This file used to cover four
 * things: the deterministic gate classifier (`classifyPromptForGate`), the
 * required-field policy of the hidden second model that guessed when the
 * classifier could not (`resolveExtractedGateValues`), the routing arm that
 * reached them (`resolveComposerRouting`), and this registry. The first three
 * are RETIRED with their code — the plan's replacement table, row three:
 * "The guesswork that read a form value out of your sentence, and the second,
 * hidden model that guessed when the guessing failed" → "The HITL screen lends
 * its own fill and submit controls." Their cases are removed rather than
 * rewritten, because the behaviour they pinned no longer exists anywhere: no
 * page reads a sentence before the assistant sees it.
 *
 * WHAT SURVIVES IS THE REGISTRY, and its rules are unchanged. It is not a
 * reader: it records WHICH run has a screen open so the composer can name that
 * run in its message. The cases below are the ones this file always had for it,
 * character for character.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createChatGateRegistry } from "../inline-hitl-classify";

// ---------------------------------------------------------------------------
// createChatGateRegistry (cinatra#853) — the runId-keyed inline-gate registry
// split out of chat-page.tsx.
// ---------------------------------------------------------------------------
describe("createChatGateRegistry", () => {
  const makeGate = (runId: string, instanceId: string) =>
    ({ runId, instanceId } as unknown as Parameters<
      ReturnType<typeof createChatGateRegistry>["handleActiveGateChange"]
    >[1] & { runId: string; instanceId: string });

  it("registers gates and returns the most-recently-registered one", () => {
    const reg = createChatGateRegistry();
    expect(reg.getLatestOpenGate()).toBeUndefined();
    reg.handleActiveGateChange("run-1", makeGate("run-1", "i1"), "i1");
    reg.handleActiveGateChange("run-2", makeGate("run-2", "i2"), "i2");
    expect(reg.getLatestOpenGate()?.runId).toBe("run-2");
  });

  it("re-registering an existing runId keeps its original insertion position", () => {
    const reg = createChatGateRegistry();
    reg.handleActiveGateChange("run-1", makeGate("run-1", "i1"), "i1");
    reg.handleActiveGateChange("run-2", makeGate("run-2", "i2"), "i2");
    // Map.set on an existing key does NOT move it to the end.
    reg.handleActiveGateChange("run-1", makeGate("run-1", "i1b"), "i1b");
    expect(reg.getLatestOpenGate()?.runId).toBe("run-2");
  });

  it("clears a gate only when the SAME instance unregisters (remount guard)", () => {
    const reg = createChatGateRegistry();
    reg.handleActiveGateChange("run-1", makeGate("run-1", "new-instance"), "new-instance");
    // An OLDER instance's unmount must not clobber the remounted card's gate.
    reg.handleActiveGateChange("run-1", null, "old-instance");
    expect(reg.getLatestOpenGate()?.runId).toBe("run-1");
    // The live instance's clear removes it.
    reg.handleActiveGateChange("run-1", null, "new-instance");
    expect(reg.getLatestOpenGate()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// THE READERS ARE GONE, and this case is what says so (cinatra#2934).
//
// A structural assertion rather than a behavioural one, because the behaviour
// it guards is an ABSENCE: no module on the chat page may export a function
// that reads a typed sentence and turns it into a gate submit. A future
// re-introduction would have to delete this case to pass, which is exactly the
// visibility a removed reader deserves.
// ---------------------------------------------------------------------------
describe("the pre-model gate readers", () => {
  it("no longer exist on this module", async () => {
    const mod = (await import("../inline-hitl-classify")) as Record<string, unknown>;
    expect(mod.classifyPromptForGate).toBeUndefined();
    expect(mod.resolveExtractedGateValues).toBeUndefined();
    expect(mod.resolveComposerRouting).toBeUndefined();
  });

  it("and the hidden second model's server action no longer exists either", () => {
    // READ, not imported: `actions.ts` is a `"use server"` module and pulling it
    // into a unit test would drag the whole server graph in. What matters is
    // that the declaration is gone from the source, together with the
    // deterministic-task call it made.
    const src = readFileSync(
      join(import.meta.dirname, "..", "actions.ts"),
      "utf8",
    );
    expect(src).not.toContain("export async function extractHitlGateValuesAction");
    expect(src).not.toContain("runDeterministicLlmTask");
  });
});

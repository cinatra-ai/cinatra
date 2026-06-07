import { describe, expect, it } from "vitest";

import type { OrchestrateStreamInput } from "../types";
import {
  UAT_SENTINEL,
  assertScriptedProviderNotProduction,
  isScriptedTestProviderEnabled,
  runScriptedStream,
} from "../scripted-test-provider";

type Captured = {
  text: string;
  toolResults: Array<{ name: string; result: string }>;
  steps: { start: number[]; end: number[] };
  errors: Error[];
};

function makeInput(
  system: string,
  userText: string,
): { input: OrchestrateStreamInput; captured: Captured } {
  const captured: Captured = { text: "", toolResults: [], steps: { start: [], end: [] }, errors: [] };
  const input = {
    system,
    messages: [{ role: "user", content: userText }],
    onTextDelta: (d: string) => { captured.text += d; },
    onToolCall: () => {},
    onToolResult: (r: { name: string; result: string }) => { captured.toolResults.push(r); },
    onStepStart: (s: number) => { captured.steps.start.push(s); },
    onStepEnd: (s: number) => { captured.steps.end.push(s); },
    onError: (e: Error) => { captured.errors.push(e); },
  } as unknown as OrchestrateStreamInput;
  return { input, captured };
}

describe("scripted-test-provider", () => {
  it("isScriptedTestProviderEnabled reflects the env flag", () => {
    expect(isScriptedTestProviderEnabled({ CINATRA_TEST_LLM_PROVIDER: "scripted" })).toBe(true);
    expect(isScriptedTestProviderEnabled({})).toBe(false);
    expect(isScriptedTestProviderEnabled({ CINATRA_TEST_LLM_PROVIDER: "openai" })).toBe(false);
  });

  it("assertScriptedProviderNotProduction allows ONLY an explicit development runtime when enabled", () => {
    const msg = /must NEVER run outside development/;
    // enabled + explicit development → the only allowed case
    expect(() =>
      assertScriptedProviderNotProduction({ CINATRA_TEST_LLM_PROVIDER: "scripted", CINATRA_RUNTIME_MODE: "development" }),
    ).not.toThrow();
    // enabled + production runtime → throw
    expect(() =>
      assertScriptedProviderNotProduction({ CINATRA_TEST_LLM_PROVIDER: "scripted", CINATRA_RUNTIME_MODE: "production" }),
    ).toThrow(msg);
    // enabled + UNSET runtime mode → throw (allow-list, not deny-list)
    expect(() =>
      assertScriptedProviderNotProduction({ CINATRA_TEST_LLM_PROVIDER: "scripted" }),
    ).toThrow(msg);
    // enabled + development runtime BUT NODE_ENV=production → throw
    expect(() =>
      assertScriptedProviderNotProduction({ CINATRA_TEST_LLM_PROVIDER: "scripted", CINATRA_RUNTIME_MODE: "development", NODE_ENV: "production" }),
    ).toThrow(msg);
    // not enabled → no-op regardless of runtime
    expect(() =>
      assertScriptedProviderNotProduction({ CINATRA_RUNTIME_MODE: "production" }),
    ).not.toThrow();
  });

  it("streams a sentinel-bearing reply for a plain WordPress prompt (no tool result)", async () => {
    const { input, captured } = makeInput(
      "Current WordPress context:\n- instanceId: wp-prod\n- postId: 42\n",
      "Hello, what can you do?",
    );
    await runScriptedStream(input);
    expect(captured.text).toContain(UAT_SENTINEL);
    expect(captured.text).toContain("WordPress");
    expect(captured.toolResults).toHaveLength(0);
    expect(captured.steps.start).toEqual([1]);
    expect(captured.steps.end).toEqual([1]);
    expect(captured.errors).toHaveLength(0);
  });

  it("emits a wordpress_content_editor_run tool result with postId on an edit-intent prompt", async () => {
    const { input, captured } = makeInput(
      "Current WordPress context:\n- instanceId: wp-prod\n- postId: 42\n",
      "Please rewrite the title to be punchier.",
    );
    await runScriptedStream(input);
    expect(captured.toolResults).toHaveLength(1);
    expect(captured.toolResults[0].name).toBe("wordpress_content_editor_run");
    const parsed = JSON.parse(captured.toolResults[0].result);
    expect(parsed.postId).toBe("42");
    expect(Array.isArray(parsed.changes)).toBe(true);
    expect(parsed.changes[0]).toMatchObject({ field: "title" });
  });

  it("emits a drupal_content_editor_run tool result with nodeId for Drupal context", async () => {
    const { input, captured } = makeInput(
      "Current Drupal context:\n- instanceId: drupal-prod\n- nodeId: 7\n",
      "Add a short summary.",
    );
    await runScriptedStream(input);
    expect(captured.toolResults).toHaveLength(1);
    expect(captured.toolResults[0].name).toBe("drupal_content_editor_run");
    const parsed = JSON.parse(captured.toolResults[0].result);
    expect(parsed.nodeId).toBe("7");
  });
});

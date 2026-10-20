/**
 * The scripted bridge completion answers an EMPTY code in a step's top-level
 * `error` output.
 *
 * A bridge step answers a failure with a non-empty `error.code`, and the bridge
 * ends such a step failed unless the step lists the code as completed
 * (`src/app/api/llm-bridge/route.ts`, readDeclaredStepFailure). The scripted
 * completion stands in for a SUCCESSFUL model answer, but it used to fill the
 * code like every other string leaf (with the sentinel), so every scripted run
 * of a step that declares an `error` output would have ended failed.
 *
 * Only that one leaf changes: the error's other members, an `error` member
 * nested below the top level, and a `code` outside `error` keep the sentinel.
 */
import { describe, it, expect } from "vitest";

import { UAT_SENTINEL, runScriptedBridgeCompletion } from "../scripted-test-provider";

const DEV_ENV = {
  CINATRA_TEST_LLM_PROVIDER: "scripted",
  CINATRA_RUNTIME_MODE: "development",
  NODE_ENV: "test",
};

const ERROR_OUTPUT = {
  type: "object",
  required: ["code", "message"],
  properties: { code: { type: "string" }, message: { type: "string" } },
};

function answer(outputSchema: Record<string, unknown>): Record<string, unknown> {
  const response = runScriptedBridgeCompletion({ user: "read the page", outputSchema }, DEV_ENV);
  return JSON.parse(response.text) as Record<string, unknown>;
}

describe("runScriptedBridgeCompletion and a step's error output", () => {
  it("answers an empty code in the top-level error output", () => {
    const out = answer({
      type: "object",
      required: ["title", "error"],
      properties: { title: { type: "string" }, error: ERROR_OUTPUT },
    });
    expect(out.error).toEqual({ code: "", message: `${UAT_SENTINEL}: scripted message` });
    expect(String(out.title)).toContain(UAT_SENTINEL);
  });

  it("answers an empty code when the error output names no required members", () => {
    const out = answer({
      type: "object",
      properties: {
        error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
      },
    });
    expect((out.error as { code?: unknown }).code).toBe("");
  });

  it("keeps the sentinel in a code outside the top-level error output", () => {
    const out = answer({
      type: "object",
      required: ["code", "page"],
      properties: {
        code: { type: "string" },
        page: {
          type: "object",
          required: ["error"],
          properties: { error: ERROR_OUTPUT },
        },
      },
    });
    expect(String(out.code)).toContain(UAT_SENTINEL);
    const nested = (out.page as { error: { code: unknown } }).error;
    expect(String(nested.code)).toContain(UAT_SENTINEL);
  });
});

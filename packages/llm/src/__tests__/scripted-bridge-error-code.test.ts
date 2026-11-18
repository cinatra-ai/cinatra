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
 * And it changes only where the code's own declaration allows "": a `const`
 * or `enum` code keeps its declared value.
 * "Top-level" is logical: a `oneOf` / `anyOf` / `allOf` wrapper around the root
 * or around the `error` member adds no level.
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

  // A union wrapper adds no level to the answer: an `error` member of a root
  // union, or an `error` object wrapped in a union, is still top-level.
  it("answers an empty code in an error output of a root union", () => {
    for (const union of ["oneOf", "anyOf", "allOf"]) {
      const out = answer({
        [union]: [
          {
            type: "object",
            required: ["title", "error"],
            properties: { title: { type: "string" }, error: ERROR_OUTPUT },
          },
        ],
      });
      expect(out.error).toEqual({ code: "", message: `${UAT_SENTINEL}: scripted message` });
      expect(String(out.title)).toContain(UAT_SENTINEL);
    }
  });

  it("answers an empty code in a union-wrapped error object, and keeps the sentinel below it", () => {
    const out = answer({
      anyOf: [
        {
          type: "object",
          required: ["error", "page", "pages"],
          properties: {
            error: { oneOf: [{ allOf: [ERROR_OUTPUT] }, { type: "null" }] },
            page: {
              anyOf: [{ type: "object", required: ["error"], properties: { error: ERROR_OUTPUT } }],
            },
            pages: {
              type: "array",
              items: { type: "object", required: ["error"], properties: { error: ERROR_OUTPUT } },
            },
          },
        },
      ],
    });
    expect(out.error).toEqual({ code: "", message: `${UAT_SENTINEL}: scripted message` });
    // A genuinely nested `error` keeps the sentinel, union-wrapped or not.
    const nested = (out.page as { error: { code: unknown } }).error;
    expect(String(nested.code)).toContain(UAT_SENTINEL);
    const item = (out.pages as Array<{ error: { code: unknown } }>)[0].error;
    expect(String(item.code)).toContain(UAT_SENTINEL);
  });
});

// The empty code is written only where the code's own declaration allows "":
// a code declared with a `const` or an `enum`, or with a bound the empty
// string fails, keeps the value the scripted completion gave it, so the
// answer never leaves the caller's schema.
describe("runScriptedBridgeCompletion keeps an error code its schema pins", () => {
  function errorCode(code: Record<string, unknown>): unknown {
    const out = answer({
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: { code, message: { type: "string" } },
        },
      },
    });
    return (out.error as { code?: unknown }).code;
  }

  it("keeps a const code", () => {
    expect(errorCode({ type: "string", const: "page_unreadable" })).toBe("page_unreadable");
  });

  it("keeps the first member of an enum code", () => {
    expect(errorCode({ type: "string", enum: ["page_unreadable", "page_missing"] })).toBe(
      "page_unreadable",
    );
  });

  it("keeps a const code behind a union wrapper", () => {
    expect(errorCode({ anyOf: [{ const: "page_unreadable" }, { type: "string" }] })).toBe(
      "page_unreadable",
    );
  });

  it("keeps the scripted code when minLength or pattern refuses the empty string", () => {
    expect(String(errorCode({ type: "string", minLength: 1 }))).toContain(UAT_SENTINEL);
    expect(String(errorCode({ type: "string", pattern: "^[a-z_]+$" }))).toContain(UAT_SENTINEL);
  });

  it("answers the empty code when the declaration allows it", () => {
    expect(errorCode({ type: "string", enum: ["page_unreadable", ""] })).toBe("");
    expect(errorCode({ const: "" })).toBe("");
    expect(errorCode({ type: "string", minLength: 0, pattern: "^[a-z_]*$" })).toBe("");
    expect(errorCode({ type: ["string", "null"] })).toBe("");
  });

  it("leaves a code that is not a string as declared", () => {
    expect(errorCode({ type: "integer" })).toBe(0);
    expect(errorCode({ const: 404 })).toBe(404);
  });
});

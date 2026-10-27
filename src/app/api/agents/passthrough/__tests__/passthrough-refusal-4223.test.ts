/**
 * cinatra#4223 — THE PASSTHROUGH'S FAILURE-TEXT ALLOW-LIST.
 *
 * Only a primitive's stated refusal (PrimitiveInvocationError) and an
 * input-schema error (ZodError) keep their own text; every other throw answers
 * a fixed sentence and logs its detail on the server. The module is new in
 * this change, so on the base this file fails at its import.
 *
 *   npx vitest run src/app/api/agents/passthrough/__tests__/passthrough-refusal-4223.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z, ZodError } from "zod";
import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";

import {
  PASSTHROUGH_ACTOR_CONTEXT_ERROR,
  PASSTHROUGH_UNEXPECTED_ERROR,
  isCallerFacingError,
  isZodError,
  passthroughFailureText,
} from "../passthrough-refusal";

const CTX = { tool: "objects_save", runId: "run-1", stage: "tool call" };
// Assembled at runtime so no committed line carries a complete scheme,
// userinfo and host literal for a secret scanner to trip on; the
// string the tests use is unchanged.
const PG_URL = ["postgres:", "", "svc:hunter2@db.internal:5432"].join("/");
const SECRET = `relation "cinatra"."objects" at ${PG_URL}`;

let logged: MockInstance<typeof console.error>;
beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logged.mockRestore();
});

function realZodError(): ZodError {
  const parsed = z.object({ objectId: z.string() }).safeParse({});
  if (parsed.success) throw new Error("unreachable");
  return parsed.error;
}

describe("cinatra#4223 — passthroughFailureText", () => {
  it("a primitive's stated refusal keeps its own text", () => {
    const err = new PrimitiveInvocationError({
      code: "OBJECTS_TYPE_NOT_REGISTERED",
      message: "the type is not registered",
      retryable: false,
    });
    expect(passthroughFailureText(err, CTX)).toBe("the type is not registered");
    expect(logged).not.toHaveBeenCalled();
  });

  it("an input-schema error keeps its own text", () => {
    const err = realZodError();
    expect(isZodError(err)).toBe(true);
    expect(passthroughFailureText(err, CTX)).toBe(err.message);
  });

  it("a plain Error answers the fixed sentence and logs its detail", () => {
    expect(passthroughFailureText(new Error(SECRET), CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(JSON.stringify(logged.mock.calls)).toContain("hunter2");
  });

  it("a thrown non-Error value answers the fixed sentence", () => {
    expect(passthroughFailureText(SECRET, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(passthroughFailureText({ message: SECRET }, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(passthroughFailureText(undefined, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
  });

  it("an Error that only carries an allowed name is not let through", () => {
    const fakePrimitive = Object.assign(new Error(SECRET), { name: "PrimitiveInvocationError" });
    const fakeZod = Object.assign(new Error(SECRET), { name: "ZodError", issues: [] });
    expect(isCallerFacingError(fakePrimitive)).toBe(false);
    expect(isCallerFacingError(fakeZod)).toBe(false);
    expect(passthroughFailureText(fakePrimitive, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(passthroughFailureText(fakeZod, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
  });

  it("reads zod's own trait, so a plain Error is never taken for a schema error", () => {
    expect(isZodError(new Error(SECRET))).toBe(false);
    expect(isZodError(Object.assign(new Error(SECRET), { issues: [] }))).toBe(false);
    expect(realZodError()).toBeInstanceOf(ZodError);
  });

  it("answers the fixed text the caller names for its stage", () => {
    expect(
      passthroughFailureText(new Error(SECRET), { ...CTX, stage: "actor context" }, PASSTHROUGH_ACTOR_CONTEXT_ERROR),
    ).toBe(PASSTHROUGH_ACTOR_CONTEXT_ERROR);
  });
});

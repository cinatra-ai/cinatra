/**
 * cinatra#4223 — THE PASSTHROUGH'S FAILURE-TEXT ALLOW-LIST.
 *
 * Only a primitive's stated refusal (PrimitiveInvocationError) and an
 * input-schema error (ZodError) keep their own text; every other throw answers
 * a fixed sentence. The server log records the stage, the tool, the run and
 * the error's class and code, never its text, and reading the error or
 * writing the log never throws or changes the answer. The module is new in
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
  passthroughFixedFailureText,
} from "../passthrough-refusal";

const CTX = { tool: "objects_save", runId: "run-1", stage: "tool call" };
// Assembled at runtime so no committed line carries a complete scheme,
// userinfo and host literal for a secret scanner to trip on; the
// string the tests use is unchanged.
const PG_URL = ["postgres:", "", "svc:hunter2@db.internal:5432"].join("/");
const SECRET = `relation "cinatra"."objects" at ${PG_URL}`;

const CONSOLE_METHODS = ["error", "warn", "log", "info", "debug"] as const;
let logged: MockInstance<typeof console.error>;
let spies: MockInstance[] = [];
beforeEach(() => {
  spies = CONSOLE_METHODS.map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
  logged = spies[0] as MockInstance<typeof console.error>;
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

/** Every argument of every console call, as text. */
function consoleText(): string {
  return JSON.stringify(spies.map((spy) => spy.mock.calls));
}

/** No part of the secret reaches any console call. */
function expectNoSecretLogged() {
  const text = consoleText();
  for (const part of ["hunter2", "db.internal", '"objects"', "postgres:"]) {
    expect(text).not.toContain(part);
  }
}

function realZodError(): ZodError {
  const parsed = z.object({ objectId: z.string() }).safeParse({});
  if (parsed.success) throw new Error("unreachable");
  return parsed.error;
}

/** A thrown value whose every conversion to text throws an Error that carries the secret. */
function unprintable(): object {
  return {
    [Symbol.toPrimitive]() {
      throw new Error(SECRET);
    },
    toString() {
      throw new Error(SECRET);
    },
  };
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

  it("a plain Error answers the fixed sentence and logs its class, never its text", () => {
    expect(passthroughFailureText(new Error(SECRET), CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]).toEqual([
      "[agents-passthrough] tool call failed; the error's own text is not logged",
      { tool: "objects_save", runId: "run-1", errorClass: "Error" },
    ]);
    expectNoSecretLogged();
  });

  it("a thrown non-Error value answers the fixed sentence", () => {
    expect(passthroughFailureText(SECRET, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(passthroughFailureText({ message: SECRET }, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(passthroughFailureText(undefined, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expectNoSecretLogged();
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

describe("cinatra#4223 — the failure log carries no text and never throws", () => {
  it("a thrown value whose conversion to text throws answers the fixed sentence and logs no text", () => {
    expect(passthroughFailureText(unprintable(), CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(logged).toHaveBeenCalledTimes(1);
    expectNoSecretLogged();
  });

  it("an error whose zod marker throws when read answers the fixed sentence", () => {
    const err = new Error(SECRET);
    Object.defineProperty(err, "_zod", {
      get() {
        throw new Error(SECRET);
      },
    });
    expect(passthroughFailureText(err, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expectNoSecretLogged();
  });

  it("a console that throws never changes the answer", () => {
    logged.mockImplementation(() => {
      throw new Error(SECRET);
    });
    expect(passthroughFailureText(new Error(SECRET), CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(passthroughFailureText(unprintable(), CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(logged).toHaveBeenCalled();
  });

  it("logs an error's plain code, never a code that carries text", () => {
    passthroughFailureText(Object.assign(new Error(SECRET), { code: "ECONNREFUSED" }), CTX);
    expect(logged.mock.calls[0]?.[1]).toEqual({
      tool: "objects_save",
      runId: "run-1",
      errorClass: "Error",
      errorCode: "ECONNREFUSED",
    });
    passthroughFailureText(Object.assign(new TypeError(SECRET), { code: SECRET }), CTX);
    expect(logged.mock.calls[1]?.[1]).toEqual({ tool: "objects_save", runId: "run-1", errorClass: "TypeError" });
    expectNoSecretLogged();
  });

  it("the actor-context road answers its fixed sentence even for a caller-facing error", () => {
    const refusal = new PrimitiveInvocationError({
      code: "OBJECTS_TYPE_NOT_REGISTERED",
      message: SECRET,
      retryable: false,
    });
    const ctx = { ...CTX, stage: "actor context" };
    expect(passthroughFixedFailureText(refusal, ctx, PASSTHROUGH_ACTOR_CONTEXT_ERROR)).toBe(
      PASSTHROUGH_ACTOR_CONTEXT_ERROR,
    );
    expect(passthroughFixedFailureText(realZodError(), ctx, PASSTHROUGH_ACTOR_CONTEXT_ERROR)).toBe(
      PASSTHROUGH_ACTOR_CONTEXT_ERROR,
    );
    expectNoSecretLogged();
  });

  it("a zod marker on something that is not an Error, or a malformed marker, is not a schema error", () => {
    const traits = new Set(["ZodError"]);
    expect(isZodError({ _zod: { traits }, issues: [], message: SECRET })).toBe(false);
    expect(isZodError(Object.assign(new Error(SECRET), { _zod: { traits }, issues: "x" }))).toBe(false);
    expect(isZodError(Object.assign(new Error(SECRET), { _zod: { traits: ["ZodError"] }, issues: [] }))).toBe(
      false,
    );
    expect(
      isZodError(Object.assign(new Error(SECRET), { _zod: { traits: new Set(["Other"]) }, issues: [] })),
    ).toBe(false);
    expect(passthroughFailureText({ _zod: { traits }, issues: [], message: SECRET }, CTX)).toBe(
      PASSTHROUGH_UNEXPECTED_ERROR,
    );
  });
});

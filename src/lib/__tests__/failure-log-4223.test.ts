/**
 * cinatra#4223 — THE FAILURE LOG'S OWN CONTRACT, BY ITS OWN IMPORT.
 *
 * Every caller of src/lib/failure-log.ts reaches these three functions through
 * its own road. This file drives them directly: the word is the first class of
 * the fixed list the value is an instance of, by identity and in the list's
 * order, else "other"; a check that throws counts as no match; the line holds
 * the sentence, the caller's fields and that word, and no text from the thrown
 * value; a line that cannot be built or written is dropped, and nothing throws.
 *
 *   npx vitest run src/lib/__tests__/failure-log-4223.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z, ZodError } from "zod";
import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";

import { failureClass, logFailure, logFixedLine } from "@/lib/failure-log";

const SECRET = 'relation "cinatra"."objects" key sk-live-0000';
const SECRET_CODE = "SECRET_CODE_0000";
const WORDS = new Set([
  "ZodError",
  "PrimitiveInvocationError",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Error",
  "other",
]);

function primitiveError(): PrimitiveInvocationError {
  return new PrimitiveInvocationError({ code: "NOT_FOUND", message: SECRET, retryable: false });
}

function zodError(): unknown {
  return z.string().safeParse(1).error;
}

/** Every trap throws, so no reading of the value can answer. */
function throwingProxy(): object {
  const boom = () => {
    throw new Error(SECRET);
  };
  return new Proxy(
    {},
    { get: boom, has: boom, getPrototypeOf: boom, ownKeys: boom, getOwnPropertyDescriptor: boom },
  );
}

/** A real error that carries the secret on everything it can choose for itself. */
function secretBearingError(): Error {
  const err = new TypeError(SECRET) as TypeError & { code: string; detail: string };
  err.name = SECRET;
  err.stack = SECRET;
  err.cause = SECRET;
  err.code = SECRET_CODE;
  err.detail = SECRET;
  err.toString = () => SECRET;
  return err;
}

const CONSOLE_METHODS = ["error", "warn", "log", "info", "debug"] as const;
let logged: MockInstance<typeof console.error>;
let spies: MockInstance[] = [];
beforeEach(() => {
  spies = CONSOLE_METHODS.map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
  logged = spies[0] as MockInstance<typeof console.error>;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function everyConsoleCall(): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}

describe("failureClass", () => {
  it.each<[string, () => unknown, string]>([
    ["a zod error before Error", zodError, "ZodError"],
    ["a constructed ZodError", () => new ZodError([]), "ZodError"],
    ["a primitive's refusal before Error", primitiveError, "PrimitiveInvocationError"],
    ["a TypeError before Error", () => new TypeError(SECRET), "TypeError"],
    ["a RangeError before Error", () => new RangeError(SECRET), "RangeError"],
    ["a SyntaxError before Error", () => new SyntaxError(SECRET), "SyntaxError"],
    ["a plain Error", () => new Error(SECRET), "Error"],
    ["an Error subclass off the list", () => new URIError(SECRET), "Error"],
    ["a subclass of a listed class", () => new (class Sub extends RangeError {})(SECRET), "RangeError"],
  ])("identity in the list's order: %s", (_name, make, word) => {
    expect(failureClass(make())).toEqual({ errorClass: word });
  });

  it("a word is matched by identity, never by a name the value gives itself", () => {
    const namedPlain = {
      name: "TypeError",
      message: SECRET,
      code: SECRET_CODE,
      constructor: { name: "TypeError" },
    };
    const renamed = Object.assign(new Error(SECRET), { name: "TypeError" });
    expect(failureClass(namedPlain)).toEqual({ errorClass: "other" });
    expect(failureClass(renamed)).toEqual({ errorClass: "Error" });
  });

  it.each<[string, unknown]>([
    ["a string", SECRET],
    ["a number", 7],
    ["a symbol", Symbol(SECRET)],
    ["null", null],
    ["undefined", undefined],
    ["a plain object", { message: SECRET }],
    ["an object with no prototype", Object.create(null)],
  ])("a value outside the list is other: %s", (_name, value) => {
    expect(failureClass(value)).toEqual({ errorClass: "other" });
  });

  it("a proxy that throws on every read is other, and nothing throws", () => {
    expect(failureClass(throwingProxy())).toEqual({ errorClass: "other" });
  });

  it("a value that is no Error but carries zod's trait set logs ZodError", () => {
    // zod answers `instanceof ZodError` by the trait set it writes on the errors it
    // builds (`_zod.traits.has("ZodError")`), so this word names the trait, not the
    // Error class; the value's own text is still not logged.
    const traitOnly = { _zod: { traits: new Set(["ZodError"]) }, message: SECRET, code: SECRET_CODE };
    expect(failureClass(traitOnly)).toEqual({ errorClass: "ZodError" });
    logFailure("a fixed sentence", { stage: "tool call" }, traitOnly);
    expect(logged).toHaveBeenCalledWith("a fixed sentence", { stage: "tool call", errorClass: "ZodError" });
    expect(everyConsoleCall()).not.toContain("sk-live-0000");
    expect(everyConsoleCall()).not.toContain(SECRET_CODE);
  });

  it("zod's trait name in an array, not a set, is other", () => {
    // The trait check calls `traits.has`, which an array lacks, so the check throws
    // and counts as no match.
    expect(failureClass({ _zod: { traits: ["ZodError"] }, message: SECRET })).toEqual({ errorClass: "other" });
  });

  it("a check that throws counts as no match, and the next check still runs", () => {
    // Reading a property throws, which is how the zod check reads its value; the
    // prototype read that the built-in classes' checks use answers.
    const proxy = new Proxy(new TypeError(SECRET), {
      get() {
        throw new Error(SECRET);
      },
    });
    expect(failureClass(proxy)).toEqual({ errorClass: "TypeError" });
  });

  it("a proxy that reports a made-up prototype gets a word of the list and no more", () => {
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => RangeError.prototype,
        get: (_target, key) => (key === "name" || key === "code" ? SECRET : undefined),
      },
    );
    const { errorClass } = failureClass(proxy);
    expect(errorClass).toBe("RangeError");
    expect(WORDS.has(errorClass)).toBe(true);
  });
});

describe("logFailure", () => {
  it("writes one line: the sentence, the caller's fields and the word", () => {
    logFailure("a fixed sentence", { stage: "tool call", runId: "run-1" }, new RangeError(SECRET));
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("a fixed sentence", {
      stage: "tool call",
      runId: "run-1",
      errorClass: "RangeError",
    });
  });

  it("the word wins over a caller field of the same name", () => {
    logFailure("a fixed sentence", { errorClass: "from the caller" }, new SyntaxError(SECRET));
    expect(logged).toHaveBeenCalledWith("a fixed sentence", { errorClass: "SyntaxError" });
  });

  it("no text from the error: message, name, stack, cause, code, own property, string form", () => {
    logFailure("a fixed sentence", { stage: "write" }, secretBearingError());
    expect(logged).toHaveBeenCalledWith("a fixed sentence", { stage: "write", errorClass: "TypeError" });
    const lines = everyConsoleCall();
    expect(lines).not.toContain("sk-live-0000");
    expect(lines).not.toContain("cinatra");
    expect(lines).not.toContain(SECRET_CODE);
  });

  it("no text from a thrown value that is not an error", () => {
    logFailure("a fixed sentence", {}, { message: SECRET, code: SECRET_CODE });
    logFailure("a fixed sentence", {}, SECRET);
    expect(logged.mock.calls).toEqual([
      ["a fixed sentence", { errorClass: "other" }],
      ["a fixed sentence", { errorClass: "other" }],
    ]);
  });

  it("a proxy that throws on every read logs other, and nothing throws", () => {
    expect(() => logFailure("a fixed sentence", { stage: "write" }, throwingProxy())).not.toThrow();
    expect(logged).toHaveBeenCalledWith("a fixed sentence", { stage: "write", errorClass: "other" });
    expect(everyConsoleCall()).not.toContain("sk-live-0000");
  });

  it("a console that throws is dropped: nothing throws and nothing is answered", () => {
    logged.mockImplementation(() => {
      throw new Error("the console is gone");
    });
    let answer: unknown = "unset";
    expect(() => {
      answer = logFailure("a fixed sentence", { stage: "write" }, new Error(SECRET));
    }).not.toThrow();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(answer).toBeUndefined();
  });

  it("fields that cannot be read are dropped with the line: nothing throws", () => {
    const fields = {
      get stage(): string {
        throw new Error(SECRET);
      },
    };
    expect(() => logFailure("a fixed sentence", fields, new Error(SECRET))).not.toThrow();
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("logFixedLine", () => {
  it("writes one line: the sentence and a copy of the caller's fields, nothing more", () => {
    const fields = { stage: "install state", runId: "run-1" };
    logFixedLine("a fixed sentence", fields);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]).toEqual(["a fixed sentence", { stage: "install state", runId: "run-1" }]);
    expect(logged.mock.calls[0]?.[1]).not.toBe(fields);
  });

  it("a console that throws is dropped: nothing throws", () => {
    logged.mockImplementation(() => {
      throw new Error("the console is gone");
    });
    expect(() => logFixedLine("a fixed sentence", { stage: "install state" })).not.toThrow();
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("fields that cannot be read are dropped with the line: nothing throws", () => {
    const fields = {
      get stage(): string {
        throw new Error(SECRET);
      },
    };
    expect(() => logFixedLine("a fixed sentence", fields)).not.toThrow();
    expect(logged).not.toHaveBeenCalled();
  });
});

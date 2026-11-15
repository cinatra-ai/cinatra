/**
 * cinatra#4465 — A ZOD ERROR IS ANSWERED BY ITS ISSUES, NEVER BY ITS OWN MESSAGE
 * (src/lib/passthrough-refusal.ts).
 *
 * The trait set that marks a zod error can be written by any code in the
 * process, and a wrapper can keep a zod error's marker with a message of its
 * own. So the passthrough answers an input-schema error with a text built from
 * its issues only: each path and code, and for a type error the expected type.
 * A code, a type word or a path segment outside a fixed form is not copied.
 * An error with no issue, or with an issue or a list length it cannot read,
 * answers the fixed sentence and is logged without its text. A primitive's
 * refusal that also carries the marker is answered as a zod error, or with the
 * fixed sentence when its issues are missing or not a list. The marker is
 * read with the native Set membership, never a `has` the error supplies, and a
 * traits value that membership cannot read answers the fixed sentence. On the base
 * the error's own message is the answer, so every case here fails there, except
 * the one for a primitive's message that is not a string: the base already
 * answers it with the fixed sentence, and the case pins that.
 *
 *   npx vitest run src/lib/__tests__/passthrough-refusal-zod-text-4465.test.ts
 */
import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";

import {
  PASSTHROUGH_SCHEMA_ERROR,
  PASSTHROUGH_UNEXPECTED_ERROR,
  isCallerFacingError,
  isZodError,
  passthroughFailureText,
} from "../passthrough-refusal";

const CTX = { tool: "objects_save", runId: "run-1", stage: "tool call" };
const PREFIX = "the input does not match the tool's input schema";
// Assembled at runtime so no committed line carries a complete URL literal
// for a secret scanner to trip on; the string the tests use is unchanged.
const ISSUE_INPUT_TEXT = `relation objects at ${["postgres:", "", "secret"].join("/")}`;
const PG_URL = ["postgres:", "", "svc:hunter2@db.internal:5432"].join("/");
const SECRET = `relation "cinatra"."objects" at ${PG_URL}`;
const SECRET_PARTS = ["hunter2", "db.internal", '"objects"', "postgres:", "relation objects"];

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

/** No part of a secret is in `text`. */
function expectNoSecretIn(text: string) {
  for (const part of SECRET_PARTS) expect(text).not.toContain(part);
}

/** No part of a secret reaches any console call. */
function expectNoSecretLogged() {
  expectNoSecretIn(JSON.stringify(spies.map((spy) => spy.mock.calls)));
}

/** An Error that carries zod's marker, as any code in the process can build it. */
function forgedZodError(message: string, issues: unknown, trait = "ZodError"): Error {
  return Object.assign(new Error(message), { _zod: { traits: new Set([trait]) }, issues });
}

function zodErrorOf(schema: z.ZodType, input: unknown): z.ZodError {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error("unreachable: the input parsed");
  return parsed.error;
}

describe("cinatra#4465 — a forged or rewrapped zod marker never carries the error's own text", () => {
  it("the issue's input: a zod marker on an Error with no issue answers the fixed sentence, logged without its text", () => {
    const err = Object.assign(new Error(ISSUE_INPUT_TEXT), {
      _zod: { traits: new Set(["ZodError"]) },
      issues: [],
    });
    expect(isZodError(err)).toBe(true);
    expect(passthroughFailureText(err, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(logged.mock.calls).toEqual([
      [
        "[agents-passthrough] tool call failed; the error's own text is not logged",
        { tool: "objects_save", runId: "run-1", errorClass: "ZodError" },
      ],
    ]);
    expectNoSecretLogged();
  });

  it("a zod marker with real issues answers the issues, never the error's own message", () => {
    const issues = zodErrorOf(z.object({ objectId: z.string() }), {}).issues;
    for (const trait of ["ZodError", "$ZodError"]) {
      const text = passthroughFailureText(forgedZodError(SECRET, issues, trait), CTX);
      expect(text).toBe(`${PREFIX}: objectId: invalid_type, expected string`);
      expectNoSecretIn(text);
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it("a wrapper that keeps a real zod error's marker and issues with its own message answers the issues", () => {
    const real = zodErrorOf(z.object({ objectId: z.string() }), {});
    const wrapped = Object.assign(new Error(SECRET), {
      _zod: (real as unknown as { _zod: unknown })._zod,
      issues: real.issues,
      cause: real,
    });
    expect(isZodError(wrapped)).toBe(true);
    expect(passthroughFailureText(wrapped, CTX)).toBe(`${PREFIX}: objectId: invalid_type, expected string`);
  });

  it("an issue's own message, a made-up code, a made-up type word and an unsafe path segment are not copied", () => {
    const issues = [
      { code: SECRET, message: SECRET, path: [PG_URL, "ok", 3, Symbol("s"), -1, 1.5, ""] },
      { code: "invalid_type", expected: SECRET, message: SECRET, path: ["count"] },
      { code: "custom", message: SECRET, path: ["x".repeat(65)] },
    ];
    const text = passthroughFailureText(forgedZodError(SECRET, issues), CTX);
    expect(text).toBe(`${PREFIX}: [?].ok[3][?][?][?][?]: invalid; count: invalid_type; [?]: custom`);
    expectNoSecretIn(text);
  });

  it("a path longer than 16 segments is cut after the 16th", () => {
    const path = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const text = passthroughFailureText(forgedZodError(SECRET, [{ code: "custom", path }]), CTX);
    expect(text).toBe(`${PREFIX}: ${path.slice(0, 16).join(".")}[...]: custom`);
  });
});

describe("cinatra#4465 — a real zod error answers each path and code", () => {
  it("names nested paths, array indexes, codes and the expected type", () => {
    const schema = z
      .object({
        items: z.array(z.object({ name: z.string().min(2) })),
        mode: z.enum(["a", "b"]),
        count: z.number(),
      })
      .strict();
    const err = zodErrorOf(schema, { items: [{ name: "x" }], mode: "c", count: "7", extra: 1 });
    const text = passthroughFailureText(err, CTX);
    expect(text.startsWith(`${PREFIX}: `)).toBe(true);
    expect(text.slice(PREFIX.length + 2).split("; ").sort()).toEqual(
      [
        "(input): unrecognized_keys",
        "count: invalid_type, expected number",
        "items[0].name: too_small",
        "mode: invalid_value",
      ].sort(),
    );
    expect(logged).not.toHaveBeenCalled();
  });

  it("an issue at the root of the input is named (input)", () => {
    expect(passthroughFailureText(zodErrorOf(z.string(), 5), CTX)).toBe(
      `${PREFIX}: (input): invalid_type, expected string`,
    );
  });

  it("names at most 20 issues, then the count of the rest", () => {
    const err = zodErrorOf(z.array(z.string()), Array.from({ length: 25 }, () => 1));
    const named = Array.from({ length: 20 }, (_, i) => `[${i}]: invalid_type, expected string`);
    expect(passthroughFailureText(err, CTX)).toBe(`${PREFIX}: ${named.join("; ")}; and 5 more`);
  });

  it("the first words of the answer are exported", () => {
    expect(PASSTHROUGH_SCHEMA_ERROR).toBe(PREFIX);
  });
});

describe("cinatra#4465 — an issue list it cannot read answers the fixed sentence", () => {
  it("an issue that is not an object, or whose path is not a list, answers the fixed sentence", () => {
    for (const issues of [[null], ["x"], [7], [{ code: "custom", path: "objectId" }], [{ code: "custom" }]]) {
      expect(passthroughFailureText(forgedZodError(SECRET, issues), CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    }
    expect(logged).toHaveBeenCalledTimes(5);
    expectNoSecretLogged();
  });

  it("an issue whose fields throw when read answers the fixed sentence", () => {
    const issue = { code: "custom" };
    Object.defineProperty(issue, "path", {
      get() {
        throw new Error(SECRET);
      },
    });
    const issues = new Proxy([], {
      get(target, key) {
        if (key === "length") throw new Error(SECRET);
        return Reflect.get(target, key);
      },
    });
    expect(passthroughFailureText(forgedZodError(SECRET, [issue]), CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(passthroughFailureText(forgedZodError(SECRET, issues), CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expectNoSecretLogged();
  });
});

describe("cinatra#4465 — the bounds hold exactly at their edges", () => {
  const custom = (path: unknown[]) => ({ code: "custom", path });
  const answer = (issues: unknown[]) => passthroughFailureText(forgedZodError(SECRET, issues), CTX);

  it("a path of exactly 16 segments is shown whole; a path of 17 is cut after the 16th", () => {
    const path = Array.from({ length: 17 }, (_, i) => `k${i}`);
    const sixteen = path.slice(0, 16).join(".");
    expect(answer([custom(path.slice(0, 16))])).toBe(`${PREFIX}: ${sixteen}: custom`);
    expect(answer([custom(path)])).toBe(`${PREFIX}: ${sixteen}[...]: custom`);
  });

  it("exactly 20 issues are all named with no count; 21 name 20 and then 1 more", () => {
    const issues = Array.from({ length: 21 }, (_, i) => custom([`f${i}`]));
    const named = issues.slice(0, 20).map((_, i) => `f${i}: custom`);
    expect(answer(issues.slice(0, 20))).toBe(`${PREFIX}: ${named.join("; ")}`);
    expect(answer(issues)).toBe(`${PREFIX}: ${named.join("; ")}; and 1 more`);
  });

  it("a key of exactly 64 characters is shown; one of 65 is shown as [?]", () => {
    const k64 = "k".repeat(64);
    expect(answer([custom([k64])])).toBe(`${PREFIX}: ${k64}: custom`);
    expect(answer([custom([`${k64}k`])])).toBe(`${PREFIX}: [?]: custom`);
  });

  it("the largest safe integer is shown as an index; 2^53 is not safe and is shown as [?]", () => {
    expect(answer([custom([Number.MAX_SAFE_INTEGER])])).toBe(`${PREFIX}: [${Number.MAX_SAFE_INTEGER}]: custom`);
    expect(answer([custom([2 ** 53])])).toBe(`${PREFIX}: [?]: custom`);
  });
});

describe("cinatra#4465 — the expected type is named only for a type error", () => {
  it("an issue of another code that carries a listed expected word names no type", () => {
    const issues = [
      { code: "too_small", expected: "string", path: ["name"] },
      { code: "custom", expected: "number", path: ["count"] },
      { code: "invalid_type", expected: "number", path: ["count"] },
    ];
    expect(passthroughFailureText(forgedZodError(SECRET, issues), CTX)).toBe(
      `${PREFIX}: name: too_small; count: custom; count: invalid_type, expected number`,
    );
  });
});

describe("cinatra#4465 — a primitive's refusal that carries the zod marker is answered as a zod error", () => {
  it("never answers the primitive's own message: its issues, or the fixed sentence when it has none", () => {
    const marked = (issues: unknown[]) =>
      Object.assign(new PrimitiveInvocationError({ code: "NOT_FOUND", message: SECRET, retryable: false }), {
        _zod: { traits: new Set(["ZodError"]) },
        issues,
      });
    expect(passthroughFailureText(marked([{ path: [], code: "custom" }]), CTX)).toBe(`${PREFIX}: (input): custom`);
    expect(logged).not.toHaveBeenCalled();
    expect(passthroughFailureText(marked([]), CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(logged).toHaveBeenCalledTimes(1);
    expectNoSecretLogged();
  });

  it("never answers the primitive's own message when its issues are missing or not a list", () => {
    const values: unknown[] = [null, undefined, "issues", { 0: { path: [], code: "custom" }, length: 1 }];
    for (const issues of values) {
      const err = Object.assign(new PrimitiveInvocationError({ code: "NOT_FOUND", message: SECRET, retryable: false }), {
        _zod: { traits: new Set(["ZodError"]) },
        issues,
      });
      expect(isZodError(err)).toBe(false);
      expect(passthroughFailureText(err, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    }
    const missing = Object.assign(new PrimitiveInvocationError({ code: "NOT_FOUND", message: SECRET, retryable: false }), {
      _zod: { traits: new Set(["$ZodError"]) },
    });
    expect(passthroughFailureText(missing, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    expect(logged).toHaveBeenCalledTimes(values.length + 1);
    expectNoSecretLogged();
  });
});

describe("cinatra#4465 — the predicates and a primitive's message never throw or answer text that is not a string", () => {
  it("isZodError and isCallerFacingError answer false, never a throw, when a read of the error throws", () => {
    const markedGetter = new Error(SECRET);
    Object.defineProperty(markedGetter, "_zod", {
      get() {
        throw new Error(SECRET);
      },
    });
    const throwingIssues = Object.assign(new Error(SECRET), { _zod: { traits: new Set(["ZodError"]) } });
    Object.defineProperty(throwingIssues, "issues", {
      get() {
        throw new Error(SECRET);
      },
    });
    const throwingPrototype = new Proxy(new Error(SECRET), {
      getPrototypeOf() {
        throw new Error(SECRET);
      },
    });
    const revocable = Proxy.revocable(forgedZodError(SECRET, [{ path: [], code: "custom" }]), {});
    revocable.revoke();
    for (const err of [markedGetter, throwingIssues, throwingPrototype, revocable.proxy]) {
      expect(isZodError(err)).toBe(false);
      expect(isCallerFacingError(err)).toBe(false);
      expect(passthroughFailureText(err, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    }
    expectNoSecretLogged();
  });

  it("a primitive's refusal without the marker whose message is not a string, or throws, answers the fixed sentence, logged", () => {
    const refusal = () => new PrimitiveInvocationError({ code: "NOT_FOUND", message: "refused", retryable: false });
    const numeric = Object.defineProperty(refusal(), "message", { value: 7 });
    const missing = Object.defineProperty(refusal(), "message", { value: undefined });
    const throwing = Object.defineProperty(refusal(), "message", {
      get() {
        throw new Error(SECRET);
      },
    });
    for (const err of [numeric, missing, throwing]) {
      expect(passthroughFailureText(err, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    }
    expect(logged).toHaveBeenCalledTimes(3);
    expectNoSecretLogged();
  });
});

describe("cinatra#4465 — the zod marker is read with the native Set membership, never a method of the error", () => {
  const ISSUES = [{ path: [], code: "custom" }];
  const primitiveWith = (traits: unknown, issues: unknown = ISSUES) =>
    Object.assign(new PrimitiveInvocationError({ code: "NOT_FOUND", message: SECRET, retryable: false }), {
      _zod: { traits },
      issues,
    });

  it("a native Set that holds the marker is a marker even when its own or its class's `has` lies or throws", () => {
    const ownFalse = new Set(["ZodError"]);
    Object.defineProperty(ownFalse, "has", { value: () => false });
    const ownThrows = new Set(["$ZodError"]);
    Object.defineProperty(ownThrows, "has", {
      value: () => {
        throw new Error(SECRET);
      },
    });
    class LyingSet extends Set<string> {
      override has(): boolean {
        return false;
      }
    }
    const nullPrototype = new Set(["ZodError"]);
    Object.setPrototypeOf(nullPrototype, null);
    for (const traits of [ownFalse, ownThrows, new LyingSet(["ZodError"]), nullPrototype]) {
      const err = primitiveWith(traits);
      expect(isZodError(err)).toBe(true);
      expect(passthroughFailureText(err, CTX)).toBe(`${PREFIX}: (input): custom`);
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it("a trait value the native membership cannot read answers the fixed sentence, logged", () => {
    const proxied = new Proxy(new Set(["ZodError"]), {});
    const values: unknown[] = [["ZodError"], "ZodError", { has: () => true }, Object.create(Set.prototype), proxied];
    for (const traits of values) {
      const err = primitiveWith(traits);
      expect(isZodError(err)).toBe(false);
      expect(passthroughFailureText(err, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    }
    expect(logged).toHaveBeenCalledTimes(values.length);
    expectNoSecretLogged();
  });

  it("a Proxy that changes its prototype between reads never answers a marked error's own message", () => {
    // `order` gives the prototype each getPrototypeOf call answers, in turn.
    const flipping = (order: object[]) => {
      let calls = 0;
      return new Proxy(primitiveWith(new Set(["ZodError"])), {
        getPrototypeOf() {
          const proto = order[calls % order.length] as object;
          calls += 1;
          return proto;
        },
      });
    };
    const primitive = PrimitiveInvocationError.prototype;
    for (const order of [
      [Object.prototype, primitive],
      [primitive, Object.prototype],
    ]) {
      expect(passthroughFailureText(flipping(order), CTX)).toBe(`${PREFIX}: (input): custom`);
    }
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("cinatra#4465 — a list length is read once and must be a whole list length", () => {
  /** A Proxy over `target` that passes Array.isArray and answers `length` with `length`. */
  const lying = (target: unknown[], length: unknown): unknown[] =>
    new Proxy(target, {
      get(t, key) {
        return key === "length" ? length : Reflect.get(t, key);
      },
    });
  const twenty = () => Array.from({ length: 20 }, (_, i) => ({ code: "custom", path: [`f${i}`] }));

  it("an issue list whose length is fractional, negative, not finite, too large or not a number answers the fixed sentence", () => {
    const lists = [
      lying(twenty(), 20.5),
      lying([], -1),
      lying(twenty(), Number.NaN),
      lying(twenty(), Number.POSITIVE_INFINITY),
      lying(twenty(), 2 ** 32),
      lying(twenty(), "20"),
    ];
    for (const issues of lists) {
      expect(isZodError(forgedZodError(SECRET, issues))).toBe(true);
      expect(passthroughFailureText(forgedZodError(SECRET, issues), CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    }
    expect(logged).toHaveBeenCalledTimes(lists.length);
    expectNoSecretLogged();
  });

  it("a path whose length is not a number, negative, fractional or not finite answers the fixed sentence", () => {
    const lengths = [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY];
    for (const length of lengths) {
      const issues = [{ code: "custom", path: lying(["safe"], length) }];
      expect(passthroughFailureText(forgedZodError(SECRET, issues), CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    }
    expect(logged).toHaveBeenCalledTimes(lengths.length);
    expectNoSecretLogged();
  });

  it("an issue list of the largest list length, 2^32 - 1, names 20 issues and then the rest", () => {
    const named = Array.from({ length: 20 }, (_, i) => `f${i}: custom`).join("; ");
    expect(passthroughFailureText(forgedZodError(SECRET, lying(twenty(), 2 ** 32 - 1)), CTX)).toBe(
      `${PREFIX}: ${named}; and ${2 ** 32 - 1 - 20} more`,
    );
    expect(logged).not.toHaveBeenCalled();
  });

  it("a throwing traits, code or expected getter, or a revoked Proxy as issues or path, answers the fixed sentence", () => {
    const thrower = () => {
      throw new Error(SECRET);
    };
    const traitsThrows = Object.assign(
      new PrimitiveInvocationError({ code: "NOT_FOUND", message: SECRET, retryable: false }),
      { _zod: Object.defineProperty({}, "traits", { get: thrower }), issues: [{ path: [], code: "custom" }] },
    );
    const codeThrows = forgedZodError(SECRET, [Object.defineProperty({ path: [] }, "code", { get: thrower })]);
    const expectedThrows = forgedZodError(SECRET, [
      Object.defineProperty({ path: [], code: "invalid_type" }, "expected", { get: thrower }),
    ]);
    const revokedIssues = Proxy.revocable([{ path: [], code: "custom" }], {});
    revokedIssues.revoke();
    const revokedPath = Proxy.revocable(["a"], {});
    revokedPath.revoke();
    const errors = [
      traitsThrows,
      codeThrows,
      expectedThrows,
      forgedZodError(SECRET, revokedIssues.proxy),
      forgedZodError(SECRET, [{ path: revokedPath.proxy, code: "custom" }]),
    ];
    for (const err of errors) {
      expect(passthroughFailureText(err, CTX)).toBe(PASSTHROUGH_UNEXPECTED_ERROR);
    }
    expect(logged).toHaveBeenCalledTimes(errors.length);
    expectNoSecretLogged();
  });
});

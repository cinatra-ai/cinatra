/**
 * cinatra#2484 — the shared declared-type guard for setup inputs.
 *
 * `inputParams` has more than one door: the Setup form (renderer + the
 * setup-resume path in review-task-actions) AND run CREATION with inputs
 * pre-supplied (the `agent_run` MCP tool, chat extraction, the API). The setup
 * loop's pending-field filter tests key PRESENCE only, so a pre-supplied
 * `{"idea": "a bare sentence"}` would skip the gate and dispatch. Both server
 * chokepoints call THIS assertion, so the invariant holds regardless of door.
 *
 * The guard lives in `../input-schema-resolver` (not a leaf file of its own):
 * it validates against the `properties` map that module resolves, both callers
 * already import it from there, and a separate module would add one more
 * first-party module to every LOCKED dev-perf route's reachable graph. This
 * file keeps its behaviour-named filename — it tests the setup-input type
 * guard, wherever the guard is housed.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/setup-input-type-guard.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import {
  assertValuesMatchDeclaredObjectTypes,
  describeJsonType,
} from "../input-schema-resolver";

/** blog-draft-writer@0.1.2 — `idea` object-typed, no declared sub-shape. */
const SCHEMALESS: Record<string, Record<string, unknown>> = {
  idea: { type: "object" },
  tone: { type: "string" },
};

/** The declared shape (the merged agent-side manifest fix). */
const DECLARED: Record<string, Record<string, unknown>> = {
  idea: {
    type: "object",
    properties: {
      title: { type: "string" },
      details: {
        type: "object",
        properties: { metadata: { type: "object" } },
      },
    },
    required: ["title"],
  },
};

const PREFIX = "Run cannot start";

describe("assertValuesMatchDeclaredObjectTypes", () => {
  it("rejects a bare string for an object-typed input, naming the input", () => {
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(
        SCHEMALESS,
        { idea: "human purpose in an age of agentic ai" },
        PREFIX,
      ),
    ).toThrow(/Run cannot start: input "idea" is declared type "object" but received a string/);
  });

  it("rejects arrays and null too — only an OBJECT satisfies an object input", () => {
    for (const [bad, expected] of [
      [["a"], /an array/],
      [null, /null/],
      [42, /a number/],
      [true, /a boolean/],
    ] as const) {
      expect(() =>
        assertValuesMatchDeclaredObjectTypes(SCHEMALESS, { idea: bad }, PREFIX),
      ).toThrow(expected);
    }
  });

  it("accepts a real object", () => {
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(SCHEMALESS, { idea: { title: "t" } }, PREFIX),
    ).not.toThrow();
  });

  it("treats `undefined` as ABSENCE, not a violation", () => {
    // A grouped form leaves an untouched optional object field undefined and
    // JSON.stringify drops the key on the way to the merge. Requiredness is the
    // setup loop's own concern.
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(SCHEMALESS, { idea: undefined }, PREFIX),
    ).not.toThrow();
  });

  it("is scoped to OBJECT inputs — other declared types are untouched", () => {
    // `tone` is declared "string"; a number is a type violation too, but the
    // guard deliberately does not widen, so no existing agent changes behaviour.
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(SCHEMALESS, { tone: 42 }, PREFIX),
    ).not.toThrow();
  });

  it("ignores UNDECLARED keys (the allowlist check owns those)", () => {
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(SCHEMALESS, { notInSchema: "x" }, PREFIX),
    ).not.toThrow();
  });

  it("recurses into declared sub-properties — a one-level check only moves the hole down", () => {
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(
        DECLARED,
        { idea: { title: "t", details: "bare text" } },
        PREFIX,
      ),
    ).toThrow(/input "idea\.details" is declared type "object" but received a string/);
  });

  it("recurses TWO levels deep and reports the dotted path", () => {
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(
        DECLARED,
        { idea: { title: "t", details: { metadata: "bare text" } } },
        PREFIX,
      ),
    ).toThrow(/input "idea\.details\.metadata" is declared type "object"/);
  });

  it("accepts a fully valid nested object", () => {
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(
        DECLARED,
        { idea: { title: "t", details: { metadata: { depth: "deep" } } } },
        PREFIX,
      ),
    ).not.toThrow();
  });

  it("does not recurse where no sub-shape is declared (schema-less object stays permissive)", () => {
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(
        SCHEMALESS,
        { idea: { anything: "at all", nested: { free: "form" } } },
        PREFIX,
      ),
    ).not.toThrow();
  });

  it("carries the caller's own prefix so each chokepoint reads in its own terms", () => {
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(SCHEMALESS, { idea: "x" }, "Setup approval rejected"),
    ).toThrow(/^Setup approval rejected: input "idea"/);
  });

  // The setup loop must LAND THE RUN FAILED with this message rather than let
  // the throw escape: a bare throw is swallowed by the job runner WITHOUT any
  // run-status transition, parking the run at "queued" forever — the same
  // silent-failure shape the artifact-materialization honesty fix removed, just
  // relocated. Proven live (run c357a33a: status=failed, error = this message);
  // pinned here against the source so the try/catch cannot be dropped.
  it("execution.ts converts a violation into a FAILED run, never a bare throw", () => {
    const src = readFileSync(join(__dirname, "..", "execution.ts"), "utf8");
    const call = src.indexOf("assertValuesMatchDeclaredObjectTypes(");
    expect(call, "the setup loop must call the shared guard").toBeGreaterThan(-1);
    // The call sits inside a try whose catch transitions the run to "failed".
    const window = src.slice(call - 400, call + 900);
    expect(window).toMatch(/try\s*\{/);
    expect(window).toMatch(/transitionRunStatus\(\s*runId,\s*"queued",\s*"failed"/);
    expect(window).toMatch(/Run cannot start/);
  });

  it("describeJsonType names the shapes the message uses", () => {
    expect(describeJsonType(null)).toBe("null");
    expect(describeJsonType([])).toBe("an array");
    expect(describeJsonType("s")).toBe("a string");
    expect(describeJsonType(1)).toBe("a number");
  });
});

/**
 * A CLASS INSTANCE is not a JSON object (codex round 1).
 *
 * `typeof v === "object" && !Array.isArray(v)` was the original check, and it
 * admits class instances. That is not academic: server-action deserialization
 * revives real `Date` instances, so `{idea: <Date>}` cleared the guard and was
 * then `JSON.stringify`-ed to `"2026-08-07T…"` — a STRING landing in an
 * object-typed input, i.e. this issue's exact defect re-entering through the
 * one door the guard was supposed to be closing.
 */
describe("declared-object guard rejects non-plain objects (cinatra#2484, codex round 1)", () => {
  it("rejects a Date — it would JSON.stringify to a bare string", () => {
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(
        SCHEMALESS,
        { idea: new Date("2026-08-07T00:00:00.000Z") },
        "Run cannot start",
      ),
    ).toThrow(/input "idea" is declared type "object" but received a Date/);
  });

  it("rejects a Map — it would JSON.stringify to an empty object", () => {
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(
        SCHEMALESS,
        { idea: new Map([["title", "t"]]) },
        "Run cannot start",
      ),
    ).toThrow(/input "idea" is declared type "object" but received a Map/);
  });

  it("rejects a nested Date one level down, where the declared sub-shape says object", () => {
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(
        DECLARED,
        { idea: { title: "t", details: new Date() } },
        "Run cannot start",
      ),
    ).toThrow(/input "idea\.details" is declared type "object" but received a Date/);
  });

  it("still accepts what JSON.parse and jsonb actually produce", () => {
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(
        SCHEMALESS,
        { idea: JSON.parse('{"title":"t"}') as unknown },
        "Run cannot start",
      ),
    ).not.toThrow();
    // A null-prototype object is still a JSON object.
    const bare = Object.assign(Object.create(null) as object, { title: "t" });
    expect(() =>
      assertValuesMatchDeclaredObjectTypes(SCHEMALESS, { idea: bare }, "Run cannot start"),
    ).not.toThrow();
  });
});

/**
 * The approve-time schema resolution reads the mounted OAS from disk and can
 * fail for reasons unrelated to the submitted value (codex round 1). It must
 * NOT turn this type gate into a new way for a working approval to break — the
 * same assertion runs again in execution.ts before dispatch, so degrading to
 * "validate at dispatch instead" loses nothing but the point of report.
 */
describe("approve-time resolution failure is non-fatal (cinatra#2484, codex round 1)", () => {
  it("review-task-actions catches a resolver failure instead of failing the approval", () => {
    const src = readFileSync(join(__dirname, "..", "review-task-actions.ts"), "utf8");
    const call = src.indexOf("resolveTemplateInputSchema(template)");
    expect(call, "the setup-resume path must resolve the effective schema").toBeGreaterThan(-1);
    const window = src.slice(call - 600, call + 600);
    expect(window).toMatch(/try\s*\{/);
    expect(window).toMatch(/catch\s*\(/);
    // Degrades to "no properties" => validation skipped, approval proceeds.
    expect(window).toMatch(/declaredPropertiesCache = null/);
  });
});

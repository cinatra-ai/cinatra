/**
 * THE RESOLVER'S ORDER AND THE PLANNER'S ARE THE SAME ORDER
 * (cinatra#2815 S3 part 3).
 *
 * The allocation is content-addressed into the token finalize compares, so the
 * two modules that order resolved refs must agree exactly. They cannot share
 * one function: the resolver is a `server-only` store leaf reached by the chat
 * route, whose locked reachable-module budget may only ever shrink, and the
 * comparator's home is the pure support leaf the planner reads. So the resolver
 * carries a deliberate twin, and this suite is what keeps the twin honest: it
 * drives both comparators over every axis and every tie.
 */
import { describe, expect, it } from "vitest";
import { compareContextRefs, contextScopeWeight } from "../context-route-support";
import { __resolverRefOrderForTest } from "../context-resolver";

type Scope = "project" | "user" | "team" | "organization" | "workspace";
const SCOPES: Scope[] = ["project", "user", "team", "organization", "workspace"];

function ref(over: Partial<{ artifactId: string; semanticAssertionId: string; representationRevisionId: string; sourceScope: Scope }>) {
  return {
    artifactId: "art-1",
    representationRevisionId: "rev-1",
    semanticAssertionId: "sem-1",
    extension: "@cinatra-ai/a-artifact",
    sourceScope: "user" as Scope,
    ownerId: "owner-1",
    ...over,
  };
}

/** Every pair worth comparing: each axis alone, and every tie behind it. */
const CASES = [
  ...SCOPES.flatMap((a) => SCOPES.map((b) => [ref({ sourceScope: a }), ref({ sourceScope: b })])),
  [ref({ artifactId: "a" }), ref({ artifactId: "b" })],
  [ref({ artifactId: "b" }), ref({ artifactId: "a" })],
  [ref({ semanticAssertionId: "sem-a" }), ref({ semanticAssertionId: "sem-b" })],
  [ref({ semanticAssertionId: "sem-b" }), ref({ semanticAssertionId: "sem-a" })],
  [ref({ representationRevisionId: "rev-a" }), ref({ representationRevisionId: "rev-b" })],
  [ref({ representationRevisionId: "rev-b" }), ref({ representationRevisionId: "rev-a" })],
  [ref({}), ref({})],
];

describe("the two comparators agree", () => {
  it("on the sign of every pair, on every axis and every tie", () => {
    for (const [a, b] of CASES) {
      expect(Math.sign(__resolverRefOrderForTest(a, b))).toBe(Math.sign(compareContextRefs(a, b)));
    }
  });

  it("and on the scope weights themselves", () => {
    const sorted = [...SCOPES].sort((a, b) => contextScopeWeight(a) - contextScopeWeight(b));
    expect(sorted).toEqual(["project", "user", "team", "organization", "workspace"]);
    for (const scope of SCOPES) {
      const narrower = ref({ sourceScope: "project" });
      const here = ref({ sourceScope: scope });
      expect(Math.sign(__resolverRefOrderForTest(narrower, here))).toBe(
        Math.sign(compareContextRefs(narrower, here)),
      );
    }
  });

  it("never calls two DISTINCT refs equal, which is what makes the order total", () => {
    const a = ref({ semanticAssertionId: "sem-a" });
    const b = ref({ semanticAssertionId: "sem-b" });
    expect(__resolverRefOrderForTest(a, b)).not.toBe(0);
    expect(compareContextRefs(a, b)).not.toBe(0);
  });
});

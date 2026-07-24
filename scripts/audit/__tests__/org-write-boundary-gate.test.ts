/**
 * cinatra#1938 — boundary-gate self-test: planted violations MUST turn the
 * gate red (the acceptance criterion), legitimate shapes must stay green.
 * Exercises the exported classifier + rule engine directly with in-memory
 * fixtures; the resolver stub stands in for realpath canonicalization
 * (returning kernel-internal paths for symlinked detours).
 */
import { describe, it, expect } from "vitest";
import {
  collectModuleEdges,
  evaluateBoundaryRules,
} from "../org-write-boundary-gate.mjs";

type Edge = {
  specifier: string;
  valueBindings: string[];
  isValueEdge: boolean;
  kind: string;
  line: number;
};
type Violation = { rule: string; fileRel: string } & Edge;

const NO_RESOLVE = () => null;

function edgesOf(source: string): Edge[] {
  return collectModuleEdges("fixture.ts", source);
}
function check(
  fileRel: string,
  source: string,
  resolver: (spec: string) => string | null = NO_RESOLVE,
): Violation[] {
  return evaluateBoundaryRules(fileRel, edgesOf(source), resolver);
}

describe("org-write-boundary-gate rules (#1938)", () => {
  it("R1: a planted deep-subpath static import turns the gate red", () => {
    const v = check(
      "src/lib/some-writer.ts",
      'import { mintPermit } from "@cinatra-ai/org-write-kernel/src/permit";',
    );
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("R1-deep-subpath");
  });

  it("R1: a planted require() of a deep subpath turns the gate red", () => {
    const v = check(
      "src/lib/some-writer.ts",
      'const permit = require("@cinatra-ai/org-write-kernel/src/permit");',
    );
    // Both R1 (deep subpath) and the opaque-access rule fire — correct: two
    // independent boundaries are crossed by one require().
    expect(v.map((x) => x.rule)).toContain("R1-deep-subpath");
    expect(v[0].kind).toBe("require");
  });

  it("R1: a planted dynamic import() of a deep subpath turns the gate red", () => {
    const v = check(
      "src/lib/some-writer.ts",
      'const m = await import("@cinatra-ai/org-write-kernel/src/guard");',
    );
    expect(v.map((x) => x.rule)).toContain("R1-deep-subpath");
    expect(v[0].kind).toBe("dynamic");
  });

  it("R1: a relative path that RESOLVES into the kernel (symlink detour) is caught", () => {
    const v = check(
      "src/lib/some-writer.ts",
      'import { mintPermit } from "../sneaky-link/permit";',
      () => "packages/org-write-kernel/src/permit.ts",
    );
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("R1-relative-reach");
  });

  it("R1: the /testing subpath is legal FROM TEST FILES only (cinatra#1939 S3 fakes)", () => {
    const importLine =
      'import { fakeOrgWriteDb } from "@cinatra-ai/org-write-kernel/testing";';
    // Test files (both layouts) may import the fakes.
    expect(check("packages/dashboards/src/__tests__/x.test.ts", importLine)).toHaveLength(0);
    expect(check("src/lib/org-write/__tests__/y.test.ts", importLine)).toHaveLength(0);
    // A PRODUCTION file importing the fakes is still a violation — test
    // fakes must never answer real queries.
    const v = check("src/lib/some-writer.ts", importLine);
    expect(v.map((x) => x.rule)).toContain("R1-deep-subpath");
  });

  it("R1: the bare package root stays legal everywhere", () => {
    expect(
      check(
        "src/lib/some-writer.ts",
        'import { guardOrgMutation } from "@cinatra-ai/org-write-kernel";',
      ),
    ).toEqual([]);
  });

  it("R1: type-only deep imports are erased and exempt", () => {
    expect(
      check(
        "src/lib/some-writer.ts",
        'import type { OrgWritePermit } from "@cinatra-ai/org-write-kernel/src/permit";',
      ),
    ).toEqual([]);
  });

  it("R1: kernel-internal files may import their own internals", () => {
    expect(
      check(
        "packages/org-write-kernel/src/guard.ts",
        'import { mintPermit } from "./permit";',
        () => "packages/org-write-kernel/src/permit.ts",
      ),
    ).toEqual([]);
  });

  it("R2: a planted mintSystemWriteAuthority import outside the allowlist is red", () => {
    const v = check(
      "src/lib/rogue-job.ts",
      'import { mintSystemWriteAuthority } from "@/lib/org-write/authority";',
    );
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("R2-system-mint");
  });

  it("R2: a runtime re-export of the mint is also red", () => {
    const v = check(
      "src/lib/rogue-index.ts",
      'export { mintSystemWriteAuthority } from "@/lib/org-write/authority";',
    );
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("R2-system-mint");
  });

  it("R3: a guardedBatchQueries import outside the wrapper is red; the wrapper is legal", () => {
    const rogue = check(
      "src/lib/rogue-batch.ts",
      'import { guardedBatchQueries } from "@cinatra-ai/org-write-kernel";',
    );
    expect(rogue).toHaveLength(1);
    expect(rogue[0].rule).toBe("R3-batch-unwrap");

    expect(
      check(
        "src/lib/org-write/batch-wrapper.ts",
        'import { guardedBatchQueries } from "@cinatra-ai/org-write-kernel";',
      ),
    ).toEqual([]);
  });

  it("classifier: import { type X } (inline type) keeps the runtime edge but drops the binding", () => {
    const edges = edgesOf(
      'import { type OrgWritePermit, guardOrgMutation } from "@cinatra-ai/org-write-kernel";',
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].isValueEdge).toBe(true);
    expect(edges[0].valueBindings).toEqual(["guardOrgMutation"]);
  });
});

describe("opaque access forms are fail-closed", () => {
  it("a namespace import of the kernel root outside the allowlist is red", () => {
    const v = check(
      "src/lib/rogue-ns.ts",
      'import * as kernel from "@cinatra-ai/org-write-kernel";',
    );
    expect(v.map((x) => x.rule)).toContain("R3-batch-unwrap-opaque");
  });

  it("a bare require() of the kernel root outside the allowlist is red", () => {
    const v = check(
      "src/lib/rogue-req.ts",
      'const k = require("@cinatra-ai/org-write-kernel"); k.guardedBatchQueries;',
    );
    expect(v.map((x) => x.rule)).toContain("R3-batch-unwrap-opaque");
  });

  it("a namespace import of the authority module is red (mint reachable)", () => {
    const v = check(
      "src/lib/rogue-auth-ns.ts",
      'import * as auth from "@/lib/org-write/authority";',
    );
    expect(v.map((x) => x.rule)).toContain("R2-system-mint-opaque");
  });

  it("named imports of unrestricted bindings stay green", () => {
    expect(
      check(
        "src/lib/legit-consumer.ts",
        'import { guardOrgMutation } from "@cinatra-ai/org-write-kernel";\nimport { verifySessionAuthority } from "@/lib/org-write/authority";',
      ),
    ).toEqual([]);
  });
});

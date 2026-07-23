/**
 * cinatra#1938 — boundary-gate self-test: planted violations MUST turn the
 * gate red (the acceptance criterion), legitimate shapes must stay green.
 * Exercises the exported classifier + rule engine directly with in-memory
 * fixtures; the resolver stub stands in for realpath canonicalization
 * (returning kernel-internal paths for symlinked detours).
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module with exported engine
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
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("require");
  });

  it("R1: a planted dynamic import() of a deep subpath turns the gate red", () => {
    const v = check(
      "src/lib/some-writer.ts",
      'const m = await import("@cinatra-ai/org-write-kernel/src/guard");',
    );
    expect(v).toHaveLength(1);
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

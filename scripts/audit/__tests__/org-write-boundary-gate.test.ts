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

  it("the /testing subpath from a test file stays legal in its OPAQUE (dynamic-import) form — vi.mock factories can only reach the fakes that way", () => {
    const dynamicLine =
      'const fakes = await import("@cinatra-ai/org-write-kernel/testing");';
    // Sanctioned from test files: R1 admits the subpath and R3's opaque net
    // must not re-flag the same sanctioned edge.
    expect(check("packages/dashboards/src/__tests__/x.test.ts", dynamicLine)).toHaveLength(0);
    // From a PRODUCTION file the same dynamic import is still red (R1).
    const v = check("src/lib/some-writer.ts", dynamicLine);
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

describe("R2/R5: the agent-run mint file and its NAMED consumers (#1939 wave 2)", () => {
  const MINT = "@/lib/org-write/agent-run-authority-mint";
  const RESOLVE_TO_MINT = () => "src/lib/org-write/agent-run-authority-mint.ts";

  it("R2 allowlist: the mint file may import mintSystemWriteAuthority (sole minting site)", () => {
    expect(
      check(
        "src/lib/org-write/agent-run-authority-mint.ts",
        'import { mintSystemWriteAuthority } from "./authority";',
        () => "src/lib/org-write/authority.ts",
      ),
    ).toEqual([]);
  });

  it("a sanctioned job context may NAME a dispatch mint wrapper (green)", () => {
    expect(
      check(
        "packages/agents/src/execution.ts",
        `import { mintAgentRunExecutionAuthority } from "${MINT}";`,
      ),
    ).toEqual([]);
    expect(
      check(
        "src/lib/host-content-editor-dispatch.ts",
        `import { mintContentEditorDispatchAuthority } from "${MINT}";`,
      ),
    ).toEqual([]);
  });

  it("shape=alias: a non-consumer aliasing a wrapper is red (R5)", () => {
    const v = check(
      "src/lib/rogue-job.ts",
      `import { mintAgentRunExecutionAuthority as run } from "${MINT}";`,
    );
    expect(v.map((x) => x.rule)).toContain("R5-run-dispatch-mint");
  });

  it("shape=re-export: a non-consumer re-exporting a wrapper is red at the re-export site (R5)", () => {
    const v = check(
      "src/lib/rogue-index.ts",
      `export { mintTriggerReleaseAuthority } from "${MINT}";`,
    );
    expect(v.map((x) => x.rule)).toContain("R5-run-dispatch-mint");
  });

  it("shape=path-variant: a relative import resolving into the mint file is red (R5)", () => {
    const v = check(
      "src/lib/rogue-path.ts",
      'import { mintContentEditorDispatchAuthority } from "../org-write/agent-run-authority-mint";',
      RESOLVE_TO_MINT,
    );
    expect(v.map((x) => x.rule)).toContain("R5-run-dispatch-mint");
  });

  it("shape=import*: a namespace import of the mint file is red (opaque; caught by R2's org-write net)", () => {
    const v = check("src/lib/rogue-ns.ts", `import * as m from "${MINT}";`);
    expect(v.map((x) => x.rule)).toContain("R2-system-mint-opaque");
  });

  it("shape=dynamic import(): a dynamic import of the mint file is red (opaque)", () => {
    const v = check("src/lib/rogue-dyn.ts", `const m = await import("${MINT}");`);
    expect(v.map((x) => x.rule)).toContain("R2-system-mint-opaque");
  });

  it("shape=require: a require() of the mint file is red (opaque)", () => {
    const v = check("src/lib/rogue-req.ts", `const m = require("${MINT}");`);
    expect(v.map((x) => x.rule)).toContain("R2-system-mint-opaque");
  });
});

describe("R5: runManagementAuthority consumer allowlist (#1939 wave 2)", () => {
  const AUTH = "@/lib/org-write/authority";
  const line = `import { runManagementAuthority } from "${AUTH}";`;

  it("a run-management module may NAME runManagementAuthority (green)", () => {
    expect(check("packages/agents/src/orchestrator-actions.ts", line)).toEqual([]);
    expect(
      check(
        "packages/agents/src/mcp/handlers.ts",
        `import { runManagementAuthority, sessionAuthorityFromResolvedRole } from "${AUTH}";`,
      ),
    ).toEqual([]);
  });

  it("a test file may NAME runManagementAuthority (test-exempt, §5.2)", () => {
    expect(
      check("packages/agents/src/__tests__/orchestrator-actions.test.ts", line),
    ).toEqual([]);
  });

  it("a non-run-management module NAMING runManagementAuthority is red (R5)", () => {
    const v = check("src/lib/rogue-mgmt.ts", line);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("R5-run-management-authority");
  });

  it("an aliased runManagementAuthority import from a non-consumer is red (R5)", () => {
    const v = check(
      "src/lib/rogue-alias.ts",
      `import { runManagementAuthority as rm } from "${AUTH}";`,
    );
    expect(v.map((x) => x.rule)).toContain("R5-run-management-authority");
  });

  it("session-authority NAMED imports stay green everywhere (only runManagementAuthority is restricted)", () => {
    expect(
      check(
        "src/lib/some-other-consumer.ts",
        `import { sessionAuthorityFromResolvedRole, verifySessionAuthority } from "${AUTH}";`,
      ),
    ).toEqual([]);
  });
});

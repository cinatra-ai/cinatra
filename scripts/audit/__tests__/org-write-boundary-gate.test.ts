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
  extractR4Rules,
  evaluateR4,
  isTestFileRel,
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

// The R5 runManagementAuthority consumer-allowlist self-test was REMOVED with
// the mint itself (owner ruling 2026-07-26, ruling 2: cross-org run management is
// unsupported). authority.ts now carries no R5 named-consumer restriction; the
// R5 mechanism stays covered end-to-end by the run-dispatch-mint suite above.

// ---------------------------------------------------------------------------
// R4 — registry-driven writer import ban (#1939 wave 3, Decision 4)
// ---------------------------------------------------------------------------

/** Run evaluateR4 over in-memory files (source strings parsed by the real
 *  classifier) with a map-backed resolver. */
function r4(
  bannedRows: { module: string; exportName: string; allowedImporters: string[] }[],
  files: Array<[fileRel: string, source: string]>,
  resolveMap: Record<string, string>,
) {
  const parsed = files.map(([fileRel, source]) => ({
    fileRel,
    edges: collectModuleEdges(fileRel, source),
  }));
  const resolve = (_from: string, spec: string) => resolveMap[spec] ?? null;
  return evaluateR4(bannedRows, parsed, resolve);
}

const MUT = "packages/dashboards/src/mutation-service.ts";
const STORE = "packages/agents/src/store.ts";

describe("R4 registry parser (extractR4Rules) — fail-closed", () => {
  it("expands the dashboardsWriter helper AND explicit rows from literal data", () => {
    const rows = extractR4Rules(`
      const DASHBOARDS_MODULE = "packages/dashboards/src/mutation-service.ts";
      export const ORG_WRITE_REGISTRY = [
        dashboardsWriter("createDashboard", ["dashboards"], "upsert", 1, {
          importBanned: true, allowedImporters: ["packages/dashboards/src/actions.ts"],
        }),
        dashboardsWriter("materializeExtensionTemplate", ["dashboards"], "upsert", 2, {
          importBanned: false, importBanExemption: { issue: 1939, reason: "ext wave" },
        }),
        { module: "packages/agents/src/store.ts", exportName: "transitionRunStatus",
          importBanned: true, allowedImporters: ["packages/agents/src/index.ts"] },
      ];
    `);
    expect(rows).toEqual([
      { module: MUT, exportName: "createDashboard", importBanned: true, allowedImporters: ["packages/dashboards/src/actions.ts"] },
      { module: MUT, exportName: "materializeExtensionTemplate", importBanned: false, importBanExemption: { issue: 1939, reason: "ext wave" } },
      { module: STORE, exportName: "transitionRunStatus", importBanned: true, allowedImporters: ["packages/agents/src/index.ts"] },
    ]);
  });

  it("HARD-FAILS on a spread registry row (never silently omits a rule)", () => {
    expect(() =>
      extractR4Rules(`export const ORG_WRITE_REGISTRY = [ ...OTHER_ROWS ];`),
    ).toThrow();
  });

  it("HARD-FAILS on a non-literal module / importBanned field", () => {
    expect(() =>
      extractR4Rules(
        `export const ORG_WRITE_REGISTRY = [ { module: someVar, exportName: "x", importBanned: true, allowedImporters: [] } ];`,
      ),
    ).toThrow();
    expect(() =>
      extractR4Rules(
        `export const ORG_WRITE_REGISTRY = [ { module: "a.ts", exportName: "x", importBanned: FLAG } ];`,
      ),
    ).toThrow();
  });

  it("HARD-FAILS on a row that OMITS importBanned (no fail-open default)", () => {
    expect(() =>
      extractR4Rules(
        `export const ORG_WRITE_REGISTRY = [ { module: "a.ts", exportName: "x", allowedImporters: [] } ];`,
      ),
    ).toThrow();
    // ...and on a dashboardsWriter() call missing its literal ban argument.
    expect(() =>
      extractR4Rules(
        `const DASHBOARDS_MODULE = "m.ts"; export const ORG_WRITE_REGISTRY = [ dashboardsWriter("x", ["a"], "upsert", 1) ];`,
      ),
    ).toThrow();
  });
});

describe("R4 writer import ban (evaluateR4)", () => {
  const banned = [
    { module: MUT, exportName: "createDashboard", allowedImporters: ["packages/dashboards/src/actions.ts"] },
  ];

  it("a banned import from a NON-allowlisted file turns the gate red (the acceptance fixture)", () => {
    const v = r4(
      banned,
      [["src/lib/rogue.ts", 'import { createDashboard } from "@cinatra-ai/dashboards";']],
      { "@cinatra-ai/dashboards": MUT },
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "R4-writer-import", fileRel: "src/lib/rogue.ts", writer: `${MUT}#createDashboard` });
  });

  it("the allowlisted caller stays green", () => {
    const v = r4(
      banned,
      [["packages/dashboards/src/actions.ts", 'import { createDashboard } from "./mutation-service";']],
      { "./mutation-service": MUT },
    );
    expect(v).toEqual([]);
  });

  it("an alias resolves to the original banned name and is caught", () => {
    const v = r4(
      banned,
      [["src/lib/rogue.ts", 'import { createDashboard as cd } from "@cinatra-ai/dashboards";']],
      { "@cinatra-ai/dashboards": MUT },
    );
    expect(v.map((x) => x.rule)).toContain("R4-writer-import");
  });

  it("transitive re-export closure: a barrel re-export is a violation AND poisons imports of the barrel", () => {
    const barrel = "packages/dashboards/src/index.ts";
    const v = r4(
      banned,
      [
        // the barrel re-exports the banned writer from the origin
        [barrel, 'export { createDashboard } from "./mutation-service";'],
        // a consumer imports it via the barrel (root specifier)
        ["src/lib/consumer.ts", 'import { createDashboard } from "@cinatra-ai/dashboards";'],
      ],
      { "./mutation-service": MUT, "@cinatra-ai/dashboards": barrel },
    );
    // both the barrel (leak) and the consumer (via poisoned barrel) are caught
    expect(v.map((x) => x.fileRel).sort()).toEqual([barrel, "src/lib/consumer.ts"]);
    expect(v.every((x) => x.rule === "R4-writer-import")).toBe(true);
  });

  it("opaque access is fail-closed on the ORIGIN module AND on a poisoned re-export barrel", () => {
    const barrel = "packages/dashboards/src/index.ts";
    const files: Array<[string, string]> = [
      [barrel, 'export { createDashboard } from "./mutation-service";'],
      ["src/lib/ns-origin.ts", 'import * as m from "@cinatra-ai/dashboards/mutation";'], // origin → opaque violation
      ["src/lib/ns-barrel.ts", 'import * as b from "@cinatra-ai/dashboards";'], // poisoned barrel → also a violation
    ];
    const v = r4(banned, files, {
      "./mutation-service": MUT,
      "@cinatra-ai/dashboards/mutation": MUT,
      "@cinatra-ai/dashboards": barrel,
    });
    const opaque = v.filter((x) => x.rule === "R4-writer-import-opaque").map((x) => x.fileRel).sort();
    expect(opaque).toEqual(["src/lib/ns-barrel.ts", "src/lib/ns-origin.ts"]);
  });

  it("opaque access requires the file be allowed for EVERY banned export of the module (intersection)", () => {
    const twoBanned = [
      { module: STORE, exportName: "transitionRunStatus", allowedImporters: ["src/lib/one.ts"] },
      { module: STORE, exportName: "updateAgentRunStatus", allowedImporters: [] },
    ];
    // Allowed for transitionRunStatus but NOT updateAgentRunStatus → a namespace
    // import still reaches the delegate, so it is flagged.
    const flagged = r4(
      twoBanned,
      [["src/lib/one.ts", 'import * as s from "@cinatra-ai/agents/store";']],
      { "@cinatra-ai/agents/store": STORE },
    );
    expect(flagged.map((x) => x.rule)).toEqual(["R4-writer-import-opaque"]);
    // Allowed for BOTH → clean.
    const both = [
      { module: STORE, exportName: "transitionRunStatus", allowedImporters: ["src/lib/both.ts"] },
      { module: STORE, exportName: "updateAgentRunStatus", allowedImporters: ["src/lib/both.ts"] },
    ];
    expect(
      r4(both, [["src/lib/both.ts", 'import * as s from "@cinatra-ai/agents/store";']], { "@cinatra-ai/agents/store": STORE }),
    ).toEqual([]);
  });

  it("an ALIASED re-export cannot leak a banned writer past the closure", () => {
    const barrel = "packages/dashboards/src/index.ts";
    const v = r4(
      banned,
      [
        [barrel, 'export { createDashboard as makeDashboard } from "./mutation-service";'],
        ["src/lib/consumer.ts", 'import { makeDashboard } from "@cinatra-ai/dashboards";'],
      ],
      { "./mutation-service": MUT, "@cinatra-ai/dashboards": barrel },
    );
    // The barrel re-exports the banned SOURCE name (violation) and the consumer
    // importing the ALIASED name is caught (closure poisoned `makeDashboard`).
    expect(v.map((x) => x.fileRel).sort()).toEqual([barrel, "src/lib/consumer.ts"]);
    expect(v.every((x) => x.rule === "R4-writer-import")).toBe(true);
  });

  it("a namespace re-export (`export * as ns from banned`) cannot leak via `import { ns }`", () => {
    const barrel = "packages/dashboards/src/index.ts";
    const v = r4(
      banned,
      [
        [barrel, 'export * as dash from "./mutation-service";'],
        ["src/lib/consumer.ts", 'import { dash } from "@cinatra-ai/dashboards";'],
      ],
      { "./mutation-service": MUT, "@cinatra-ai/dashboards": barrel },
    );
    const files = v.map((x) => x.fileRel).sort();
    // the barrel is an opaque violation; importing the `dash` namespace is caught
    expect(files).toContain(barrel);
    expect(files).toContain("src/lib/consumer.ts");
  });

  it("a destructured dynamic import is treated as a NAMED import (precise, not opaque)", () => {
    const hit = r4(
      banned,
      [["src/lib/dyn.ts", 'const { createDashboard } = await import("@cinatra-ai/dashboards");']],
      { "@cinatra-ai/dashboards": MUT },
    );
    expect(hit.map((x) => x.rule)).toEqual(["R4-writer-import"]);
    const miss = r4(
      banned,
      [["src/lib/dyn2.ts", 'const { somethingElse } = await import("@cinatra-ai/dashboards");']],
      { "@cinatra-ai/dashboards": MUT },
    );
    expect(miss).toEqual([]);
  });

  it("empty allowlist = total ban (an internal delegate has zero legal importers)", () => {
    const v = r4(
      [{ module: STORE, exportName: "updateAgentRunStatus", allowedImporters: [] }],
      [["src/lib/rogue.ts", 'import { updateAgentRunStatus } from "@cinatra-ai/agents/store";']],
      { "@cinatra-ai/agents/store": STORE },
    );
    expect(v.map((x) => x.rule)).toEqual(["R4-writer-import"]);
  });

  it("test files are exempt (runtime authority still binds them via the kernel fakes)", () => {
    expect(isTestFileRel("src/lib/__tests__/x.test.ts")).toBe(true);
    const v = r4(
      banned,
      [["src/lib/__tests__/x.test.ts", 'import { createDashboard } from "@cinatra-ai/dashboards";']],
      { "@cinatra-ai/dashboards": MUT },
    );
    expect(v).toEqual([]);
  });

  it("type-only imports are erased and never a violation", () => {
    const v = r4(
      banned,
      [["src/lib/rogue.ts", 'import type { createDashboard } from "@cinatra-ai/dashboards";']],
      { "@cinatra-ai/dashboards": MUT },
    );
    expect(v).toEqual([]);
  });
});

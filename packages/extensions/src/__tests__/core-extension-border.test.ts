// THE CORE/EXTENSION BORDER: WHAT THIS SUITE CHECKS AND WHAT THE STEP CHECKS.
//
// This file lives in packages/extensions/src/__tests__/ on purpose: the
// `Canonical extension invariants` job runs the WHOLE package
// (`cd packages/extensions && pnpm test`), so a border regression fails that
// job without any workflow edit. That job is not one of the checks the
// protection of main requires.
//
// WHAT THIS SUITE CHECKS:
//   1. FIXTURES — a synthetic snippet per crossing class, proving the scanner
//      catches the class rather than one file that happens to be on main.
//   2. THE REPOSITORY — the same scanner over the real tree, proving the
//      committed ledger covers exactly the standing debt and nothing new. It
//      compares the code with the ledger of the checkout ITSELF, so it cannot
//      see a pull request that adds a crossing together with its ledger entry.
//   3. THE BASE GUARD'S LOGIC — against temporary git repositories: a ledger
//      that grew against the base branch fails, one that shrank passes, a base
//      that cannot be read fails with its reason, and a stale entry fails.
//
// WHAT THE STEP CHECKS: the step `Core/extension border — base guard` of the
// job `gates-pnpm` in .github/workflows/gates.yml runs
// scripts/ci/core-extension-border-gate.mjs with CORE_EXTENSION_BORDER_BASE set
// to the pull request's base. The gate compares the committed ledger with the
// copy on that base (a new entry, a new recorded file or a raised count fails),
// fails closed on a base it cannot read, fails on any crossing outside the
// ledger and fails on a stale entry.

import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const GATE_PATH = path.join(REPO_ROOT, "scripts", "ci", "core-extension-border-gate.mjs");
// The old config/ path is read only so this file still loads on the base tree of
// the move, where the list has not moved yet.
const NEW_BASELINE_PATH = path.join(REPO_ROOT, "scripts", "ci", "core-extension-border-baseline.json");
const BASELINE_PATH = existsSync(NEW_BASELINE_PATH)
  ? NEW_BASELINE_PATH
  : path.join(REPO_ROOT, "config", "core-extension-border-baseline.json");

type Finding = {
  rule: string;
  file: string;
  line: number;
  detail: string;
  message: string;
};

type GateModule = {
  maskComments: (text: string) => string;
  packNameTokens: (packs: Iterable<string>) => Set<string>;
  admissionCrossesBorder: (tool: string, tokens: Set<string>) => string | null;
  scanTextForCrossings: (input: {
    file: string;
    text: string;
    packs: Set<string>;
    workspacePackages: Set<string>;
  }) => Finding[];
  scanScopedToolAdmissions: (input: { file: string; text: string; packs: Set<string> }) => Finding[];
  legacyExceptionFindings: (input: { file: string; doc: unknown }) => Finding[];
  loadPackUniverse: (
    repoRoot: string,
    baselineEntries?: { rule: string; key: string }[],
  ) => { packs: Set<string>; workspacePackages: Set<string> };
  readBaseline: (baselinePath: string) => {
    entries: { rule: string; key: string; reason: string }[];
    keys: Set<string>;
    reasons: Map<string, string>;
  };
  unjustifiedBaselineEntries: (baseline: unknown) => string[];
  baselineDefects: (baseline: unknown) => string[];
  baselineGrowth: (previous: unknown, current: unknown) => string[];
  packTypeNamespaces: (packs: Set<string>, workspacePackages?: Set<string>) => Map<string, string>;
  walkProductFiles: (dir: string, acc?: string[], repoRoot?: string | null) => string[];
  GENERATED_PATHS: Set<string>;
  keyOf: (finding: Finding) => string;
  violationsOf: (findings: Finding[], keys: Set<string>) => Finding[];
  scanRepository: (input: { repoRoot: string; baselinePath?: string; ports?: boolean }) => {
    findings: Finding[];
    violations: Finding[];
    stale: string[];
  };
  shrinkPackShapedEntries: (
    repoRoot: string,
    previousEntries: { rule: string; key: string; reason: string; files?: Record<string, number> }[],
  ) => {
    entries: { rule: string; key: string; reason: string; files: Record<string, number> }[];
    refused: string[];
  };
  FLOOR_BASE_VAR: string;
  FLOOR_FILE: string;
  checkFloorAgainstBase: (input?: {
    repoRoot?: string;
    env?: Record<string, string | undefined>;
    headFloor?: unknown;
  }) => { status: string; ok: boolean; lines: string[]; ref?: string; growth?: string[] };
  staleVerdict: (stale: string[]) => { ok: boolean; lines: string[] };
  KNOWN_RULES: Set<string>;
  rulesListDefects: (doc: unknown, opts?: { requireList?: boolean }) => string[];
  packStepWordRuns: (packs: Iterable<string>) => Set<string>;
  kindCrossesBorder: (kind: string, runs: Set<string>) => string | null;
  scanStepScreenKindTables: (input: { file: string; text: string; packs: Set<string> }) => {
    findings: Finding[];
    tables: number;
  };
};

const gate: GateModule = (await import(pathToFileURL(GATE_PATH).href)) as unknown as GateModule;

const PACKS = new Set(["@cinatra-ai/blog-pipeline-agent", "@cinatra-ai/screenshot-artifact"]);
const WORKSPACE = new Set(["@cinatra-ai/agents", "@cinatra-ai/extensions", "@cinatra-ai/chat"]);

function scan(file: string, text: string): Finding[] {
  return gate.scanTextForCrossings({ file, text, packs: PACKS, workspacePackages: WORKSPACE });
}

describe("core/extension border — fixture detection per crossing class", () => {
  it("catches a pack's physical table name spelled in core", () => {
    const found = scan(
      "src/lib/blog/stored-ideas-gate.ts",
      'export const IDEA_RELATION_TABLE = "ext_cinatra_ai_blog_pipeline_agent_idea_drafts";\n',
    );
    expect(found.map((f) => f.rule)).toContain("pack-table-literal");
    expect(found[0].line).toBe(1);
    expect(found[0].detail).toBe("ext_cinatra_ai_blog_pipeline_agent_idea_drafts");
  });

  it("catches a pack's type id hard-coded in core", () => {
    const found = scan(
      "packages/agents/src/synthetic-core-binding-fixture.tsx",
      'const BINDING = "@cinatra-ai/blog-pipeline-agent:idea-selection";\n',
    );
    expect(found.map((f) => f.rule)).toEqual(["pack-type-id-in-core"]);
    expect(found[0].detail).toBe("@cinatra-ai/blog-pipeline-agent:idea-selection");
  });

  it("catches a package-name branch in product code", () => {
    const found = scan(
      "src/lib/router.ts",
      'if (packageName === "@cinatra-ai/blog-pipeline-agent") { return special(); }\n',
    );
    expect(found.map((f) => f.rule)).toEqual(["pack-package-name-branch"]);
  });

  it("catches the reversed package-name branch too", () => {
    const found = scan("src/lib/router.ts", 'if ("@cinatra-ai/screenshot-artifact" !== name) {}\n');
    expect(found.map((f) => f.rule)).toEqual(["pack-package-name-branch"]);
  });

  it("catches a host-authored duplicate of a pack's declaration by its type anchor", () => {
    const found = scan(
      "src/lib/artifacts/featured-image-fields.ts",
      [
        'const TYPE = "@cinatra-ai/screenshot-artifact:picture";',
        'export const FEATURED_PLACEMENT = "featured" as const;',
      ].join("\n") + "\n",
    );
    expect(found.map((f) => f.rule)).toEqual(["pack-type-id-in-core"]);
    expect(found[0].line).toBe(1);
  });

  it("states its limit: a restated value with no pack anchor is not text-detectable", () => {
    // The gate catches a duplicated declaration through the pack type id the
    // duplicate is written against. A bare value with nothing tying it to a
    // pack ("featured") is indistinguishable from any other host constant, and
    // the contract says so rather than the gate pretending otherwise.
    expect(scan("src/lib/x.ts", 'export const PLACEMENT = "featured" as const;\n')).toEqual([]);
  });

  it("catches a package-name branch written as a switch case", () => {
    const found = scan(
      "src/lib/router.ts",
      'switch (name) { case "@cinatra-ai/blog-pipeline-agent": return a(); }\n',
    );
    expect(found.map((f) => f.rule)).toEqual(["pack-package-name-branch"]);
  });

  it("catches a pack-named admission in a lower-camel tool set too", () => {
    const found = gate.scanScopedToolAdmissions({
      file: "src/lib/x.ts",
      text: 'const runScopedTools = new Set(["objects_save", "blog_pipeline_ideas"]);\n',
      packs: PACKS,
    });
    expect(found.map((f) => f.detail)).toEqual(["blog_pipeline_ideas"]);
  });

  it("counts a repeated crossing so a second occurrence cannot ride the first entry", () => {
    const found = scan(
      "src/lib/x.ts",
      [
        'const a = "ext_cinatra_ai_blog_pipeline_agent_idea_drafts";',
        'const b = "ext_cinatra_ai_blog_pipeline_agent_idea_drafts";',
      ].join("\n") + "\n",
    );
    expect(found.map((f) => f.detail)).toEqual([
      "ext_cinatra_ai_blog_pipeline_agent_idea_drafts",
      "ext_cinatra_ai_blog_pipeline_agent_idea_drafts (occurrence 2)",
    ]);
  });

  it("catches a passthrough tool admitted under one pack's name", () => {
    const found = gate.scanScopedToolAdmissions({
      file: "src/lib/extension-scoped-tools.ts",
      text: [
        "export const EXTENSION_SCOPED_TOOLS = new Set<string>([",
        '  "extension_data",',
        '  "artifacts_list",',
        '  "artifacts_get",',
        '  "artifact_content_read",',
        '  "blog_pipeline_ideas",',
        "]);",
      ].join("\n"),
      packs: PACKS,
    });
    expect(found.map((f) => f.detail)).toEqual(["blog_pipeline_ideas"]);
    expect(found[0].rule).toBe("pack-named-passthrough");
  });

  it("leaves the four generic, scope-derived admissions alone", () => {
    const tokens = gate.packNameTokens(PACKS);
    for (const generic of ["extension_data", "artifacts_list", "artifacts_get", "artifact_content_read"]) {
      expect(gate.admissionCrossesBorder(generic, tokens)).toBeNull();
    }
  });

  it("reports every entry of the shrink-only skill legacy list", () => {
    const found = gate.legacyExceptionFindings({
      file: "config/skill-packaging-legacy-exceptions.json",
      doc: {
        exceptions: [],
        embeddedSkills: [
          "@cinatra-ai/media-transcript-agent :: skills/transcribe-media/SKILL.md",
          "@cinatra-ai/screenshot-artifact :: skills/screenshot-matcher/SKILL.md",
        ],
      },
    });
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.rule === "skill-legacy-exception")).toBe(true);
    // A NEW entry is a violation because only the recorded one is baselined.
    const baselined = new Set([
      gate.keyOf(found[0]),
    ]);
    const violations = gate.violationsOf(found, baselined);
    expect(violations.map((f) => f.detail)).toEqual([
      "embeddedSkills :: @cinatra-ai/screenshot-artifact :: skills/screenshot-matcher/SKILL.md",
    ]);
  });

  it("refuses a duplicated legacy-list value instead of letting it ride the first", () => {
    const found = gate.legacyExceptionFindings({
      file: "config/skill-packaging-legacy-exceptions.json",
      doc: {
        exceptions: [],
        embeddedSkills: [
          "@cinatra-ai/media-transcript-agent :: skills/transcribe-media/SKILL.md",
          "@cinatra-ai/media-transcript-agent :: skills/transcribe-media/SKILL.md",
        ],
      },
    });
    const baselined = new Set([gate.keyOf(found[0])]);
    expect(gate.violationsOf(found, baselined)).toHaveLength(1);
  });

  it("does not flag a pack named only in a comment", () => {
    const text = [
      '// A run of "@cinatra-ai/blog-pipeline-agent:idea-selection" declares its own type.',
      "/* ext_cinatra_ai_blog_pipeline_agent_idea_drafts is the pack's own table. */",
      "export const ok = 1;",
    ].join("\n");
    expect(scan("src/lib/notes.ts", text)).toEqual([]);
  });

  it("does not flag a branch on a workspace package of this repository", () => {
    expect(scan("packages/skills/src/x.ts", 'if (packageName === "@cinatra-ai/chat") {}\n')).toEqual([]);
  });

  it("does not flag the reserved host namespace", () => {
    expect(scan("src/lib/x.ts", 'const S = "@cinatra-ai/host:wordpress-mcp";\n')).toEqual([]);
    expect(scan("src/lib/y.ts", 'if (p === "@cinatra-ai/host") {}\n')).toEqual([]);
  });

  it("masks comments without moving line numbers", () => {
    const masked = gate.maskComments("const a = 1;\n/* two\n   lines */\nconst b = 2;\n");
    expect(masked.split("\n")).toHaveLength(5);
    expect(masked).not.toContain("lines");
  });

  it("does not mistake a URL inside a string for a comment", () => {
    const found = scan(
      "src/lib/x.ts",
      'const u = "https://example.invalid/a"; const t = "@cinatra-ai/blog-pipeline-agent:idea";\n',
    );
    expect(found.map((f) => f.rule)).toEqual(["pack-type-id-in-core"]);
  });
});

describe("core/extension border — the repository itself", () => {
  const result = gate.scanRepository({ repoRoot: REPO_ROOT, baselinePath: BASELINE_PATH });

  it("is clean against the committed baseline", () => {
    expect(result.violations.map((f) => `${f.rule} ${f.file} ${f.detail}`)).toEqual([]);
  });

  it("names and justifies every baseline entry, with no wildcard", () => {
    const doc = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    expect(gate.unjustifiedBaselineEntries(doc)).toEqual([]);
    for (const entry of doc.entries) {
      expect(entry.key).not.toContain("*");
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it("carries the standing debt the audit named", () => {
    const baseline = gate.readBaseline(BASELINE_PATH);
    const keys = [...baseline.keys].join("\n");
    expect(keys).toContain("src/lib/blog");
    expect(keys).toContain("packages/agents/src/campaign-recipients-review-renderer.tsx");
    expect(keys).toContain("packages/agents/src/email-drafts-review-renderer.tsx");
  });

  it("fails closed when the committed locks are not there to read", () => {
    expect(() => gate.loadPackUniverse(path.join(REPO_ROOT, "docs"))).toThrow(/pack universe/i);
  });

  it("reads the pack universe from the committed locks", () => {
    const { packs, workspacePackages } = gate.loadPackUniverse(REPO_ROOT);
    expect(packs.size).toBeGreaterThan(50);
    expect(workspacePackages.has("@cinatra-ai/extensions")).toBe(true);
    expect(packs.has("@cinatra-ai/extensions")).toBe(false);
  });
});

// THE CONVERGENCE ROUND. Each test below was written RED against the first
// scanner: it names one way a real crossing slipped past, or one way the
// ratchet could be widened instead of shrunk.

describe("core/extension border — evasions the scanner must not fall for", () => {
  it("names a pack in a lookup list, with no comparison operator beside it", () => {
    // `=== "@cinatra-ai/..."` was the only shape the branch rule read, so an
    // ordinary lookup table or `.includes([...])` list carried the same
    // behaviour past it.
    const found = scan(
      "src/lib/x.ts",
      'const SPECIAL = ["@cinatra-ai/blog-pipeline-agent"];\nif (SPECIAL.includes(pkg)) special();\n',
    );
    expect(found.map((f) => f.rule)).toEqual(["pack-package-name-branch"]);
    expect(found[0].detail).toBe("@cinatra-ai/blog-pipeline-agent");
  });

  it("names a pack used as a computed object key", () => {
    const found = scan("src/lib/x.ts", 'const forms = { ["@cinatra-ai/blog-pipeline-agent"]: ["title"] };\n');
    expect(found.map((f) => f.rule)).toEqual(["pack-package-name-branch"]);
  });

  it("reports a pack name only once, not once per matching rule shape", () => {
    const found = scan("src/lib/x.ts", 'if (pkg === "@cinatra-ai/blog-pipeline-agent") go();\n');
    expect(found.filter((f) => f.rule === "pack-package-name-branch")).toHaveLength(1);
  });

  it("catches a type id declared under the pack's bare stem, not its package name", () => {
    // `@cinatra-ai/email-artifacts` declares `@cinatra-ai/email:*`. Reading only
    // the package spelling made every restatement of those types invisible.
    const packs = new Set(["@cinatra-ai/email-artifacts"]);
    const found = gate.scanTextForCrossings({
      file: "packages/objects/src/integration/register-types.ts",
      text: 'registerType({ type: "@cinatra-ai/email:recipient", schema });\n',
      packs,
      workspacePackages: WORKSPACE,
    });
    expect(found.map((f) => f.rule)).toEqual(["pack-type-id-in-core"]);
    expect(found[0].message).toContain("@cinatra-ai/email-artifacts");
  });

  it("does not read a host namespace as a pack merely because a pack name starts with it", () => {
    const namespaces = gate.packTypeNamespaces(
      new Set(["@cinatra-ai/chat-assistant-core-agent"]),
      new Set(["@cinatra-ai/chat-assistant-core"]),
    );
    expect(namespaces.has("@cinatra-ai/chat-assistant-core")).toBe(false);
  });

  it("catches an admission spelled through a same-file constant", () => {
    // `new Set([...GENERIC, BLOG_TOOL])` admits the tool exactly as the inline
    // literal does; only the literal form was read before.
    const found = gate.scanScopedToolAdmissions({
      file: "src/lib/extension-scoped-tools.ts",
      text:
        'const BLOG_TOOL = "blog_pipeline_ideas";\n' +
        "export const EXTENSION_SCOPED_TOOLS = new Set([...GENERIC_TOOLS, BLOG_TOOL]);\n",
      packs: PACKS,
    });
    expect(found).toHaveLength(1);
    expect(found[0].detail).toBe("blog_pipeline_ideas");
  });

  it("keeps a real crossing that sits after a regular expression holding a slash", () => {
    // Without regex-literal state the masker read the `/` inside the character
    // class as a block comment and blanked the rest of the file — losing the
    // crossing on the next line.
    const text = 'const delimiter = /[/*]/;\nconst TYPE = "@cinatra-ai/blog-pipeline-agent:idea";\n';
    expect(gate.maskComments(text)).toContain("@cinatra-ai/blog-pipeline-agent:idea");
    const found = scan("src/lib/x.ts", text);
    expect(found.map((f) => f.rule)).toEqual(["pack-type-id-in-core"]);
    expect(found[0].line).toBe(2);
  });

  it("scans an ordinary directory that happens to be named generated", () => {
    // Only the materializer's own map directory is crossing (2). Skipping every
    // directory of that name anywhere gave a crossing a place to hide.
    expect(gate.GENERATED_PATHS.has("src/lib/generated")).toBe(true);
    expect(gate.GENERATED_PATHS.has("packages/objects/src/generated")).toBe(false);
  });
});

describe("core/extension border — the ratchet only shrinks", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    rule: "pack-shaped-core-domain",
    key: "src/lib/blog",
    reason: "standing debt recorded when the gate landed, kept file by file",
    files: { "src/lib/blog/store.ts": 1606 },
    ...over,
  });

  it("refuses a ledger that gained an entry", () => {
    const previous = { rules: [...gate.KNOWN_RULES], entries: [entry()] };
    const current = {
      entries: [
        entry(),
        { rule: "pack-table-literal", key: "src/lib/blog/new.ts::ext_cinatra_ai_x_y", reason: "a reason long enough" },
      ],
    };
    expect(gate.baselineGrowth(previous, current)).toEqual([
      "new entry: pack-table-literal::src/lib/blog/new.ts::ext_cinatra_ai_x_y",
    ]);
  });

  it("refuses a ledger that raised a recorded allowance", () => {
    const grown = gate.baselineGrowth(
      { rules: [...gate.KNOWN_RULES], entries: [entry()] },
      { entries: [entry({ files: { "src/lib/blog/store.ts": 1700 } })] },
    );
    expect(grown).toEqual(["raised allowance under pack-shaped-core-domain::src/lib/blog: src/lib/blog/store.ts 1606 -> 1700"]);
  });

  it("refuses a ledger that recorded a new file inside a module", () => {
    const grown = gate.baselineGrowth(
      { rules: [...gate.KNOWN_RULES], entries: [entry()] },
      { entries: [entry({ files: { "src/lib/blog/store.ts": 1606, "src/lib/blog/gate.ts": 40 } })] },
    );
    expect(grown).toEqual(["new file recorded under pack-shaped-core-domain::src/lib/blog: src/lib/blog/gate.ts"]);
  });

  it("accepts a ledger that only lost entries and lowered allowances", () => {
    expect(
      gate.baselineGrowth(
        { rules: [...gate.KNOWN_RULES], entries: [entry(), { rule: "pack-table-literal", key: "a::b", reason: "gone now" }] },
        { entries: [entry({ files: { "src/lib/blog/store.ts": 1200 } })] },
      ),
    ).toEqual([]);
  });
});

describe("core/extension border — the ledger is validated, not merely read", () => {
  const ok = { rule: "pack-table-literal", key: "src/a.ts::ext_cinatra_ai_x", reason: "a stated reason, long enough" };

  it("refuses an unknown rule", () => {
    expect(gate.baselineDefects({ entries: [{ ...ok, rule: "made-up" }] })).toContain(
      "unknown rule: made-up::src/a.ts::ext_cinatra_ai_x",
    );
  });

  it("refuses a duplicate entry", () => {
    expect(gate.baselineDefects({ entries: [ok, ok] })).toContain(
      "duplicate entry: pack-table-literal::src/a.ts::ext_cinatra_ai_x",
    );
  });

  it("refuses a pack-shaped module with no recorded line map", () => {
    expect(
      gate.baselineDefects({ entries: [{ rule: "pack-shaped-core-domain", key: "src/lib/blog", reason: "r" }] }),
    ).toContain("no recorded line map: pack-shaped-core-domain::src/lib/blog");
  });

  it("refuses a module key broad enough to be a shape", () => {
    expect(
      gate.baselineDefects({
        entries: [{ rule: "pack-shaped-core-domain", key: "src", reason: "r", files: {} }],
      }).join("\n"),
    ).toContain("must name a path under");
  });

  it("refuses a recorded file that sits outside the module it is recorded under", () => {
    expect(
      gate.baselineDefects({
        entries: [
          { rule: "pack-shaped-core-domain", key: "src/lib/blog", reason: "r", files: { "src/lib/email/x.ts": 3 } },
        ],
      }).join("\n"),
    ).toContain("outside the module");
  });

  it("accepts the committed ledger", () => {
    expect(gate.baselineDefects(JSON.parse(readFileSync(BASELINE_PATH, "utf8")))).toEqual([]);
  });

  it("fails closed when the ledger is absent, rather than reading it as empty", () => {
    expect(() => gate.readBaseline(path.join(REPO_ROOT, "config", "no-such-ledger.json"))).toThrow(/fails closed/i);
  });
});

describe("core/extension border — the pack universe is durable", () => {
  it("keeps a pack the ledger names even after it leaves the locks", () => {
    // Acquisition membership changes. A recorded crossing may not become
    // invisible because the pack it names was unpinned.
    const { packs } = gate.loadPackUniverse(REPO_ROOT, [
      { rule: "pack-type-id-in-core", key: "src/lib/x.ts::@cinatra-ai/not-in-any-lock-agent:thing" },
    ]);
    expect(packs.has("@cinatra-ai/not-in-any-lock-agent")).toBe(true);
  });
});

describe("core/extension border — the writer drops a spent entry", () => {
  const REASON = "standing debt recorded in a fixture, kept file by file";
  const exampleEntry = () => ({
    rule: "pack-shaped-core-domain",
    key: "src/lib/example-module",
    reason: REASON,
    files: { "src/lib/example-module/a.ts": 3, "src/lib/example-module/b.ts": 2 },
  });
  const otherEntry = () => ({
    rule: "pack-shaped-core-domain",
    key: "src/lib/other-module",
    reason: REASON,
    files: { "src/lib/other-module/c.ts": 4 },
  });

  // Each arm builds its own temporary tree and removes it, whatever the arm reads.
  function inTree(files: Record<string, number>, read: (dir: string) => void) {
    const dir = mkdtempSync(path.join(tmpdir(), "border-writer-"));
    try {
      for (const [rel, lines] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, Array.from({ length: lines }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
      }
      read(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("leaves out an entry whose module is gone", () => {
    inTree({ "src/lib/other-module/c.ts": 4 }, (dir) => {
      const { entries, refused } = gate.shrinkPackShapedEntries(dir, [exampleEntry(), otherEntry()]);
      expect(entries).toEqual([{ ...otherEntry(), files: { "src/lib/other-module/c.ts": 4 } }]);
      expect(refused).toEqual([]);
    });
  });

  it("leaves out a single-file entry whose file is gone", () => {
    inTree({}, (dir) => {
      const { entries } = gate.shrinkPackShapedEntries(dir, [
        {
          rule: "pack-shaped-core-domain",
          key: "src/lib/example-module/one.ts",
          reason: REASON,
          files: { "src/lib/example-module/one.ts": 5 },
        },
      ]);
      expect(entries).toEqual([]);
    });
  });

  it("keeps the files that remain when only some are gone", () => {
    inTree({ "src/lib/example-module/a.ts": 3 }, (dir) => {
      const { entries, refused } = gate.shrinkPackShapedEntries(dir, [exampleEntry()]);
      expect(entries).toEqual([{ ...exampleEntry(), files: { "src/lib/example-module/a.ts": 3 } }]);
      expect(refused).toEqual([]);
    });
  });

  it("keeps the entry of a module that lost its files but gained a new one, and refuses the growth", () => {
    inTree({ "src/lib/example-module/z.ts": 1 }, (dir) => {
      const { entries, refused } = gate.shrinkPackShapedEntries(dir, [exampleEntry()]);
      expect(entries).toEqual([{ ...exampleEntry(), files: {} }]);
      expect(refused).toEqual(["src/lib/example-module :: src/lib/example-module/z.ts is a NEW file"]);
    });
  });

  it("names an entry with an empty line map as stale", () => {
    const defects = gate.baselineDefects({
      entries: [{ rule: "pack-shaped-core-domain", key: "src/lib/example-module", reason: REASON, files: {} }],
    });
    const stale = defects.filter(
      (d) => d.includes("stale entry") && d.includes("pack-shaped-core-domain::src/lib/example-module"),
    );
    expect(stale).toHaveLength(1);
  });

  it("finds no defect in a live entry", () => {
    expect(
      gate.baselineDefects({
        entries: [
          {
            rule: "pack-shaped-core-domain",
            key: "src/lib/example-module",
            reason: REASON,
            files: { "src/lib/example-module/a.ts": 3 },
          },
        ],
      }),
    ).toEqual([]);
  });
});

// cinatra#3831: the committed ledger is compared with the copy on the base
// branch, entry by entry and count by count, so a pull request cannot admit a
// crossing by writing its entry into the ledger in the same change. The git
// fixture is the one the sibling floor gates use; every call passes its
// environment explicitly, so a CI run's own base variables never reach a case.
type FloorFixture = {
  makeFloorRepo: (input: { base: Record<string, unknown>; head: Record<string, unknown> }) => {
    root: string;
    cleanup: () => void;
  };
  PULL_REQUEST_RUN: Record<string, string>;
  UNREADABLE_BASE_RUN: Record<string, string>;
  envWithoutBase: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

const floorFixture: FloorFixture = (await import(
  pathToFileURL(path.join(REPO_ROOT, "scripts", "audit", "__tests__", "floor-base-fixture.mjs")).href
)) as unknown as FloorFixture;

describe("core/extension border — the floor is compared with the base branch", () => {
  // The gate's own ledger path (the old config/ path on the base tree of the move).
  const FLOOR = gate.FLOOR_FILE;
  const KEY = "src/lib/example-module.ts::@cinatra-ai/web-research-agent:finding";
  const REASON = "a crossing recorded in a fixture ledger, with its reason";
  const typeEntry = () => ({ rule: "pack-type-id-in-core", key: KEY, reason: REASON });
  const domainEntry = (lines: number) => ({
    rule: "pack-shaped-core-domain",
    key: "src/lib/example-module",
    reason: REASON,
    files: { "src/lib/example-module/a.ts": lines },
  });
  const ledger = (entries: unknown[]) => ({ rules: [...gate.KNOWN_RULES], entries });

  const fixtures: { cleanup: () => void }[] = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.cleanup();
  });
  function repo(base: Record<string, unknown>, head: Record<string, unknown>): string {
    const f = floorFixture.makeFloorRepo({ base, head });
    fixtures.push(f);
    return f.root;
  }

  it("a ledger that gained an entry FAILS against the base", () => {
    const root = repo({ [FLOOR]: ledger([domainEntry(3)]) }, { [FLOOR]: ledger([domainEntry(3), typeEntry()]) });
    const r = gate.checkFloorAgainstBase({ repoRoot: root, env: floorFixture.PULL_REQUEST_RUN });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("grew");
    expect(r.growth).toEqual([`new entry: pack-type-id-in-core::${KEY}`]);
  });

  it("a ledger that lost an entry and lowered a count PASSES", () => {
    const root = repo({ [FLOOR]: ledger([domainEntry(3), typeEntry()]) }, { [FLOOR]: ledger([domainEntry(2)]) });
    const r = gate.checkFloorAgainstBase({ repoRoot: root, env: floorFixture.PULL_REQUEST_RUN });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("held");
  });

  it.each([
    ["a flag-like base", { CORE_EXTENSION_BORDER_BASE: "-x" }, true, "is flag-like"],
    ["a base that does not resolve", { CORE_EXTENSION_BORDER_BASE: "example-org-no-such-ref" }, true, "did not resolve"],
    ["a base commit that holds no ledger", { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" }, false, "is not on the base"],
    ["a pull request's run with no base branch", { GITHUB_EVENT_NAME: "pull_request" }, true, "GITHUB_BASE_REF is empty"],
  ])("%s FAILS closed with its reason", (_name, env, ledgerOnBase, reason) => {
    const root = ledgerOnBase
      ? repo({ [FLOOR]: ledger([typeEntry()]) }, {})
      : repo({ "README.md": "a base commit without the ledger\n" }, { [FLOOR]: ledger([typeEntry()]) });
    const r = gate.checkFloorAgainstBase({ repoRoot: root, env });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toContain("cannot be compared with the base");
    expect(r.lines[0]).toContain(reason);
  });

  // The ledger moved from config/ to beside its script. A base commit that
  // predates the move holds it at the old path; it is read there, never skipped.
  const NEW_FLOOR = "scripts/ci/core-extension-border-baseline.json";
  const LEGACY_FLOOR = "config/core-extension-border-baseline.json";

  it("a base that still holds the ledger at its old path is compared there: growth FAILS", () => {
    const root = repo({ [LEGACY_FLOOR]: ledger([domainEntry(3)]) }, { [NEW_FLOOR]: ledger([domainEntry(3), typeEntry()]) });
    const r = gate.checkFloorAgainstBase({ repoRoot: root, env: floorFixture.PULL_REQUEST_RUN });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("grew");
    expect(r.growth).toEqual([`new entry: pack-type-id-in-core::${KEY}`]);
  });

  it("a base that still holds the ledger at its old path is compared there: a shrink PASSES", () => {
    const root = repo({ [LEGACY_FLOOR]: ledger([domainEntry(3), typeEntry()]) }, { [NEW_FLOOR]: ledger([domainEntry(3)]) });
    const r = gate.checkFloorAgainstBase({ repoRoot: root, env: floorFixture.PULL_REQUEST_RUN });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("held");
    expect(r.lines.join("\n")).toContain(`${NEW_FLOOR} does not grow against`);
  });

  it("a base with the ledger at neither path still FAILS closed", () => {
    const root = repo(
      { "README.md": "a base without a ledger\n" },
      { [NEW_FLOOR]: ledger([typeEntry()]), [LEGACY_FLOOR]: ledger([typeEntry()]) },
    );
    const r = gate.checkFloorAgainstBase({ repoRoot: root, env: floorFixture.PULL_REQUEST_RUN });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toContain(`${NEW_FLOOR} is not on the base`);
  });

  it("a stale entry FAILS, and no stale entry passes", () => {
    const staleKey = `pack-type-id-in-core::${KEY}`;
    const r = gate.staleVerdict([staleKey]);
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toBe(
      "[core-extension-border] FAIL — 1 baseline entry is gone; run --write-baseline to shrink the ratchet:",
    );
    expect(r.lines).toContain(`  - ${staleKey}`);
    expect(gate.staleVerdict([])).toEqual({ ok: true, lines: [] });
  });

  it("a raised line count of a pack-shaped module FAILS against the base", () => {
    const root = repo({ [FLOOR]: ledger([domainEntry(3)]) }, { [FLOOR]: ledger([domainEntry(5)]) });
    const r = gate.checkFloorAgainstBase({ repoRoot: root, env: floorFixture.PULL_REQUEST_RUN });
    expect(r.ok).toBe(false);
    expect(r.growth).toEqual([
      "raised allowance under pack-shaped-core-domain::src/lib/example-module: src/lib/example-module/a.ts 3 -> 5",
    ]);
  });

  it("the gate itself runs the guard: an unreadable base fails it with the reason", () => {
    const res = spawnSync(process.execPath, [GATE_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...floorFixture.envWithoutBase(process.env), ...floorFixture.UNREADABLE_BASE_RUN },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("cannot be compared with the base");
    expect(res.stderr).toContain("did not resolve");
  }, 120_000);

  it("the gate itself compares the ledger with a named base", () => {
    const res = spawnSync(process.execPath, [GATE_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...floorFixture.envWithoutBase(process.env), CORE_EXTENSION_BORDER_BASE: "HEAD" },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('does not grow against the base "HEAD"');
  }, 120_000);
});

// cinatra#4852: core registers no step-screen kind named after one pack's
// step. The pack word runs come from the locks; the kind table is found by its
// shape (`const <NAME>KIND_TABLE = { ... }`), never by a file name.
describe("core/extension border — pack-step-kind-in-core", () => {
  const STEP_PACKS = new Set([
    "@cinatra-ai/acme-invoice-agent",
    "@cinatra-ai/zephyr-connector",
    "@example-org/note-artifact",
  ]);
  const TABLE_FILE = "packages/agents/src/synthetic-kind-table.ts";
  const table = (keys: string[]) =>
    [
      "const RENDERER_KIND_TABLE: Readonly<Record<",
      "  string,",
      "  { renderer: ComponentType<P>; makeCondition?: (ids: readonly string[]) => Cond }",
      ">> = {",
      ...keys.map((k) => `  "${k}": { renderer: Floor, bareAliases: ["${k}"] },`),
      "};",
      "",
    ].join("\n");
  const scanKinds = (keys: string[]) =>
    gate.scanStepScreenKindTables({ file: TABLE_FILE, text: table(keys), packs: STEP_PACKS });

  it("finds a kind that carries a pack's step words, and names the line", () => {
    const r = scanKinds(["list-picker", "acme-invoice-approval"]);
    expect(r.tables).toBe(1);
    expect(r.findings.map((f) => [f.rule, f.detail, f.line])).toEqual([
      ["pack-step-kind-in-core", "acme-invoice-approval (@cinatra-ai/acme-invoice-agent)", 6],
    ]);
    expect(r.findings[0].message).toContain("(acme-invoice)");
  });

  it("finds a kind that carries a connector's vendor word", () => {
    expect(scanKinds(["zephyr-sender"]).findings.map((f) => f.detail)).toEqual(["zephyr-sender (@cinatra-ai/zephyr-connector)"]);
  });

  it("passes a generic kind named for the screen's shape, and an artifact's type word", () => {
    expect(scanKinds(["list-picker", "form", "artifact-review", "confirmation", "note-input"]).findings).toEqual([]);
  });

  it("derives the word runs from the pack names, not from a list", () => {
    const runs = gate.packStepWordRuns(STEP_PACKS);
    expect(runs.has("acme-invoice")).toBe(true);
    expect(runs.has("zephyr")).toBe(true);
    expect(runs.has("acme")).toBe(false);
    expect(runs.has("note")).toBe(false);
    expect(gate.kindCrossesBorder("acme-invoice-review", runs)).toBe("acme-invoice");
  });

  it("does not read a kind table named only in a comment", () => {
    const text = `// const RENDERER_KIND_TABLE = { "zephyr-sender": 1 };\n`;
    expect(gate.scanStepScreenKindTables({ file: TABLE_FILE, text, packs: STEP_PACKS })).toEqual({
      findings: [],
      tables: 0,
    });
  });

  it("finds the standing kinds in the real table, each held by the ledger", () => {
    const r = gate.scanRepository({ repoRoot: REPO_ROOT, baselinePath: BASELINE_PATH });
    const kinds = r.findings.filter((f) => f.rule === "pack-step-kind-in-core");
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.filter((f) => r.violations.includes(f))).toEqual([]);
  });

  it("the committed ledger lists every rule it ratchets", () => {
    const doc = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    expect(gate.rulesListDefects(doc, { requireList: true })).toEqual([]);
    expect(gate.rulesListDefects({ entries: [] }, { requireList: true })).toEqual([
      "the ledger has no `rules` array (the rules it ratchets)",
    ]);
  });

  const KIND_KEY = `${TABLE_FILE}::zephyr-sender (@cinatra-ai/zephyr-connector)`;
  const kindEntry = (key = KIND_KEY) => ({
    rule: "pack-step-kind-in-core",
    key,
    reason: "a standing pack-named kind recorded in a fixture ledger",
  });
  const withRules = (rules: string[], entries: unknown[]) => ({ rules, entries });
  const ALL = () => [...gate.KNOWN_RULES];
  const BEFORE = () => ALL().filter((r) => r !== "pack-step-kind-in-core");

  it("the pull request that adds the rule seeds its standing kinds once", () => {
    expect(gate.baselineGrowth(withRules(BEFORE(), []), withRules(ALL(), [kindEntry()]))).toEqual([]);
  });

  it("once the base lists the rule, a pull request adding a kind entry fails", () => {
    expect(
      gate.baselineGrowth(withRules(ALL(), [kindEntry()]), withRules(ALL(), [kindEntry(), kindEntry(`${TABLE_FILE}::acme-invoice-review`)])),
    ).toEqual([`new entry: pack-step-kind-in-core::${TABLE_FILE}::acme-invoice-review`]);
    // also after the rule's last entry left the ledger
    expect(gate.baselineGrowth(withRules(ALL(), []), withRules(ALL(), [kindEntry()]))).toEqual([
      `new entry: pack-step-kind-in-core::${KIND_KEY}`,
    ]);
  });

  it("the ledger can shrink", () => {
    expect(gate.baselineGrowth(withRules(ALL(), [kindEntry()]), withRules(ALL(), []))).toEqual([]);
  });

  it("the base guard refuses a kind entry the base ledger did not hold", () => {
    const FLOOR = "scripts/ci/core-extension-border-baseline.json";
    const f = floorFixture.makeFloorRepo({
      base: { [FLOOR]: withRules(ALL(), []) },
      head: { [FLOOR]: withRules(ALL(), [kindEntry()]) },
    });
    try {
      const r = gate.checkFloorAgainstBase({ repoRoot: f.root, env: floorFixture.PULL_REQUEST_RUN });
      expect(r.ok).toBe(false);
      expect(r.growth).toEqual([`new entry: pack-step-kind-in-core::${KIND_KEY}`]);
    } finally {
      f.cleanup();
    }
  });

  it("a kind entry whose kind left the table is stale, and a tree with no kind table fails closed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "step-kind-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: root });
      const lock = { packages: [...STEP_PACKS].map((packageName) => ({ packageName })) };
      writeFileSync(path.join(root, "cinatra-required-extensions.lock.json"), JSON.stringify(lock));
      writeFileSync(path.join(root, "cinatra-dev-extensions.lock.json"), JSON.stringify(lock));
      mkdirSync(path.join(root, "packages", "agents", "src"), { recursive: true });
      const baselinePath = path.join(root, "ledger.json");
      writeFileSync(baselinePath, JSON.stringify(withRules(ALL(), [kindEntry()])));
      expect(() => gate.scanRepository({ repoRoot: root, baselinePath, ports: false })).toThrow(/no step-screen kind table/);
      writeFileSync(path.join(root, TABLE_FILE), table(["list-picker", "acme-invoice-approval"]));
      const r = gate.scanRepository({ repoRoot: root, baselinePath, ports: false });
      expect(r.stale).toEqual([`pack-step-kind-in-core::${KIND_KEY}`]);
      expect(gate.staleVerdict(r.stale).ok).toBe(false);
      expect(r.violations.map((f) => f.detail)).toEqual(["acme-invoice-approval (@cinatra-ai/acme-invoice-agent)"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A kind table is read whole or the check fails (fail closed): an entry whose
// key the scanner cannot resolve to a literal name is itself a finding, never
// skipped, so a pack-named kind cannot pass under a computed key or a spread.
describe("core/extension border — an unreadable kind table entry fails the check", () => {
  const STEP_PACKS = new Set(["@cinatra-ai/acme-invoice-agent", "@cinatra-ai/zephyr-connector"]);
  const FILE = "packages/agents/src/synthetic-kind-table.ts";
  const scan = (text: string) =>
    gate.scanStepScreenKindTables({ file: FILE, text, packs: STEP_PACKS }).findings.map((f) => f.detail);
  const tableOf = (body: string, tail = "") =>
    `const RENDERER_KIND_TABLE: Readonly<Record<string, Entry>> = {\n${body}\n}${tail};\n`;

  it("judges a computed key whose same-file const holds the name", () => {
    const text =
      `const PACK_KIND = "zephyr-sender";\nconst GENERIC = 'list-picker' as const;\n` +
      tableOf(`  [PACK_KIND]: { renderer: Floor },\n  [GENERIC]: { renderer: Picker },`);
    expect(scan(text)).toEqual(["zephyr-sender (@cinatra-ai/zephyr-connector)"]);
  });

  it("judges a computed string or plain template-literal key", () => {
    expect(scan(tableOf('  ["zephyr-sender"]: { renderer: Floor },\n  [`acme-invoice-review`]: { renderer: Floor },'))).toEqual([
      "zephyr-sender (@cinatra-ai/zephyr-connector)",
      "acme-invoice-review (@cinatra-ai/acme-invoice-agent)",
    ]);
  });

  it("reads a numeric key, a shorthand key and an `as const` or `satisfies` wrapped table", () => {
    expect(scan(tableOf("  1: { renderer: Floor },\n  cta,\n  form: { renderer: Form },", " as const"))).toEqual([]);
    expect(scan(tableOf('  "zephyr-sender": { renderer: Floor },', " satisfies Record<string, Entry>"))).toEqual([
      "zephyr-sender (@cinatra-ai/zephyr-connector)",
    ]);
  });

  it("refuses a computed key bound to an imported const", () => {
    const text = `import { PACK_KIND } from "./kinds";\n` + tableOf("  [PACK_KIND]: { renderer: Floor },");
    expect(scan(text)).toEqual(["unreadable entry: [PACK_KIND]"]);
  });

  it("refuses a template-literal key with a substitution, and a member-expression key", () => {
    expect(scan(tableOf("  [`${VENDOR}-sender`]: { renderer: Floor },\n  [Kinds.Sender]: { renderer: Floor },"))).toEqual([
      "unreadable entry: [`${VENDOR}-sender`]",
      "unreadable entry: [Kinds.Sender]",
    ]);
  });

  it("refuses a spread entry", () => {
    expect(scan(tableOf('  "list-picker": { renderer: Picker },\n  ...PACK_KINDS,'))).toEqual(["unreadable entry: ...PACK_KINDS"]);
  });

  it("refuses a table built by a call, a Map, or declared with no object", () => {
    expect(scan("const RENDERER_KIND_TABLE: Readonly<Kinds> = buildKinds();\n")).toEqual(["unreadable entry: buildKinds()"]);
    expect(scan('const RENDERER_KIND_TABLE: Readonly<Kinds> = new Map([["zephyr-sender", Floor]]);\n')).toEqual([
      'unreadable entry: new Map([["zephyr-sender", Floor]])',
    ]);
    expect(scan("let RENDERER_KIND_TABLE: Readonly<Record<string, Entry>>;\n")).toEqual([
      "kind table shape: RENDERER_KIND_TABLE (not `const`)",
      "unreadable entry: (no initializer)",
    ]);
  });

  it("the real kind table is read whole: no unreadable entry", () => {
    const r = gate.scanRepository({ repoRoot: REPO_ROOT, baselinePath: BASELINE_PATH });
    expect(r.findings.filter((f) => f.detail.startsWith("unreadable entry"))).toEqual([]);
  });
});

// The gate judges the table's DECLARATION only. What code does with the table
// afterwards is left to tsc: the table must be `const` and typed `Readonly<...>`
// at its declaration, so an entry added later does not compile.
describe("core/extension border — a kind table is declared in the frozen shape", () => {
  const STEP_PACKS = new Set(["@cinatra-ai/zephyr-connector"]);
  const FILE = "packages/agents/src/synthetic-kind-table.ts";
  const scan = (text: string) =>
    gate.scanStepScreenKindTables({ file: FILE, text, packs: STEP_PACKS }).findings.map((f) => [f.detail, f.line]);

  it("a table that is not const or not typed Readonly is a finding", () => {
    expect(scan('const RENDERER_KIND_TABLE: Record<string, Entry> = { "list-picker": 1 };\n')).toEqual([
      ["kind table shape: RENDERER_KIND_TABLE (not typed `Readonly<...>`)", 1],
    ]);
    expect(scan('let RENDERER_KIND_TABLE: Readonly<Record<string, Entry>> = { "list-picker": 1 };\n')).toEqual([
      ["kind table shape: RENDERER_KIND_TABLE (not `const`)", 1],
    ]);
    expect(scan('\nvar RENDERER_KIND_TABLE = { "list-picker": 1 } as const;\n')).toEqual([
      ["kind table shape: RENDERER_KIND_TABLE (not `const`, not typed `Readonly<...>`)", 2],
    ]);
  });

  it("a const table typed Readonly passes the shape, and its entries are still judged", () => {
    expect(scan('const RENDERER_KIND_TABLE: Readonly<Record<string, Entry>> = {\n  "list-picker": 1,\n  "zephyr-sender": 2,\n};\n')).toEqual([
      ["zephyr-sender (@cinatra-ai/zephyr-connector)", 3],
    ]);
  });

  it("the real kind table passes the shape", () => {
    const file = "packages/agents/src/register-default-renderers.ts";
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const r = gate.scanStepScreenKindTables({ file, text, packs: STEP_PACKS });
    expect(r.tables).toBe(1);
    expect(r.findings.map((f) => f.detail)).toEqual([]);
  });
});

// cinatra#4852, third round: the kind tables are read from the TypeScript
// syntax tree, never by text patterns, and each finding names the pinned
// package(s) whose words it carries, so the ledger keeps a pack in the
// universe after it leaves the locks.
describe("core/extension border — pack-step-kind-in-core reads the syntax tree", () => {
  const STEP_PACKS = new Set(["@cinatra-ai/acme-invoice-agent", "@cinatra-ai/zephyr-connector"]);
  const FILE = "packages/agents/src/synthetic-kind-table.ts";
  const Z = "zephyr-sender (@cinatra-ai/zephyr-connector)";
  const scanIn = (file: string, text: string) => gate.scanStepScreenKindTables({ file, text, packs: STEP_PACKS });
  const scan = (text: string, file = FILE) => scanIn(file, text).findings.map((f) => f.detail);
  const tableOf = (body: string, name = "RENDERER_KIND_TABLE") =>
    `const ${name}: Readonly<Record<string, Entry>> = {\n${body}\n};\n`;

  it("reads a pack-named key after an entry whose value holds a regex literal with a brace", () => {
    const text = tableOf(
      '  "list-picker": { renderer: Picker, makeCondition: (v: string) => /\\}/.test(v) },\n' +
        '  "zephyr-sender": { renderer: Floor },',
    );
    expect(scan(text)).toEqual([Z]);
  });

  it("reads past braces in a template literal, a string, a comment, and nested object values", () => {
    const text = tableOf(
      [
        "  // a comment with a brace }",
        '  "list-picker": { renderer: Picker, label: "a } brace", hint: `x ${"}"} y`, nested: { deep: { deeper: {} } } },',
        "  /* } */ form: { renderer: Form },",
        '  "zephyr-sender": { renderer: Floor },',
      ].join("\n"),
    );
    expect(scan(text)).toEqual([Z]);
  });

  it("reads a table exported in another statement, two tables in one file, and a table inside a function", () => {
    const text =
      tableOf('  "zephyr-sender": { renderer: Floor },') +
      "export { RENDERER_KIND_TABLE };\n" +
      tableOf('  "acme-invoice-review": { renderer: Floor },', "OTHER_KIND_TABLE") +
      "export function make() {\n" +
      '  const localKindTable: Readonly<Record<string, number>> = { "zephyr-sender": 1 };\n' +
      "  return Object.keys(localKindTable);\n" +
      "}\n";
    const r = scanIn(FILE, text);
    expect(r.tables).toBe(3);
    expect(r.findings.map((f) => [f.detail, f.line])).toEqual([
      [Z, 2],
      ["acme-invoice-review (@cinatra-ai/acme-invoice-agent)", 6],
      [`${Z} (occurrence 2)`, 9],
    ]);
  });

  it("reads a TSX table whose values hold JSX, and fails closed on a file that does not parse", () => {
    const tsx = tableOf(
      '  "list-picker": { render: () => <div className="a}">{"}"}</div> },\n  "zephyr-sender": { render: () => <Floor /> },',
    );
    expect(scan(tsx, "packages/agents/src/synthetic-kind-table.tsx")).toEqual([Z]);
    const broken = tableOf('  "list-picker": { renderer: Picker ,,, },\n  "zephyr-sender": {');
    expect(scan(broken)[0]).toMatch(/^unreadable entry: \(the file does not parse: /);
  });

  it("refuses a method or an accessor in the table", () => {
    expect(scan(tableOf("  get zephyrSender() { return Floor; },\n  form() { return Form; },"))).toEqual([
      "unreadable entry: get zephyrSender",
      "unreadable entry: method form",
    ]);
  });

  it("names the pinned package(s) each kind matched", () => {
    const packs = new Set([...STEP_PACKS, "@cinatra-ai/zephyr-mail-connector", "@example-org/note-artifact"]);
    const r = gate.scanStepScreenKindTables({ file: FILE, text: tableOf('  "zephyr-sender": 1,\n  "note-input": 2,'), packs });
    expect(r.findings.map((f) => f.detail)).toEqual([
      "zephyr-sender (@cinatra-ai/zephyr-connector, @cinatra-ai/zephyr-mail-connector)",
    ]);
  });

  // The reviewer's case: a pack leaves the locks while its kind stays in the
  // core table. The kind's ledger row names the pack, so the pack stays in the
  // universe and the row stays live until the kind itself leaves the table.
  describe("a pack that leaves the locks", () => {
    const LEDGER_KEY = `${FILE}::${Z}`;
    const setup = (lockPacks: string[], kinds: string[]) => {
      const root = mkdtempSync(path.join(tmpdir(), "step-kind-unpin-"));
      spawnSync("git", ["init", "-q"], { cwd: root });
      const lock = { packages: lockPacks.map((packageName) => ({ packageName })) };
      writeFileSync(path.join(root, "cinatra-required-extensions.lock.json"), JSON.stringify(lock));
      writeFileSync(path.join(root, "cinatra-dev-extensions.lock.json"), JSON.stringify(lock));
      mkdirSync(path.join(root, "packages", "agents", "src"), { recursive: true });
      writeFileSync(path.join(root, FILE), tableOf(kinds.map((k) => `  "${k}": { renderer: Floor },`).join("\n")));
      const baselinePath = path.join(root, "ledger.json");
      const entries = [{ rule: "pack-step-kind-in-core", key: LEDGER_KEY, reason: "fixture" }];
      writeFileSync(baselinePath, JSON.stringify({ rules: [...gate.KNOWN_RULES], entries }));
      return { repoRoot: root, baselinePath, ports: false };
    };

    it("keeps the kind's row live after the pack is unpinned, and stale once the kind is gone", () => {
      const kept = setup(["@cinatra-ai/acme-invoice-agent"], ["list-picker", "zephyr-sender"]);
      const gone = setup(["@cinatra-ai/acme-invoice-agent"], ["list-picker"]);
      try {
        const r = gate.scanRepository(kept);
        expect(r.stale).toEqual([]);
        expect(r.violations).toEqual([]);
        expect(r.findings.filter((f) => f.rule === "pack-step-kind-in-core").map((f) => f.detail)).toEqual([Z]);
        expect(gate.scanRepository(gone).stale).toEqual([`pack-step-kind-in-core::${LEDGER_KEY}`]);
      } finally {
        rmSync(kept.repoRoot, { recursive: true, force: true });
        rmSync(gone.repoRoot, { recursive: true, force: true });
      }
    });

    it("keeps the recorded row when a pack added to the locks matches the same kind", () => {
      const f = setup([...STEP_PACKS, "@cinatra-ai/zephyr-mail-connector"], ["zephyr-sender"]);
      try {
        const r = gate.scanRepository(f);
        expect(r.stale).toEqual([]);
        expect(r.violations).toEqual([]);
      } finally {
        rmSync(f.repoRoot, { recursive: true, force: true });
      }
    });
  });
});

// The one-time seeding of a rule's standing findings is open ONLY to a rule
// the base did not know. A base ledger written before the `rules` list names
// the rules it ratchets through the BASE COPY OF THE GATE SCRIPT; a zero-entry
// rule there (B) is ratcheted all the same. The base script unread fails closed.
describe("core/extension border — only a truly new rule may seed (the migration case)", () => {
  const FLOOR = "scripts/ci/core-extension-border-baseline.json";
  const SCRIPT = "scripts/ci/core-extension-border-gate.mjs";
  const A = "pack-table-literal";
  const B = "pack-named-passthrough";
  const C = "pack-step-kind-in-core";
  const REASON = "a standing crossing recorded in a fixture ledger";
  const e = (rule: string, key: string) => ({ rule, key: `src/lib/x.ts::${key}`, reason: REASON });
  const BASE_SCRIPT = `export const KNOWN_RULES = new Set([\n  "${A}",\n  "${B}",\n]);\n`;
  const run = (base: Record<string, unknown>, head: Record<string, unknown>) => {
    const f = floorFixture.makeFloorRepo({ base, head });
    try {
      return gate.checkFloorAgainstBase({ repoRoot: f.root, env: floorFixture.PULL_REQUEST_RUN });
    } finally {
      f.cleanup();
    }
  };
  const preRulesBase = { [FLOOR]: { entries: [e(A, "a1")] }, [SCRIPT]: BASE_SCRIPT };

  it("a zero-entry rule the base script knows cannot gain an entry", () => {
    const r = run(preRulesBase, { [FLOOR]: { rules: [A, B, C], entries: [e(A, "a1"), e(B, "b1")] } });
    expect(r.ok).toBe(false);
    expect(r.growth).toEqual([`new entry: ${B}::src/lib/x.ts::b1`]);
  });

  it("the rule this change adds seeds its entries once", () => {
    const r = run(preRulesBase, { [FLOOR]: { rules: [A, B, C], entries: [e(A, "a1"), e(C, "c1"), e(C, "c2")] } });
    expect(r.lines).toEqual([expect.stringContaining("does not grow against")]);
    expect(r.ok).toBe(true);
  });

  it("on the next change the seeded rule cannot grow", () => {
    const r = run(
      { [FLOOR]: { rules: [A, B, C], entries: [e(A, "a1"), e(C, "c1")] }, [SCRIPT]: BASE_SCRIPT },
      { [FLOOR]: { rules: [A, B, C], entries: [e(A, "a1"), e(C, "c1"), e(C, "c2")] } },
    );
    expect(r.ok).toBe(false);
    expect(r.growth).toEqual([`new entry: ${C}::src/lib/x.ts::c2`]);
  });

  // The rule set is append-only against the base: a rule the base ratchets
  // that the head no longer knows fails, so a rename cannot reset a floor.
  it("a rule the base ratchets that the head no longer knows fails, naming it", () => {
    const RETIRED = "pack-retired-rule";
    const r = run(
      { [FLOOR]: { rules: [A, B, RETIRED], entries: [e(A, "a1"), e(RETIRED, "r1")] } },
      { [FLOOR]: { rules: [A, B], entries: [e(A, "a1")] } },
    );
    expect(r.ok).toBe(false);
    expect(r.growth).toEqual([`a rule of the base is gone at the head (the rule set is append-only): ${RETIRED}`]);
  });

  it("a renamed rule whose rows are re-seeded under the new name fails", () => {
    const RENAMED = "pack-step-kind-in-host";
    const r = run(
      { [FLOOR]: { rules: [A, B, C], entries: [e(A, "a1"), e(C, "c1")] } },
      { [FLOOR]: { rules: [A, B, RENAMED], entries: [e(A, "a1"), e(RENAMED, "c1"), e(RENAMED, "c2")] } },
    );
    expect(r.ok).toBe(false);
    expect(r.growth).toEqual([`a rule of the base is gone at the head (the rule set is append-only): ${C}`]);
  });

  it("a rule added on top of the base's list still seeds once", () => {
    const r = run(
      { [FLOOR]: { rules: [A, B], entries: [e(A, "a1")] } },
      { [FLOOR]: { rules: [A, B, C], entries: [e(A, "a1"), e(C, "c1"), e(C, "c2")] } },
    );
    expect(r.ok).toBe(true);
  });

  it("a head ledger whose rules list drops a rule the gate script still knows fails", () => {
    const r = run(
      { [FLOOR]: { rules: [A, B, C], entries: [e(A, "a1")] } },
      { [FLOOR]: { rules: [A, B], entries: [e(A, "a1")] } },
    );
    expect(r.ok).toBe(false);
    expect(r.growth).toEqual([`a rule of the base is gone at the head (the rule set is append-only): ${C}`]);
    // and the committed-ledger check refuses any list that is not the script's KNOWN_RULES
    const all = [...gate.KNOWN_RULES];
    expect(gate.rulesListDefects({ rules: all.filter((x) => x !== C), entries: [] })).toEqual([
      `a rule of the gate is not in \`rules\`: ${C}`,
    ]);
    expect(gate.rulesListDefects({ rules: [...all, "pack-extra"], entries: [] })).toEqual([
      "unknown rule in `rules`: pack-extra",
    ]);
  });

  it("fails closed when the base gate script cannot be read or names no rules", () => {
    const head = { [FLOOR]: { rules: [A, B, C], entries: [e(A, "a1"), e(C, "c1")] } };
    const gone = run({ [FLOOR]: { entries: [e(A, "a1")] } }, head);
    expect(gone.status).toBe("unreadable");
    expect(gone.lines.join("\n")).toContain(`${SCRIPT} is not on the base`);
    const blank = run({ [FLOOR]: { entries: [e(A, "a1")] }, [SCRIPT]: "export const X = 1;\n" }, head);
    expect(blank.status).toBe("unreadable");
    expect(blank.lines.join("\n")).toContain("names no rule list");
  });
});

// cinatra#4872: `unbounded-port-member`. A host port member that takes a FREE NAME (a plain `string`
// parameter) together with an UNTYPED PAYLOAD (`any` or `unknown`) is a generic tunnel. A finding is
// keyed `<context property>.<member>`, the grant name. Every case compares the WHOLE list of findings;
// a throw shows as a line of the list, so on a tree without the rule a case fails by assertion.
describe("core/extension border — unbounded-port-member", () => {
  const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, lib: ["esnext"], module: "esnext", moduleResolution: "bundler", types: [] } });
  const REGISTER = 'import type { ExtensionHostContext } from "./host-context";\nexport type ExtensionServerEntry = { register(ctx: ExtensionHostContext): void };\n';
  type Ports = { unboundedPortMemberFindings?: (input: { repoRoot?: string; contractFile?: string }) => Finding[] };
  function found(files: Record<string, string>): Finding[] | string {
    const dir = mkdtempSync(path.join(tmpdir(), "border-port-"));
    try {
      for (const [name, text] of Object.entries({ "tsconfig.json": TSCONFIG, "register.ts": REGISTER, ...files })) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        writeFileSync(path.join(dir, name), text);
      }
      return (gate as unknown as Ports).unboundedPortMemberFindings?.({ repoRoot: dir, contractFile: "register.ts" }) ?? "not a function";
    } catch (e) {
      return `threw: ${(e as Error).message}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const keys = (files: Record<string, string>) => {
    const r = found(files);
    return typeof r === "string" ? [r] : r.map((f) => f.detail);
  };
  const ctx = (decls: string, props: string) => ({ "host-context.ts": `${decls}export type ExtensionHostContext = ${props};\n` });
  const jobs = (m: string, kind = "interface") => keys(ctx(`${kind} JobsPort { ${m} }\n`, "{ jobs: JobsPort }"));
  const RUN = "run(name: string, input: unknown): void";

  it("the issue's fixture: run(name: string, input: unknown) is reported; a literal-union name passes", () => {
    expect(jobs(RUN)).toEqual(["jobs.run"]);
    expect(jobs('run(name: "a" | "b", input: unknown): void')).toEqual([]);
  });

  it("an untyped name counts as a free name; one untyped parameter alone and a literal-union name pass", () => {
    expect(jobs("run(name, input): void")).toEqual(["jobs.run"]);
    expect(jobs("run(name: any, input: unknown): void")).toEqual(["jobs.run"]);
    expect(jobs("run(a: unknown, b: unknown): void")).toEqual(["jobs.run"]);
    expect(jobs("emit(event: unknown): void")).toEqual([]);
    expect(jobs('run(name: "a" | "b", input: unknown): void')).toEqual([]);
  });

  it.each([
    ["an any payload", "run(name: string, input: any): void"],
    ["a generic payload", "run<T>(name: string, input: T): void"],
    ["an optional name", "run(name?: string, input?: unknown): void"],
    ["a name constrained to string", "run<N extends string>(name: N, input: unknown): void"],
    ["a name with an open end", 'run(name: "a" | (string & {}), input: unknown): void'],
    ["a function-typed property", "run: (name: string, input: unknown) => void"],
    ["an overload of which one has the shape", 'run(name: "a", input: unknown): void; run(name: string, input: unknown): void'],
  ])("%s is reported", (_n, m) => expect(jobs(m)).toEqual(["jobs.run"]));

  it.each([
    ["a name constrained to a literal union", 'run<N extends "a" | "b">(name: N, input: unknown): void'],
    ["a typed payload", "run(name: string, input: { id: string }): void"],
    ["a record payload", "run(name: string, input: Record<string, unknown>): void"],
    ["a name only", "run(name: string): void"],
  ])("%s passes", (_n, m) => expect(jobs(m)).toEqual([]));
  it("a private member is not part of the surface", () => {
    expect(jobs("private run(name: string, input: unknown): void {}", "class")).toEqual([]);
  });

  describe("a finding is keyed by the context property, with no deduplication", () => {
    const base = `interface JobsPort { ${RUN} }\ninterface DerivedPort extends JobsPort { id: string }\n`;
    it("two context properties of one port type are two findings, and one ledger entry covers only its own", () => {
      expect(keys(ctx(base, "{ jobs: JobsPort; cache: JobsPort }"))).toEqual(["jobs.run", "cache.run"]);
      const r = found(ctx(base, "{ jobs: JobsPort; cache: JobsPort }")) as Finding[];
      expect(gate.violationsOf(r, new Set([gate.keyOf(r[0])])).map((f) => f.detail)).toEqual(["cache.run"]);
    });
    it("a derived port on another property is its own finding", () => {
      expect(keys(ctx(base, "{ jobs: JobsPort; derived: DerivedPort }"))).toEqual(["jobs.run", "derived.run"]);
    });
    it("an alias, a union with null and an intersection do not hide a property", () => {
      expect(keys(ctx(`${base}type Jobs = JobsPort;\n`, "{ a: Jobs; b: JobsPort | null; c: JobsPort & { id: string } }"))).toEqual(["a.run", "b.run", "c.run"]);
    });
    it("a union context is read per constituent; one key of one file is one finding", () => {
      expect(keys(ctx(base, "{ jobs: JobsPort } | { jobs: JobsPort } | { id: string }"))).toEqual(["jobs.run"]);
      expect(keys(ctx(`${base}interface Other { ${RUN} }\n`, "{ jobs: JobsPort } | { cache: Other }"))).toEqual(["jobs.run", "cache.run"]);
    });
    it("a member that is a sub-namespace is read, and a self-referencing port ends", () => {
      expect(keys(ctx(`interface Sub { ${RUN} }\ninterface Self { self: Self; sub: Sub }\n`, "{ p: Self }"))).toEqual(["p.sub.run"]);
    });
    it("a context property that is itself a function is keyed by its name", () => {
      expect(keys(ctx("", "{ jobs: (name: string, input: unknown) => void }"))).toEqual(["jobs"]);
    });
  });

  // A rest parameter is not read (a stated limit): only the ordinary parameters of a signature are.
  it("a rest parameter is never evaluated: these members produce no finding", () => {
    for (const m of [
      "run(name: string, ...ids: number[]): void",
      "run(...args: [id: number]): void",
      "run(...args: [a: number] | [b: boolean]): void",
      "run(name: string, ...args: [unknown] & [{ id: string }]): void",
      "run(...args: unknown[]): void",
    ]) expect(jobs(m)).toEqual([]);
  });
  it("a variadic registration context fails closed with a plain line", () => {
    const register = REGISTER.replace("register(ctx: ExtensionHostContext)", "register(...ctx: [ExtensionHostContext])");
    expect(keys({ ...ctx(`interface JobsPort { ${RUN} }\n`, "{ jobs: JobsPort }"), "register.ts": register })).toEqual([
      "threw: [core-extension-border] the registration contract ExtensionServerEntry.register(…) is variadic: the registration context is variadic; the border check cannot read it in register.ts — the rule fails closed rather than reading no port",
    ]);
  });

  it("a member of a dependency's interface is read", () => {
    const dep = {
      "node_modules/@example-org/jobs-port/package.json": JSON.stringify({ name: "@example-org/jobs-port", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/@example-org/jobs-port/index.d.ts": `export interface DependencyJobsPort { ${RUN} }\n`,
    };
    expect(keys({ ...dep, ...ctx('import type { DependencyJobsPort } from "@example-org/jobs-port";\n', "{ jobs: DependencyJobsPort }") })).toEqual(["jobs.run"]);
  });

  it("a tree without the contract file fails closed and names the expected file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "border-port-gone-"));
    let r: string;
    try {
      writeFileSync(path.join(dir, "tsconfig.json"), TSCONFIG);
      const run = (gate as unknown as Ports).unboundedPortMemberFindings;
      r = run ? (() => { try { return JSON.stringify(run({ repoRoot: dir })); } catch (e) { return `threw: ${(e as Error).message}`; } })() : "not a function";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(r).toBe(
      "threw: [core-extension-border] the registration contract file packages/sdk-extensions/src/register.ts is missing — the port rule fails closed rather than reading no port",
    );
  });

  it("an unresolved type and a missing anchor fail closed with a plain line", () => {
    expect(jobs("run(name: string, input: Missing): void")).toEqual(["threw: [core-extension-border] the border check could not resolve a type of input in register.ts"]);
    expect(keys({ ...ctx("", "{}"), "register.ts": "export type Other = {};\n" })).toEqual([
      "threw: [core-extension-border] the registration contract ExtensionServerEntry.register(…) is not an export of its module in register.ts — the rule fails closed rather than reading no port",
    ]);
  });

  describe("the ledger of this rule", () => {
    const RULE = "unbounded-port-member";
    const KEY = "packages/sdk-extensions/src/host-context.ts::jobs.enqueue";
    const e = (key: string) => ({ rule: RULE, key, reason: "a standing member recorded in a fixture ledger" });
    const growth = (base: unknown[], head: unknown[]) => {
      const f = floorFixture.makeFloorRepo({ base: { [gate.FLOOR_FILE]: { rules: [...gate.KNOWN_RULES], entries: base } }, head: { [gate.FLOOR_FILE]: { rules: [...gate.KNOWN_RULES], entries: head } } });
      try {
        return gate.checkFloorAgainstBase({ repoRoot: f.root, env: floorFixture.PULL_REQUEST_RUN });
      } finally {
        f.cleanup();
      }
    };
    it("the base guard refuses a new entry of the rule and lets a shrink pass", () => {
      const grew = growth([e(KEY)], [e(KEY), e(`${KEY}2`)]);
      expect(grew.ok).toBe(false);
      expect(grew.growth).toEqual([`new entry: ${RULE}::${KEY}2`]);
      expect(growth([e(KEY), e(`${KEY}2`)], [e(KEY)]).ok).toBe(true);
    });
    it("an entry whose member no longer has the shape is stale and fails", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "border-port-ledger-"));
      try {
        const doc = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
        doc.entries.push(e("packages/sdk-extensions/src/host-context.ts::jobs.gone"));
        const baselinePath = path.join(dir, "ledger.json");
        writeFileSync(baselinePath, JSON.stringify(doc));
        const r = gate.scanRepository({ repoRoot: REPO_ROOT, baselinePath });
        expect(r.stale).toEqual([`${RULE}::packages/sdk-extensions/src/host-context.ts::jobs.gone`]);
        expect(gate.staleVerdict(r.stale).ok).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
    it("the real tree: the four members on main, whole list, each recorded", () => {
      const file = "packages/sdk-extensions/src/host-context.ts";
      const real = (gate as unknown as Ports).unboundedPortMemberFindings?.({ repoRoot: REPO_ROOT }) ?? [];
      const list = real.map((f) => `${f.file}::${f.detail}`).sort();
      expect(list).toEqual(["jobs.enqueue", "mcp.callPrimitive", "objects.write", "settings.set"].map((d) => `${file}::${d}`));
      const doc = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
      expect(doc.entries.filter((x: { rule: string }) => x.rule === RULE).map((x: { key: string }) => x.key).sort()).toEqual(list);
    }, 60_000);
  });
});

// cinatra#4531: `pack-slug-in-core`. A string literal token in core whose WHOLE value is a locked
// pack's leaf (the name without its scope) names that pack. The file is read with the TypeScript
// parser; only a leaf with a canonical kind suffix is read. Every case compares the whole list of
// details; a missing function or a throw shows as a line of the list, so on a tree without the rule
// a case fails by assertion.
describe("core/extension border — pack-slug-in-core", () => {
  const RULE = "pack-slug-in-core";
  type Leaves = { scanPackLeafLiterals?: (input: { file: string; text: string; packs: Set<string> }) => Finding[] };
  const LEAF_PACKS = new Set([
    "@example-org/quill-ledger-connector",
    "@example-org/tide-planner-agent",
    "@example-org/sample-assistant",
    "@example-org/report",
  ]);
  const leaves = (text: string, file = "src/lib/x.tsx"): string[] => {
    const run = (gate as unknown as Leaves).scanPackLeafLiterals;
    if (!run) return ["not a function"];
    try {
      return run({ file, text, packs: LEAF_PACKS }).filter((f) => f.rule === RULE).map((f) => `${f.line} ${f.detail}`);
    } catch (e) {
      return [`threw: ${(e as Error).message}`];
    }
  };
  const QUILL = "quill-ledger-connector (@example-org/quill-ledger-connector)";

  it("reports a literal whose whole value is a leaf, in each quote form", () => {
    expect(leaves('const a = "quill-ledger-connector";\nconst b = \'quill-ledger-connector\';\nconst c = `quill-ledger-connector`;\n')).toEqual([
      `1 ${QUILL}`,
      `2 ${QUILL} (occurrence 2)`,
      `3 ${QUILL} (occurrence 3)`,
    ]);
  });

  it("does not read a comment, a regular expression or a template part glued to a substitution; a scoped name is read", () => {
    const text = [
      '// "quill-ledger-connector"',
      '/* "quill-ledger-connector" */',
      "const a = `${value /*",
      '  "quill-ledger-connector"',
      "*/}`;",
      "const b = /quill-ledger-connector/;",
      'const c = "/connectors/x/quill-ledger-connector/setup";',
      'const d = "?q=quill-ledger-connector";',
      "const e = `quill-ledger-connector${suffix}`;",
      'const f = "@example-org/quill-ledger-connector";',
      'const g = "quill-ledger-connector";',
    ].join("\n");
    // A path (line 7), a query value (line 8) and the leaf of a scoped name (line 10) are parts and are read.
    expect(leaves(text)).toEqual([`7 ${QUILL}`, `8 ${QUILL} (occurrence 2)`, `10 ${QUILL} (occurrence 3)`, `11 ${QUILL} (occurrence 4)`]);
  });

  it("reports a JSX attribute value equal to a leaf", () => {
    expect(leaves('export const C = () => <Card slug="tide-planner-agent" />;\n')).toEqual([
      "1 tide-planner-agent (@example-org/tide-planner-agent)",
    ]);
  });

  it("reports JSX text whose trimmed whole text is a leaf, and no leaf inside a sentence", () => {
    const text = [
      "export const C = () => (",
      "  <div>",
      "    <code>tide-planner-agent</code>",
      "    <p>install tide-planner-agent now</p>",
      "    <span>",
      "      quill-ledger-connector",
      "    </span>",
      "  </div>",
      ");",
    ].join("\n");
    expect(leaves(text)).toEqual(["3 tide-planner-agent (@example-org/tide-planner-agent)", `6 ${QUILL}`]);
  });

  it("reports a whole-value string in every place the tree holds one", () => {
    const text = [
      'const a = { "quill-ledger-connector": 1 };',
      'const b = { ["quill-ledger-connector"]: 1 };',
      'import x from "quill-ledger-connector";',
      'enum E { A = "quill-ledger-connector" }',
      'type T = "quill-ledger-connector";',
      "type U = `quill-ledger-connector`;",
      'export const C = () => <Card slug={"quill-ledger-connector"} />;',
    ].join("\n");
    expect(leaves(text).map((l) => l.split(" ")[0])).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });

  it("reports a JSON string value or key that is a leaf; a JSON file that does not parse fails closed", () => {
    type Json = { scanPackLeafJson?: (input: { file: string; text: string; packs: Set<string> }) => Finding[] };
    const run = (text: string) => {
      const fn = (gate as unknown as Json).scanPackLeafJson;
      if (!fn) return ["not a function"];
      try {
        return fn({ file: "src/lib/defaults.json", text, packs: LEAF_PACKS }).map((f) => f.detail);
      } catch (e) {
        return [`threw: ${(e as Error).message}`];
      }
    };
    expect(run('{ "default": "quill-ledger-connector", "tide-planner-agent": { "x": ["report", "install quill-ledger-connector"] } }')).toEqual([
      QUILL,
      "tide-planner-agent (@example-org/tide-planner-agent)",
    ]);
    expect(run('{ "a": 1, }')).toEqual([expect.stringMatching(/^threw: \[core-extension-border\] .*src\/lib\/defaults\.json/)]);
  });

  it("reports a leaf that is one part of a path or a query, also in the literal spans of a template", () => {
    const text = [
      'const a = "/connectors/example-org/quill-ledger-connector/setup";',
      'const b = "quill-ledger-connector/index";',
      'const c = "./quill-ledger-connector";',
      'const d = "?q=quill-ledger-connector";',
      'const e = "a=quill-ledger-connector&b=1";',
      'const f = "#quill-ledger-connector";',
      "const g = `/x/${a}/quill-ledger-connector`;",
      "const h = `${base}/quill-ledger-connector/y`;",
      "const i = `/a/${x}/quill-ledger-connector/${y}/b`;",
      'const j = "/x/@example-org/tide-planner-agent";',
    ].join("\n");
    expect(leaves(text).map((l) => l.split(" ")[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  });

  it("does not read a leaf joined to other characters or glued to a substitution; a leaf after a scope part is read", () => {
    const text = [
      "const a = `quill-ledger-connector-${n}`;",
      "const b = `/x/quill-ledger-connector${q}`;",
      "const c = `${p}quill-ledger-connector/y`;",
      'const d = "quill-ledger-connector.json";',
      'const e = "quill-ledger-connector:x";',
      'const f = "quill-ledger-connector-v2";',
      'const g = "use quill-ledger-connector now";',
      'const h = "@example-org/quill-ledger-connector";',
      'const i = "@example-org/quill-ledger-connector/sub";',
      'const j = "/x/tide-planner-agent";',
    ].join("\n");
    expect(leaves(text)).toEqual([`8 ${QUILL}`, `9 ${QUILL} (occurrence 2)`, "10 tide-planner-agent (@example-org/tide-planner-agent)"]);
  });

  it("reports a leaf that is one part of a JSON path value or a scoped key or name", () => {
    const run = (gate as unknown as { scanPackLeafJson?: (i: { file: string; text: string; packs: Set<string> }) => Finding[] }).scanPackLeafJson;
    const json = (text: string) => (run ? run({ file: "packages/core-x/package.json", text, packs: LEAF_PACKS }).map((f) => f.detail) : ["not a function"]);
    expect(json('{ "href": "/connectors/x/tide-planner-agent/setup", "@example-org/quill-ledger-connector": 1 }')).toEqual([
      "tide-planner-agent (@example-org/tide-planner-agent)",
      QUILL,
    ]);
    expect(json('{ "name": "@example-org/core-x", "dependencies": { "@example-org/quill-ledger-connector": "workspace:*" } }')).toEqual([QUILL]);
    expect(json('{ "name": "@example-org/tide-planner-agent" }')).toEqual(["tide-planner-agent (@example-org/tide-planner-agent)"]);
  });

  it("a test helper or stub under a tests folder is out of the scan", () => {
    const root = mkdtempSync(path.join(tmpdir(), "border-tests-tree-"));
    try {
      for (const f of ["packages/x/tests/__stubs__/server-only.ts", "packages/x/tests/setup.ts", "packages/x/src/a.ts", "src/app/x/test/route.ts"]) {
        mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        writeFileSync(path.join(root, f), 'export const A = "quill-ledger-connector";\n');
      }
      const files = ["packages", "src"].flatMap((r) => gate.walkProductFiles(path.join(root, r), [], root)).map((f) => path.relative(root, f).split(path.sep).join("/"));
      expect(files.sort()).toEqual(["packages/x/src/a.ts", "src/app/x/test/route.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads JSON files in the product tree except tsconfig files, tests and fixtures", () => {
    const root = mkdtempSync(path.join(tmpdir(), "border-json-tree-"));
    try {
      for (const f of ["src/lib/defaults.json", "src/lib/a.ts", "src/tsconfig.json", "src/lib/x.fixture.json", "src/lib/__tests__/t.json", "src/app/design-fixtures/seed.json"]) {
        mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        writeFileSync(path.join(root, f), "{}\n");
      }
      const accept = (gate as unknown as { isProductJsonFile?: (n: string) => boolean }).isProductJsonFile;
      const walkJson = gate.walkProductFiles as unknown as (d: string, a: string[], r: string, accept?: (n: string) => boolean) => string[];
      const files = walkJson(path.join(root, "src"), [], root, accept).map((f) => path.relative(root, f).split(path.sep).join("/"));
      expect(files).toEqual(["src/lib/defaults.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the assistant suffix of an agent package, and no leaf without a kind suffix", () => {
    expect(leaves('const a = "report";\nconst b = "sample-assistant";\n')).toEqual(["2 sample-assistant (@example-org/sample-assistant)"]);
  });

  it("a file the parser cannot read fails closed with its name", () => {
    expect(leaves('const a = "quill-ledger-connector";\nconst = ;\n', "src/lib/broken.ts")).toEqual([
      expect.stringMatching(/^threw: \[core-extension-border\] .*src\/lib\/broken\.ts/),
    ]);
  });

  it("a file under the design fixture tree is out of the scan, like every fixture", () => {
    const root = mkdtempSync(path.join(tmpdir(), "border-fixture-tree-"));
    try {
      for (const f of ["src/app/design-fixtures/conformance/seed-data.ts", "src/lib/a.ts"]) {
        mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        writeFileSync(path.join(root, f), 'export const A = "quill-ledger-connector";\n');
      }
      const files = gate.walkProductFiles(path.join(root, "src"), [], root).map((f) => path.relative(root, f).split(path.sep).join("/"));
      expect(files).toEqual(["src/lib/a.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("the ledger of this rule", () => {
    const KEY = `src/lib/example-module.ts::${QUILL}`;
    const e = (key: string) => ({ rule: RULE, key, reason: "a standing leaf recorded in a fixture ledger" });
    const growth = (base: unknown[], head: unknown[]) => {
      const f = floorFixture.makeFloorRepo({
        base: { [gate.FLOOR_FILE]: { rules: [...gate.KNOWN_RULES], entries: base } },
        head: { [gate.FLOOR_FILE]: { rules: [...gate.KNOWN_RULES], entries: head } },
      });
      try {
        return gate.checkFloorAgainstBase({ repoRoot: f.root, env: floorFixture.PULL_REQUEST_RUN });
      } finally {
        f.cleanup();
      }
    };
    it("the base guard refuses a new entry of the rule and lets a shrink pass", () => {
      const grew = growth([e(KEY)], [e(KEY), e(`${KEY} (occurrence 2)`)]);
      expect(grew.ok).toBe(false);
      expect(grew.growth).toEqual([`new entry: ${RULE}::${KEY} (occurrence 2)`]);
      expect(growth([e(KEY), e(`${KEY} (occurrence 2)`)], [e(KEY)]).ok).toBe(true);
    });
    it("the real tree: every finding of the rule is recorded, and nothing else is", () => {
      const r = gate.scanRepository({ repoRoot: REPO_ROOT, baselinePath: BASELINE_PATH });
      const found = r.findings.filter((f) => f.rule === RULE).map((f) => `${f.file}::${f.detail}`).sort();
      expect(found.length).toBeGreaterThan(0);
      const doc = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
      expect(doc.entries.filter((x: { rule: string }) => x.rule === RULE).map((x: { key: string }) => x.key).sort()).toEqual(found);
    }, 60_000);
  });
});

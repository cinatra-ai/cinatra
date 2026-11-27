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
  scanRepository: (input: { repoRoot: string; baselinePath?: string }) => {
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
  untypedPortInputFindings?: (input: { repoRoot?: string; file?: string; type?: string }) => Finding[];
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
      expect(() => gate.scanRepository({ repoRoot: root, baselinePath })).toThrow(/no step-screen kind table/);
      writeFileSync(path.join(root, TABLE_FILE), table(["list-picker", "acme-invoice-approval"]));
      const r = gate.scanRepository({ repoRoot: root, baselinePath });
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

  // red-first-expect: TypeError: gate.scanStepScreenKindTables is not a function
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

  // red-first-expect: TypeError: gate.scanStepScreenKindTables is not a function
  it("a const table typed Readonly passes the shape, and its entries are still judged", () => {
    expect(scan('const RENDERER_KIND_TABLE: Readonly<Record<string, Entry>> = {\n  "list-picker": 1,\n  "zephyr-sender": 2,\n};\n')).toEqual([
      ["zephyr-sender (@cinatra-ai/zephyr-connector)", 3],
    ]);
  });

  // red-first-expect: TypeError: gate.scanStepScreenKindTables is not a function
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
      return { repoRoot: root, baselinePath };
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

// cinatra#4872: `untyped-port-input` reads the checker's types of the context a
// pack's `register(ctx)` receives, never how a type is written. Each case writes a
// declaration and compares the WHOLE list of findings; the same meaning is written
// through different syntax to show that the syntax does not matter.
describe("core/extension border — a host port call takes typed inputs", () => {
  const JOBS = "interface JobsPort { enqueue(name: string, payload: unknown): void }";
  const HIT = ["JobsPort.enqueue(#2)"];
  function ports(files: Record<string, string>, input: { file?: string; type?: string } = {}): string[] {
    const dir = mkdtempSync(path.join(tmpdir(), "border-port-"));
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
      return (gate.untypedPortInputFindings?.({ repoRoot: dir, file: "host-context.ts", ...input }) ?? []).map((f) => f.detail);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const ctx = (declarations: string, root: string) => ports({ "host-context.ts": `${declarations}\n${root}\n` });

  it.each([
    ["an interface", JOBS, "export type ExtensionHostContext = { jobs: JobsPort };"],
    ["a type alias", "type JobsPort = { enqueue(name: string, payload: unknown): void };", "export type ExtensionHostContext = { jobs: JobsPort };"],
    ["an alias of an interface", `${JOBS}\ntype Jobs = JobsPort;`, "export type ExtensionHostContext = { jobs: Jobs };"],
    ["an optional property", JOBS, "export type ExtensionHostContext = { jobs?: JobsPort };"],
    ["a nullable type", JOBS, "export type ExtensionHostContext = { jobs: JobsPort | null };"],
    ["a nullable alias", `${JOBS}\ntype Nullish = null | undefined;`, "export type ExtensionHostContext = { jobs: JobsPort | Nullish };"],
    ["a readonly property", JOBS, "export type ExtensionHostContext = { readonly jobs: JobsPort };"],
    ["a root interface", JOBS, "export interface ExtensionHostContext { jobs: JobsPort }"],
    ["a root intersection", JOBS, "type A = { id: string };\nexport type ExtensionHostContext = A & { jobs: JobsPort };"],
    ["a root interface that extends", `${JOBS}\ninterface Base { jobs: JobsPort }`, "export interface ExtensionHostContext extends Base { id: string }"],
    ["a root union of two shapes", JOBS, "export type ExtensionHostContext = { jobs: JobsPort } | { jobs: JobsPort; extra: string };"],
    ["a union of two ports", JOBS, "export type ExtensionHostContext = { jobs: JobsPort | { stop(): void } };"],
  ])("a port written as %s is read: one finding", (_name, declarations, root) => {
    expect(ctx(declarations, root)).toEqual(HIT);
  });

  it("a port written as import(\"./ports\").JobsPort or through a namespace name is read the same", () => {
    const ports_ts = `export ${JOBS}\n`;
    expect(ports({ "ports.ts": ports_ts, "host-context.ts": 'export type ExtensionHostContext = { jobs: import("./ports").JobsPort };\n' })).toEqual(HIT);
    expect(
      ports({
        "ports.ts": ports_ts,
        "host-context.ts": 'import * as Ports from "./ports";\nexport type ExtensionHostContext = { jobs: Ports.JobsPort };\n',
      }),
    ).toEqual(HIT);
    expect(
      ports({
        "ports.ts": ports_ts,
        "host-context.ts": 'import type { JobsPort as Renamed } from "./ports";\nexport type ExtensionHostContext = { jobs: Renamed };\n',
      }),
    ).toEqual(HIT);
  });

  it.each([
    ["a method", "interface JobsPort { enqueue(name: string, payload: unknown): void }"],
    ["a property with an inline function type", "interface JobsPort { enqueue: (name: string, payload: unknown) => void }"],
    ["a nullable property with an inline function type", "interface JobsPort { enqueue?: ((name: string, payload: unknown) => void) | null }"],
    ["a property with a named alias", "type Enqueue = (name: string, payload: unknown) => void;\ninterface JobsPort { enqueue: Enqueue }"],
    ["a property with an interface that only has a call signature", "interface Enqueue { (name: string, payload: unknown): void }\ninterface JobsPort { enqueue: Enqueue }"],
    ["a generic alias of a function type", "type Fn<P> = (name: string, payload: P) => void;\ninterface JobsPort { enqueue: Fn<unknown> }"],
    ["a function type taken from another type", "type Enqueue = (name: string, payload: unknown) => void;\ninterface JobsPort { enqueue: Required<{ f: Enqueue }>['f'] }"],
    ["an inherited member", "interface Base { enqueue(name: string, payload: unknown): void }\ninterface JobsPort extends Base {}"],
    ["a member of an intersection", "type JobsPort = { stop(): void } & { enqueue(name: string, payload: unknown): void };"],
    ["a readonly property", "interface JobsPort { readonly enqueue: (name: string, payload: unknown) => void }"],
  ])("a call written as %s is read: one finding", (_name, declarations) => {
    expect(ctx(declarations, "export type ExtensionHostContext = { jobs: JobsPort };")).toEqual(HIT);
  });

  it.each([
    ["any", "any", true],
    ["unknown", "unknown", true],
    ["object", "object", true],
    ["the empty object type", "{}", true],
    ["an empty interface", "Empty", true],
    ["an unconstrained type parameter", "T", true],
    ["a type parameter constrained to unknown", "U", true],
    ["T & {}", "T & {}", true],
    ["NonNullable<T>", "NonNullable<T>", true],
    ["a union with unknown", "string | unknown", true],
    ["a union with object", "string | object", true],
    ["an optional unknown", "unknown | undefined", true],
    ["string", "string", false],
    ["an object type with a property", "{ id: string }", false],
    ["a named interface with a property", "Named", false],
    ["a type parameter with a constraint", "C", false],
    ["T & { id: string }", "T & { id: string }", false],
    ["a union of typed members", "string | { id: string } | null", false],
    ["a callback", "(x: unknown) => void", false],
    ["a record (its contents are not read)", "Record<string, unknown>", false],
    ["an array of unknown (its contents are not read)", "unknown[]", false],
  ])("an input of %s", (_name, type, reported) => {
    const declarations =
      "interface Empty {}\ninterface Named { id: string }\n" +
      `interface JobsPort { enqueue<T, U extends unknown, C extends { id: string }>(name: string, payload: ${type}, spare?: [T, U, C]): void }`;
    expect(ctx(declarations, "export type ExtensionHostContext = { jobs: JobsPort };")).toEqual(reported ? HIT : []);
  });

  it("reads a rest parameter by its element type, and names every position and every signature", () => {
    expect(ctx("interface JobsPort { a(...args: any[]): void; b(...args: string[]): void; c(...args: [string, unknown]): void }", "export type ExtensionHostContext = { jobs: JobsPort };")).toEqual([
      "JobsPort.a(#1)",
      "JobsPort.c(#1)",
    ]);
    expect(ctx("interface JobsPort { run(a: any, b: string, c: unknown): void }", "export type ExtensionHostContext = { jobs: JobsPort };")).toEqual(["JobsPort.run(#1,#3)"]);
    expect(
      ctx("interface JobsPort { run(a: string): void; run(a: unknown): void; run(a: string, b: object): void }", "export type ExtensionHostContext = { jobs: JobsPort };"),
    ).toEqual(["JobsPort.run(#1|#2)"]);
  });

  it("keys by position: renaming a parameter keeps the key", () => {
    const root = "export type ExtensionHostContext = { jobs: JobsPort };";
    expect(ctx("interface JobsPort { enqueue(a: string, b: unknown): void }", root)).toEqual(
      ctx("interface JobsPort { enqueue(label: string, data: unknown): void }", root),
    );
  });

  it("a member that is no call has no input to judge: nothing is reported", () => {
    const declarations =
      "interface JobsPort { readonly state: unknown; readonly shape: object; get mode(): string; get data(): unknown; fn: Function; call: CallableFunction; done: Promise<unknown>; names: string[] }";
    expect(ctx(declarations, "export type ExtensionHostContext = { id: string; jobs: JobsPort; tags: readonly string[]; when: Date; cb: Function };")).toEqual([]);
  });

  it("a port member of type any is one finding for that member", () => {
    expect(ctx("interface JobsPort { legacy: any; run(a: string): void; later?: any }", "export type ExtensionHostContext = { jobs: JobsPort };")).toEqual([
      "JobsPort.legacy(any)",
      "JobsPort.later(any)",
    ]);
  });

  it("a root property that is callable or any is judged the same way", () => {
    expect(ctx(JOBS, "export type ExtensionHostContext = { jobs: JobsPort; log: (line: any) => void; extra: any };")).toEqual([
      ...HIT,
      "ExtensionHostContext.log(#1)",
      "ExtensionHostContext.extra(any)",
    ]);
  });

  it("a port with no name of its own takes its property's name, and one declaration is one finding", () => {
    expect(ctx("", "export type ExtensionHostContext = { jobs: { enqueue(name: string, payload: unknown): void } };")).toEqual(["jobs.enqueue(#2)"]);
    expect(ctx(JOBS, "export type ExtensionHostContext = { jobs: JobsPort; again: JobsPort };")).toEqual(HIT);
  });

  it("a port made by a utility type or an object value is keyed by its property", () => {
    expect(ctx(JOBS, "export type ExtensionHostContext = { jobs: Readonly<JobsPort>; picked: Pick<JobsPort, 'enqueue'> };")).toEqual([
      "jobs.enqueue(#2)",
      "picked.enqueue(#2)",
    ]);
    expect(ctx("const impl = { enqueue(name: string, payload: any) {} };", "export type ExtensionHostContext = { jobs: typeof impl };")).toEqual(["jobs.enqueue(#2)"]);
  });

  it("a class, a generic port and a port that extends a lib type are read; a `this` parameter is not an input", () => {
    expect(ctx("class JobsPort { private n = 1; enqueue(name: string, payload: unknown) {} }", "export type ExtensionHostContext = { jobs: JobsPort };")).toEqual(HIT);
    expect(ctx("interface JobsPort<T> { enqueue(name: string, payload: T): void }", "export type ExtensionHostContext = { jobs: JobsPort<unknown>; typed: JobsPort<{ id: string }> };")).toEqual(HIT);
    expect(ctx("interface JobsPort extends Map<string, unknown> { run(this: any, a: string): void }", "export type ExtensionHostContext = { jobs: JobsPort };")).toEqual([]);
  });

  it("fails closed on a root that is not there, and reads nothing from a tree without the SDK", () => {
    expect(() => ports({ "host-context.ts": "export type Other = { id: string };\n" })).toThrow(/port root ExtensionHostContext/);
    const dir = mkdtempSync(path.join(tmpdir(), "border-port-none-"));
    try {
      expect(gate.untypedPortInputFindings?.({ repoRoot: dir }) ?? ["not a function"]).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the real tree: the six members that stood on main, whole list, and nothing else", () => {
    expect((gate.untypedPortInputFindings?.({ repoRoot: REPO_ROOT }) ?? []).map((f) => `${f.file}::${f.detail}`).sort()).toEqual(
      [
        "HostJobsPort.enqueue(#2)",
        "HostMcpPort.callPrimitive(#2)",
        "HostObjectsPort.write(#2)",
        "HostSettingsPort.set(#2)",
        "HostUiPort.registerSettingsSurface(#1)",
        "HostUiPort.registerSetupSurface(#1)",
      ].map((d) => `packages/sdk-extensions/src/host-context.ts::${d}`),
    );
    expect(gate.KNOWN_RULES.has("untyped-port-input")).toBe(true);
    const ledger = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    expect(ledger.rules).toContain("untyped-port-input");
    expect(ledger.entries.filter((e: { rule: string }) => e.rule === "untyped-port-input")).toHaveLength(6);
  }, 60_000);
});

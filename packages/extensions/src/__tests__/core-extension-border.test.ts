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
  // Optional: a tree whose gate does not know the port rules yet has none of them.
  PORT_SEEDS?: Record<string, string[]>;
  portFindings?: (input?: { repoRoot?: string; file?: string; type?: string }) => Finding[];
};

const gate: GateModule = (await import(pathToFileURL(GATE_PATH).href)) as unknown as GateModule;

// Where the gate does not know the port rules (a plain main tree) these read as
// empty, so their tests fail by assertion and not by a missing function.
const SEEDS = gate.PORT_SEEDS ?? {};
const portFindings = (input?: { repoRoot?: string; file?: string; type?: string }): Finding[] =>
  gate.portFindings?.(input) ?? [];

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
    const previous = { entries: [entry()] };
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
      { entries: [entry()] },
      { entries: [entry({ files: { "src/lib/blog/store.ts": 1700 } })] },
    );
    expect(grown).toEqual(["raised allowance under pack-shaped-core-domain::src/lib/blog: src/lib/blog/store.ts 1606 -> 1700"]);
  });

  it("refuses a ledger that recorded a new file inside a module", () => {
    const grown = gate.baselineGrowth(
      { entries: [entry()] },
      { entries: [entry({ files: { "src/lib/blog/store.ts": 1606, "src/lib/blog/gate.ts": 40 } })] },
    );
    expect(grown).toEqual(["new file recorded under pack-shaped-core-domain::src/lib/blog: src/lib/blog/gate.ts"]);
  });

  it("accepts a ledger that only lost entries and lowered allowances", () => {
    expect(
      gate.baselineGrowth(
        { entries: [entry(), { rule: "pack-table-literal", key: "a::b", reason: "gone now" }] },
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
  const ledger = (entries: unknown[]) => ({ entries });

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

// cinatra#4872: the port rules read the DECLARATIONS of the SDK's host context and
// refuse every shape they do not read. Each case writes a declaration and asks
// which findings it gives.
describe("core/extension border — the ports are a closed shape with typed inputs", () => {
  function ports(declarations: string, fields = "jobs: JobsPort", root?: string): string[] {
    const dir = mkdtempSync(path.join(tmpdir(), "border-port-"));
    try {
      writeFileSync(path.join(dir, "host-context.ts"), `${declarations}\n${root ?? `export type ExtensionHostContext = { ${fields} };`}\n`);
      return portFindings({ repoRoot: dir, file: "host-context.ts" }).map((f) => `${f.rule} ${f.detail}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const OTHER = "interface Other { a: string }";

  it.each([
    ["methods, optional ones too", "interface JobsPort { run(input: string): void; stop?(): void }"],
    ["function-typed properties, nullable and optional", "interface JobsPort { run: ((input: string) => void) | null; stop?: () => void }"],
    ["readonly properties and getters that cannot be called", "interface JobsPort { readonly state: unknown; readonly shape: object; get mode(): string; get data(): unknown }"],
    ["a type alias of one type literal", "type JobsPort = { run(input: string): void }"],
    ["a base that is an SDK interface", "interface Base { run(input: string): void }\ninterface JobsPort extends Base {}"],
    ["an optional and a nullable port", "interface JobsPort { run(): void }", "jobs?: JobsPort | null"],
    [
      "identity fields",
      'type Mode = "a" | "b";\ninterface JobsPort { run(): void }',
      "jobs: JobsPort; id: string; n?: number; on: boolean | null; labels: readonly string[]; pair: [string, number]; mode: Mode",
    ],
    [
      "identity fields of every primitive kind",
      "enum Kind { A, B }\ninterface JobsPort { run(): void }",
      "jobs: JobsPort; sym: symbol; readonly tag: unique symbol; kind: Kind; nothing: void; big: bigint; nil: null; tpl: `a${string}`",
    ],
  ])("allows %s", (_name, declarations, fields?: string) => {
    expect(ports(declarations, fields)).toEqual([]);
  });

  it.each([
    ["a type alias of a function type", "type JobsPort = (input: string) => void", undefined, "jobs"],
    ["an alias of another reference", `${OTHER}\ntype JobsPort = Other`, undefined, "jobs"],
    ["an intersection", "interface JobsPort { run(): void }", "jobs: JobsPort & { extra: string }", "jobs"],
    ["an inline type literal", "", "jobs: { run(): void }", "jobs"],
    ["a generic wrapper", "interface JobsPort { run(): void }", "jobs: Partial<JobsPort>", "jobs"],
    ["an array of ports", "interface JobsPort { run(): void }", "jobs: JobsPort[]", "jobs"],
    ["any", "", "jobs: any", "jobs"],
    ["unknown", "", "jobs: unknown", "jobs"],
    ["object", "", "jobs: object", "jobs"],
    ["no annotation", "", "jobs", "jobs"],
    ["a reference outside the SDK", "", "jobs: Map<string, string>", "jobs"],
    ["a port with type parameters", "interface JobsPort<T = string> { run(v: T): void }", undefined, "JobsPort"],
    ["a base outside the SDK", "interface JobsPort extends Map<string, string> {}", undefined, "JobsPort.extends Map<string, string>"],
    ["a writable data property", "interface JobsPort { count: number }", undefined, "JobsPort.count"],
    ["a set accessor", "interface JobsPort { set value(v: string) }", undefined, "JobsPort.value"],
    ["an index signature", "interface JobsPort { [name: string]: string }", undefined, "JobsPort.IndexSignature"],
    ["a call signature", "interface JobsPort { (input: string): void }", undefined, "JobsPort.CallSignature"],
    ["a construct signature", "interface JobsPort { new (input: string): object }", undefined, "JobsPort.ConstructSignature"],
    ["an object-typed property", "interface JobsPort { opts: { a: string } }", undefined, "JobsPort.opts"],
    ["an interface-typed property", `${OTHER}\ninterface JobsPort { sub: Other }`, undefined, "JobsPort.sub"],
    ["a constructor-typed property", "interface JobsPort { Factory: new (input: string) => object }", undefined, "JobsPort.Factory"],
    ["a union of functions", "interface JobsPort { run: ((a: string) => void) | ((b: string) => void) }", undefined, "JobsPort.run"],
    ["a readonly property typed any", "interface JobsPort { readonly run: any }", undefined, "JobsPort.run"],
    ["a getter typed any", "interface JobsPort { get run(): any }", undefined, "JobsPort.run"],
    ["a getter with no type", "interface JobsPort { get run() }", undefined, "JobsPort.run"],
    ["a readonly property typed Function", "interface JobsPort { readonly run: Function }", undefined, "JobsPort.run"],
    ["a readonly union with a function", "interface JobsPort { readonly run: string | (() => void) }", undefined, "JobsPort.run"],
    ["a root property typed never", "interface JobsPort { run(): void }", "jobs: JobsPort; n: never", "n"],
  ])("refuses %s as port-shape", (_name, declarations, fields, detail) => {
    expect(ports(declarations, fields)).toEqual([`port-shape ${detail}`]);
  });

  it.each([
    ["an index signature", "[name: string]: any", "port-shape [index]"],
    ["a call signature", "(input: string): void", "port-shape [call]"],
    ["a construct signature", "new (input: string): object", "port-shape [construct]"],
  ])("refuses %s on the root as port-shape", (_name, member, finding) => {
    const jobs = "interface JobsPort { run(): void }";
    expect(ports(jobs, "", `export interface ExtensionHostContext { jobs: JobsPort; ${member} }`)).toEqual([finding]);
    expect(ports(jobs, "", `export type ExtensionHostContext = { jobs: JobsPort; ${member} };`)).toEqual([finding]);
    // inherited from a base declared in the SDK
    expect(ports(`${jobs}\ninterface BaseContext { ${member} }`, "", "export interface ExtensionHostContext extends BaseContext { jobs: JobsPort }")).toEqual([finding]);
  });

  // The root has a CLOSED FORM or it is one finding: a union, mapped or conditional type
  // (or any, unknown, a type parameter) hides members from the property list.
  describe("the form of the root", () => {
    const decls =
      "interface SafePort { call(input: string): void }\ninterface UnsafePort { call(input: any): void }\ninterface BaseContext { id: string }\ninterface Mid { id: string }";
    const rootForm = (root: string) => ports(decls, "", root).filter((f) => f === "port-shape [root-form]");

    it.each([
      ["a union inside an intersection", "export type ExtensionHostContext = BaseContext & ({ alpha: UnsafePort } | { beta: SafePort });"],
      ["a plain union alias", "type Branches = { alpha: SafePort } | { beta: SafePort };\nexport type ExtensionHostContext = Branches;"],
      ["a mapped type", "export type ExtensionHostContext = { [K in \"alpha\" | \"beta\"]: SafePort };"],
      ["a mapped type through an interface base", "export interface ExtensionHostContext extends Partial<{ alpha: SafePort }> {}"],
      ["a conditional type", "export type ExtensionHostContext<T = string> = T extends string ? { alpha: SafePort } : { beta: SafePort };"],
      ["any", "export type ExtensionHostContext = any;"],
      ["unknown", "export type ExtensionHostContext = unknown;"],
    ])("reports %s as one port-shape finding at the root", (_name, root) => {
      expect(rootForm(root)).toEqual(["port-shape [root-form]"]);
    });

    it("names the form, and does not read the members of a union as a port set", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "border-port-"));
      try {
        writeFileSync(
          path.join(dir, "host-context.ts"),
          `${decls}\nexport type ExtensionHostContext = BaseContext & ({ alpha: UnsafePort } | { beta: SafePort });\n`,
        );
        const hits = portFindings({ repoRoot: dir, file: "host-context.ts" }).filter((f) => f.detail === "[root-form]");
        expect(hits.map((f) => f.message.includes("written as a union"))).toEqual([true]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      ["an interface", "export interface ExtensionHostContext { id: string; alpha: SafePort }"],
      ["an alias of a type literal", "export type ExtensionHostContext = { id: string; alpha: SafePort };"],
      ["an intersection of two interfaces", "interface Wide { alpha: SafePort }\nexport type ExtensionHostContext = BaseContext & Wide;"],
      ["an interface with extends", "export interface ExtensionHostContext extends BaseContext { alpha: SafePort }"],
      ["an alias of an interface", "export type ExtensionHostContext = Mid;"],
      ["an interface extending an interface that extends one", "interface Wide extends BaseContext { alpha: SafePort }\nexport interface ExtensionHostContext extends Wide {}"],
    ])("does not report %s", (_name, root) => {
      expect(rootForm(root)).toEqual([]);
      expect(ports(decls, "", root).filter((f) => f.includes("root-form"))).toEqual([]);
    });
  });

  it("reports each signature of the root once, and a root without any as before", () => {
    const jobs = "interface JobsPort { run(): void }";
    expect(ports(jobs, "", "export interface ExtensionHostContext { jobs: JobsPort; (a: string): void; (b: number): void; new (): object }")).toEqual([
      "port-shape [call]",
      "port-shape [call] (occurrence 2)",
      "port-shape [construct]",
    ]);
    expect(ports(jobs, "", "export interface ExtensionHostContext { jobs: JobsPort; id: string }")).toEqual([]);
  });

  it.each([
    ["an untyped parameter after a typed one", "run(jobName: string, input: unknown): void", ["JobsPort.run(#2)"]],
    ["an any parameter", "ping(input: any): void", ["JobsPort.ping(#1)"]],
    ["a nullable function property", "run: ((jobName: string, input: unknown) => void) | null", ["JobsPort.run(#2)"]],
    ["a getter that returns a function", "get run(): (input: unknown) => void", ["JobsPort.run(#1)"]],
    ["an optional object", "run(input?: object): void", ["JobsPort.run(#1)"]],
    ["an object or null", "run(input: object | null): void", ["JobsPort.run(#1)"]],
    ["an unknown or undefined", "run(input: unknown | undefined): void", ["JobsPort.run(#1)"]],
    ["a rest of unknown", "run(name: string, ...args: unknown[]): void", ["JobsPort.run(#2)"]],
    ["an unconstrained type parameter", "set<T = unknown>(key: string, value: T): void", ["JobsPort.set(#2)"]],
    ["an optional type parameter", "run<T>(input?: T): void", ["JobsPort.run(#1)"]],
    ["an unconstrained type parameter intersected with the empty object", "run<T>(value: T & {}): void", ["JobsPort.run(#1)"]],
    ["NonNullable of an unconstrained type parameter", "run<T>(value: NonNullable<T>): void", ["JobsPort.run(#1)"]],
    ["the empty object type", "run(value: {}): void", ["JobsPort.run(#1)"]],
    ["the empty object type or null", "run(value: {} | null): void", ["JobsPort.run(#1)"]],
    ["NonNullable of unknown", "run(value: NonNullable<unknown>): void", ["JobsPort.run(#1)"]],
    ["a type parameter bound by an unconstrained one, intersected with the empty object", "run<T, U extends T>(value: U & {}): void", ["JobsPort.run(#1)"]],
    ["several positions", "run(payload: any, jobName: string, input: unknown): void", ["JobsPort.run(#1,#3)"]],
    ["overloads, each with its own positions", "run(a: unknown): void; run(b: string): void; run(c: any, d: any): void", ["JobsPort.run(#1|#1,#2)"]],
  ])("reports %s", (_name, member, keys) => {
    expect(ports(`interface JobsPort { ${member} }`)).toEqual(keys.map((k) => `untyped-port-input ${k}`));
  });

  // cinatra#4872: the rules read what the type checker resolves, not the syntax a type is written in.
  describe("a type is read through the checker, in whatever form it is written", () => {
    it("allows a member typed by a named function alias, readonly or optional too", () => {
      const handler = "type Handler = (input: string) => void;";
      expect(ports(`${handler}\ninterface JobsPort { run: Handler; stop?: Handler | null; readonly on: Handler; get off(): Handler }`)).toEqual([]);
      expect(ports("interface Handler { (input: string): void }\ninterface JobsPort { run: Handler }")).toEqual([]);
      expect(ports("type Handler<T> = (input: T) => void;\ninterface JobsPort { run: Handler<string> }")).toEqual([]);
    });

    it("still judges the parameters of a member typed by a named function alias", () => {
      expect(ports("type Handler = (input: any) => void;\ninterface JobsPort { run: Handler }")).toEqual(["untyped-port-input JobsPort.run(#1)"]);
      expect(ports("type Handler = (name: string, input: unknown) => void;\ninterface JobsPort { readonly run: Handler | null }")).toEqual(["untyped-port-input JobsPort.run(#2)"]);
      expect(ports("type Handler<T> = (name: string, input: T) => void;\ninterface JobsPort { run: Handler<any> }")).toEqual(["untyped-port-input JobsPort.run(#2)"]);
      expect(ports("type Handler = (this: unknown, input: object) => void;\ninterface JobsPort { run: Handler }")).toEqual(["untyped-port-input JobsPort.run(#1)"]);
    });

    const namespaced = "namespace Ports { export interface JobsPort { run(input: unknown): void } export interface TypedPort { run(input: string): void } export interface Base { run(input: object): void } }";

    it("reads a namespace-qualified port type like a bare one, and judges its members", () => {
      expect(ports(namespaced, "jobs: Ports.JobsPort")).toEqual(["untyped-port-input JobsPort.run(#1)"]);
      expect(ports(namespaced, "jobs: Ports.TypedPort | null")).toEqual([]);
      expect(ports(namespaced, "jobs: Ports.Missing")).toEqual(["port-shape jobs"]);
    });

    it("reads a namespace-qualified extends like a bare one, and judges its members", () => {
      expect(ports(`${namespaced}\ninterface JobsPort extends Ports.Base {}`)).toEqual(["untyped-port-input Base.run(#1)"]);
      expect(ports(`${namespaced}\ninterface JobsPort extends Ports.TypedPort { stop(input: any): void }`)).toEqual(["untyped-port-input JobsPort.stop(#1)"]);
      expect(ports(`${namespaced}\ninterface JobsPort extends Ports.TypedPort {}`)).toEqual([]);
    });

    it("reads a namespace import, an import under another name and a re-export to the same declaration", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "border-port-"));
      try {
        writeFileSync(path.join(dir, "ports.ts"), "export interface JobsPort { run(input: unknown): void }\nexport interface Base { run(input: object): void }\n");
        writeFileSync(path.join(dir, "reexport.ts"), 'export * as Inner from "./ports";\nexport { JobsPort as Renamed } from "./ports";\n');
        writeFileSync(
          path.join(dir, "host-context.ts"),
          [
            'import * as Ports from "./ports";',
            'import { JobsPort as Jobs } from "./ports";',
            'import * as Out from "./reexport";',
            "interface Mine extends Ports.Base {}",
            "export type ExtensionHostContext = { a: Ports.JobsPort; b: Jobs; c: Out.Inner.JobsPort; d: Out.Renamed; e: Mine };",
          ].join("\n"),
        );
        const found = portFindings({ repoRoot: dir, file: "host-context.ts" });
        expect(found.map((f) => `${f.rule} ${f.file}::${f.detail}`)).toEqual(["untyped-port-input ports.ts::JobsPort.run(#1)", "untyped-port-input ports.ts::Base.run(#1)"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("reads the root through the checker: inherited, intersected and merged properties", () => {
    const port = "interface JobsPort { run(input: unknown): void }\ninterface BaseContext { jobs: JobsPort }";
    const typed = [`untyped-port-input JobsPort.run(#1)`];
    expect(ports(port, "", "export interface ExtensionHostContext extends BaseContext { id: string }")).toEqual(typed);
    expect(ports(port, "", "export type ExtensionHostContext = BaseContext & { id: string };")).toEqual(typed);
    // a base outside the SDK: its properties are declared outside it
    const lib = ports("", "", "export interface ExtensionHostContext extends Map<string, string> {}");
    expect(lib.length).toBeGreaterThan(0);
    expect(lib.every((f) => f.startsWith("port-shape "))).toBe(true);
    expect(lib).toContain("port-shape size");
    // a property declared twice by merging has no single declaration
    expect(ports("interface JobsPort { run(): void }\ninterface ExtensionHostContext { jobs: JobsPort }", "", "interface ExtensionHostContext { jobs: JobsPort }")).toEqual(["port-shape jobs"]);
  });

  it("reports an untyped input of a base under the base's name", () => {
    expect(ports("interface Base { run(input: object): void }\ninterface JobsPort extends Base {}")).toEqual([
      "untyped-port-input Base.run(#1)",
    ]);
  });

  it.each([
    ["an optional string", "run(input?: string): void"],
    ["an object literal or null", "run(input: { id: string } | null): void"],
    ["a rest of strings", "run(...args: string[]): void"],
    ["a constrained type parameter", "run<T extends { id: string }>(value: T): void"],
    ["a type parameter intersected with an object that has a member", "run<T>(value: T & { id: string }): void"],
    ["a self-referential constraint", "run<T extends { next: T }>(value: T): void"],
    ["NonNullable of a constrained type parameter", "run<T extends { id: string }>(value: NonNullable<T>): void"],
    ["a reduced type", "run(a: unknown & { id: string }, b: keyof Record<string, unknown>): void"],
    ["a record (not read)", "run(input: Record<string, unknown>): void"],
    ["a this parameter (not an input)", "run(this: unknown, name: string): void"],
    ["a callback parameter (not read)", "on(handler: (payload: unknown) => void): void"],
  ])("leaves %s alone", (_name, member) => {
    expect(ports(`interface JobsPort { ${member} }`)).toEqual([]);
  });

  it("keys by position, so a rename that keeps the types keeps the key", () => {
    expect(ports("interface JobsPort { run(renamed: unknown, text: string): void }")).toEqual(
      ports("interface JobsPort { run(input: unknown, name: string): void }"),
    );
  });

  it("gives, on the real host context, exactly the six untyped inputs that stand on main", () => {
    const standing = portFindings({ repoRoot: REPO_ROOT }).map((f) => `${f.rule} ${f.file}::${f.detail}`);
    expect(standing.sort()).toEqual((SEEDS["untyped-port-input"] ?? ["none"]).map((k) => `untyped-port-input ${k}`).sort());
    expect(standing).toHaveLength(6);
    const list = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    expect(list.installedRules).toEqual(["port-shape", "untyped-port-input"]);
    expect(list.entries.filter((e: { rule: string }) => e.rule === "untyped-port-input")).toHaveLength(6);
  });

  // The first recording of each rule is a closed seed, consumed for good by a
  // marker in the list's `installedRules` that can never be removed.
  describe("the first recording", () => {
    const FLOOR = path.relative(REPO_ROOT, BASELINE_PATH).split(path.sep).join("/");
    const entry = (key: string) => ({ rule: "untyped-port-input", key, reason: "a member of a fixture port, with its reason" });
    const seed = () => {
      expect(SEEDS["untyped-port-input"] ?? []).toHaveLength(6);
      return SEEDS["untyped-port-input"].map(entry);
    };
    const marked = { installedRules: ["port-shape", "untyped-port-input"] };
    const fixtures: { cleanup: () => void }[] = [];
    afterEach(() => {
      while (fixtures.length) fixtures.pop()?.cleanup();
    });
    function check(base: Record<string, unknown>, head: Record<string, unknown>) {
      const f = floorFixture.makeFloorRepo({ base: { [FLOOR]: base }, head: { [FLOOR]: head } });
      fixtures.push(f);
      return gate.checkFloorAgainstBase({ repoRoot: f.root, env: floorFixture.PULL_REQUEST_RUN });
    }

    it("admits the seed on a base without the marker", () => {
      const r = check({ entries: [] }, { ...marked, entries: seed() });
      expect([r.ok, r.status]).toEqual([true, "held"]);
    });

    it("refuses the seed without the marker, with one key more, or in part", () => {
      const extra = entry("packages/sdk-extensions/src/host-context.ts::HostJobsPort.extra(#1)");
      expect(check({ entries: [] }, { entries: seed() }).ok).toBe(false);
      expect(check({ entries: [] }, { ...marked, entries: [...seed(), extra] }).growth).toContain(`new entry: untyped-port-input::${extra.key}`);
      expect(check({ entries: [] }, { ...marked, entries: seed().slice(1) }).ok).toBe(false);
    });

    it("refuses a new key once the base carries the marker, also when no entry is left", () => {
      expect(check({ ...marked, entries: seed().slice(1) }, { ...marked, entries: seed() }).growth).toHaveLength(1);
      expect(check({ ...marked, entries: [] }, { ...marked, entries: seed() }).growth).toHaveLength(6);
    });

    it("refuses a head that lacks a marker the base has, and a marker that is no list of rules", () => {
      expect(check({ ...marked, entries: seed() }, { entries: seed() }).growth).toEqual([
        "installed rule marker removed: port-shape",
        "installed rule marker removed: untyped-port-input",
      ]);
      expect(gate.baselineDefects({ entries: [], installedRules: "port-shape" })).toHaveLength(1);
      expect(gate.baselineDefects({ entries: [], installedRules: ["no-such-rule"] })).toHaveLength(1);
      expect(gate.baselineDefects({ entries: [], ...marked })).toEqual([]);
    });
  });
});

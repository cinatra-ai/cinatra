// THE CORE/EXTENSION BORDER, ASSERTED BY THE REQUIRED SUITE.
//
// This file lives in packages/extensions/src/__tests__/ on purpose: the
// `Canonical extension invariants` job runs the WHOLE package
// (`cd packages/extensions && pnpm test`), so a border regression fails a
// REQUIRED check without any workflow edit.
//
// Two halves:
//   1. FIXTURES — a synthetic snippet per crossing class, proving the scanner
//      catches the class rather than one file that happens to be on main.
//   2. THE REPOSITORY — the same scanner over the real tree, proving the
//      committed baseline covers exactly the standing debt and nothing new.

import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const GATE_PATH = path.join(REPO_ROOT, "scripts", "ci", "core-extension-border-gate.mjs");
const BASELINE_PATH = path.join(REPO_ROOT, "config", "core-extension-border-baseline.json");

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
      "packages/agents/src/blog-idea-selection-renderer.tsx",
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
    expect(keys).toContain("packages/agents/src/blog-idea-selection-renderer.tsx");
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

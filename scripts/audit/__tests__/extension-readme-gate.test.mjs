// Tests for the extension README gate
// (contract in docs/developer/extension-readme.md).
//
// Contract is OpenAI-workspace-agent-template-style: H1 + description paragraph
// + optional `## Works with` (>=1 bullet) + required `## Capabilities` (>=2 bullets).
// Nothing else.

import { describe, expect, it, beforeEach } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  VALID_KINDS,
  ALLOWED_H2,
  README_MIN_BYTES,
  README_MAX_BYTES,
  stripCodeFences,
  parseBlocks,
  findRawHtml,
  hasFrontmatter,
  isEmphasisOnlyParagraph,
  validateReadmeContent,
  scanExtensions,
  checkNoNewDebt,
} from "../extension-readme-gate.mjs";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const GATE_SCRIPT = resolve(REPO_ROOT, "scripts/audit/extension-readme-gate.mjs");

// ---------------------------------------------------------------------------
// Live smoke

describe("extension README gate — live smoke", () => {
  it("either PASSes or FAILs cleanly against the current worktree state", () => {
    const r = spawnSync("node", [GATE_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, CINATRA_README_GATE_BASE_REF: "" },
    });
    // Either PASS (everything authored) or FAIL with contract errors (mid-authoring).
    // Either way the script must exit 0 or 1 — never 2 (internal error).
    expect([0, 1]).toContain(r.status);
  });
});

// ---------------------------------------------------------------------------
// Fence-aware primitives

describe("stripCodeFences", () => {
  it("strips ``` fences", () => {
    expect(stripCodeFences("a\n```\n# H1 inside\n```\nb")).not.toContain("# H1 inside");
  });
  it("strips ~~~ fences", () => {
    expect(stripCodeFences("a\n~~~\n## inside\n~~~\nb")).not.toContain("## inside");
  });
  it("strips inline `code`", () => {
    expect(stripCodeFences("Use `<script>` here")).not.toContain("<script>");
  });
});

describe("parseBlocks", () => {
  it("captures headings, bullets, and paragraphs", () => {
    const b = parseBlocks("# Title\n\nbody para\n\n## Works with\n\n- One\n- Two");
    const types = b.map((x) => `${x.type}:${x.level ?? ""}`).filter((t) => t !== "blank:");
    expect(types).toEqual(["heading:1", "para:", "heading:2", "bullet:", "bullet:"]);
  });
});

describe("isEmphasisOnlyParagraph", () => {
  it("matches *tag* and _tag_", () => {
    expect(isEmphasisOnlyParagraph("*A short tagline.*")).toBe(true);
    expect(isEmphasisOnlyParagraph("_Another tagline._")).toBe(true);
  });
  it("does not match prose with inline emphasis", () => {
    expect(isEmphasisOnlyParagraph("This is *not* tagline-only.")).toBe(false);
  });
  it("does not match empty", () => {
    expect(isEmphasisOnlyParagraph("  ")).toBe(false);
  });
});

describe("findRawHtml", () => {
  it("matches <br>, <script>, <a>", () => {
    expect(findRawHtml("<br>")).toHaveLength(1);
    expect(findRawHtml("<script>")).toHaveLength(1);
    expect(findRawHtml('<a href="x">')).toHaveLength(1);
  });
  it("does not match autolinks or comments", () => {
    expect(findRawHtml("<http://example.com>")).toHaveLength(0);
    expect(findRawHtml("<!-- comment -->")).toHaveLength(0);
  });
});

describe("hasFrontmatter", () => {
  it("detects YAML and TOML", () => {
    expect(hasFrontmatter("---\nfoo: 1\n---\n# body")).toBe(true);
    expect(hasFrontmatter("+++\nfoo = 1\n+++\n# body")).toBe(true);
  });
  it("ignores horizontal rule mid-doc", () => {
    expect(hasFrontmatter("# body\n\n---\n\nmore")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateReadmeContent — full grammar

function happyReadme(extra = "") {
  const text =
    "# Sample Agent\n\n" +
    "Prepare a high-signal operating brief from schedule, inbox, and team-chat context. " +
    "Useful for teams that need sharper priorities and meeting prep in one daily artifact. " +
    "Reads from the connected apps below and produces a scan-friendly brief.\n\n" +
    "## Works with\n\n" +
    "- Gmail\n" +
    "- Slack\n\n" +
    "## Capabilities\n\n" +
    "- Prepare an operating brief from schedule, inbox, and team chat\n" +
    "- Format a scan-friendly brief with TODOs and source links\n" +
    extra;
  return text;
}

describe("validateReadmeContent — happy path", () => {
  it("accepts a conformant agent README", () => {
    const text = happyReadme();
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) })).toEqual([]);
  });

  it("accepts a conformant README WITHOUT Works with", () => {
    const text =
      "# Sample Skill\n\n" +
      "Improves the way the generation agents stay on brand by matching the voice of the target site. " +
      "Plug-in editorial guidance, no setup required.\n\n" +
      "## Capabilities\n\n" +
      "- Match brand voice in generated content\n" +
      "- Hold a consistent length and structure across drafts\n";
    expect(validateReadmeContent({ kind: "skill", text, sizeBytes: Buffer.byteLength(text) })).toEqual([]);
  });

  it("accepts every kind with the same shape", () => {
    for (const kind of VALID_KINDS) {
      const text = happyReadme();
      expect(validateReadmeContent({ kind, text, sizeBytes: Buffer.byteLength(text) })).toEqual([]);
    }
  });
});

describe("validateReadmeContent — gate violations", () => {
  it("rejects unknown kind", () => {
    const errs = validateReadmeContent({ kind: "bogus", text: happyReadme(), sizeBytes: 500 });
    expect(errs[0]).toMatch(/unknown kind/);
  });

  it("rejects too small", () => {
    const text = "# x\n\ny\n\n## Capabilities\n\n- a\n- b\n";
    expect(
      validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /under minimum/.test(e)),
    ).toBe(true);
  });

  it("rejects too large", () => {
    const text = "# x\n\n" + "y".repeat(README_MAX_BYTES) + "\n\n## Capabilities\n\n- a\n- b\n";
    expect(
      validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /over maximum/.test(e)),
    ).toBe(true);
  });

  it("rejects YAML frontmatter", () => {
    const text = "---\nfoo: 1\n---\n" + happyReadme();
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /frontmatter/.test(e))).toBe(true);
  });

  it("rejects raw HTML outside fences", () => {
    const text = happyReadme("\n\n<script>alert(1)</script>\n");
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /raw HTML/.test(e))).toBe(true);
  });

  it("does not reject HTML inside fenced code", () => {
    const text = happyReadme("\n\n```\n<script>example</script>\n```\n");
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) })).toEqual([]);
  });

  it("rejects multiple H1s", () => {
    const text = happyReadme().replace("# Sample Agent", "# Sample Agent\n# Extra H1");
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /H1 count is 2/.test(e))).toBe(true);
  });

  it("rejects H3 (or any deeper heading)", () => {
    const text = happyReadme() + "\n### Subhead is forbidden\n\nbody\n";
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /H3\+/.test(e))).toBe(true);
  });

  it("rejects disallowed H2 (e.g. Requirements)", () => {
    const text = happyReadme() + "\n## Requirements\n\n- A key\n- A connector\n";
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /disallowed H2/.test(e))).toBe(true);
  });

  it("rejects missing Capabilities", () => {
    const text = "# x\n\nDescription paragraph that is long enough to satisfy the size bound for the README contract, " +
      "covering value plain language and what the user gets. It is intentionally a single block of prose with no italic-only tagline " +
      "underneath the H1 because that emphasis-only block is forbidden by the grammar.\n";
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /missing required section: "## Capabilities"/.test(e))).toBe(true);
  });

  it("rejects Works with AFTER Capabilities (wrong order)", () => {
    const text =
      "# x\n\nbody paragraph that is long enough to clear the minimum size threshold the gate enforces for every README in the contract.\n\n" +
      "## Capabilities\n\n- a\n- b\n\n" +
      "## Works with\n\n- Gmail\n";
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /must come BEFORE/.test(e))).toBe(true);
  });

  it("rejects Capabilities with only 1 bullet", () => {
    const text =
      "# x\n\nbody paragraph that is long enough to clear the minimum size threshold the gate enforces for every README in the contract.\n\n" +
      "## Capabilities\n\n- one\n";
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /at least 2 bullets/.test(e))).toBe(true);
  });

  it("accepts Works with with 1 bullet (single-integration agent)", () => {
    const text =
      "# x\n\n" +
      "Body paragraph that is long enough to clear the minimum size threshold the gate enforces for every README in the contract. " +
      "Padded to ensure the 250-byte minimum is exceeded by a comfortable margin so size never confounds the bullet-count assertion.\n\n" +
      "## Works with\n\n- Gmail\n\n" +
      "## Capabilities\n\n- one capability\n- another capability\n";
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) })).toEqual([]);
  });

  it("rejects missing description paragraph between H1 and first H2", () => {
    const text =
      "# x\n\n## Capabilities\n\n- a\n- b\n";
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /missing description paragraph/.test(e))).toBe(true);
  });

  it("rejects bullets between H1 and first H2", () => {
    const text =
      "# x\n\n- a stray bullet that is enough text to qualify\n\n## Capabilities\n\n- a\n- b\n";
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /must not contain bullets/.test(e))).toBe(true);
  });

  it("rejects italic-only tagline directly under H1", () => {
    const text =
      "# x\n\n*Italic-only tagline.*\n\nReal body paragraph that is long enough to clear the minimum size threshold the gate enforces.\n\n" +
      "## Capabilities\n\n- a\n- b\n";
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /italic-only tagline/.test(e))).toBe(true);
  });

  it("rejects prose paragraphs inside a section (only bullets allowed)", () => {
    const text =
      "# x\n\nbody paragraph that is long enough to clear the minimum size threshold the gate enforces for every README in the contract.\n\n" +
      "## Capabilities\n\nThis is prose, not a bullet list, which the gate forbids inside section bodies.\n\n- a\n- b\n";
    expect(validateReadmeContent({ kind: "agent", text, sizeBytes: Buffer.byteLength(text) }).some((e) => /must contain bullets only/.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scanExtensions — state machine

function buildExt(root, slug, kind, opts = {}) {
  const dir = join(root, "extensions", "cinatra-ai", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `@cinatra-ai/${slug}`,
      version: "0.1.0",
      cinatra: { apiVersion: "cinatra.ai/v1", kind },
    }),
  );
  if (opts.readme) writeFileSync(join(dir, "README.md"), opts.readme);
  if (opts.marker !== undefined) writeFileSync(join(dir, ".readme-pending"), opts.marker);
  return dir;
}

describe("scanExtensions — state machine", () => {
  let tmpRoot;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "readme-gate-test-"));
  });

  it("PASS — conformant README, no marker", async () => {
    buildExt(tmpRoot, "alpha-agent", "agent", { readme: happyReadme() });
    const r = await scanExtensions(tmpRoot);
    expect(r.errors).toEqual([]);
  });

  it("PASS — no README, has marker (known debt)", async () => {
    buildExt(tmpRoot, "beta-agent", "agent", { marker: "" });
    const r = await scanExtensions(tmpRoot);
    expect(r.errors).toEqual([]);
  });

  it("FAIL — neither README nor marker", async () => {
    buildExt(tmpRoot, "gamma-agent", "agent");
    const r = await scanExtensions(tmpRoot);
    expect(r.errors.some((e) => /untracked missing README/.test(e.message))).toBe(true);
  });

  it("FAIL — both README and marker (stale marker)", async () => {
    buildExt(tmpRoot, "delta-agent", "agent", { readme: happyReadme(), marker: "" });
    const r = await scanExtensions(tmpRoot);
    expect(r.errors.some((e) => /stale debt marker/.test(e.message))).toBe(true);
  });

  it("FAIL — non-zero-byte marker", async () => {
    buildExt(tmpRoot, "epsilon-agent", "agent", { marker: "junk" });
    const r = await scanExtensions(tmpRoot);
    expect(r.errors.some((e) => /marker must be 0 bytes/.test(e.message))).toBe(true);
  });

  it("FAIL — orphan marker in example-namespace scope", async () => {
    const orphanDir = join(tmpRoot, "extensions", "example-namespace", "blog-connector");
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, ".readme-pending"), "");
    const r = await scanExtensions(tmpRoot);
    expect(r.errors.some((e) => /orphan marker/.test(e.message))).toBe(true);
  });

  it("FAIL — orphan marker nested too deep", async () => {
    buildExt(tmpRoot, "zeta-agent", "agent", { marker: "" });
    const nested = join(tmpRoot, "extensions", "cinatra-ai", "zeta-agent", "sub");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, ".readme-pending"), "");
    const r = await scanExtensions(tmpRoot);
    expect(r.errors.some((e) => /orphan marker/.test(e.message))).toBe(true);
  });

  it("ignores dirs without cinatra.kind", async () => {
    const noKindDir = join(tmpRoot, "extensions", "cinatra-ai", "no-kind-dir");
    mkdirSync(noKindDir, { recursive: true });
    writeFileSync(join(noKindDir, "package.json"), JSON.stringify({ name: "x" }));
    const r = await scanExtensions(tmpRoot);
    expect(r.errors).toEqual([]);
  });

  it("flags contract violations on present READMEs (disallowed H2)", async () => {
    const bad = happyReadme() + "\n## Requirements\n\n- a\n- b\n";
    buildExt(tmpRoot, "eta-agent", "agent", { readme: bad });
    const r = await scanExtensions(tmpRoot);
    expect(r.errors.some((e) => /disallowed H2/.test(e.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkNoNewDebt

function initTmpRepo() {
  const root = mkdtempSync(join(tmpdir(), "readme-gate-git-"));
  const sh = (cmd) => execSync(cmd, { cwd: root, encoding: "utf8" });
  sh("git init -q -b main");
  sh("git config user.email a@b.c");
  sh("git config user.name test");
  return { root, sh };
}

describe("checkNoNewDebt", () => {
  it("skips when baseRef is empty", () => {
    const { root } = initTmpRepo();
    expect(checkNoNewDebt(root, "")).toEqual([]);
  });

  it("info-level bootstrap when gate not in base", () => {
    const { root, sh } = initTmpRepo();
    sh("mkdir -p extensions/cinatra-ai/foo && echo '{}' > extensions/cinatra-ai/foo/package.json");
    sh("git add . && git commit -q -m base");
    const f = checkNoNewDebt(root, "main");
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe("info");
  });

  it("flags a NEW marker added on PR vs base", () => {
    const { root, sh } = initTmpRepo();
    sh("mkdir -p scripts/audit extensions/cinatra-ai/base-agent");
    sh("echo gate > scripts/audit/extension-readme-gate.mjs");
    sh("echo '{}' > extensions/cinatra-ai/base-agent/package.json");
    sh("git add . && git commit -q -m base");
    sh("git checkout -q -b pr");
    sh("mkdir -p extensions/cinatra-ai/new-agent");
    sh("echo '{}' > extensions/cinatra-ai/new-agent/package.json");
    sh(": > extensions/cinatra-ai/new-agent/.readme-pending");
    sh("git add . && git commit -q -m pr");
    expect(checkNoNewDebt(root, "main").some((f) => f.kind === "error" && /new debt marker/.test(f.message))).toBe(true);
  });

  it("catches the rename-as-A bypass (--no-renames)", () => {
    const { root, sh } = initTmpRepo();
    sh("mkdir -p scripts/audit extensions/cinatra-ai/old-agent");
    sh("echo gate > scripts/audit/extension-readme-gate.mjs");
    sh("echo '{}' > extensions/cinatra-ai/old-agent/package.json");
    sh(": > extensions/cinatra-ai/old-agent/.readme-pending");
    sh("git add . && git commit -q -m base");
    sh("git checkout -q -b pr");
    sh("mkdir -p extensions/cinatra-ai/new-agent");
    sh("echo '{}' > extensions/cinatra-ai/new-agent/package.json");
    sh("git mv extensions/cinatra-ai/old-agent/.readme-pending extensions/cinatra-ai/new-agent/.readme-pending");
    sh("git add . && git commit -q -m rename");
    expect(
      checkNoNewDebt(root, "main").some(
        (f) => f.kind === "error" && /new debt marker/.test(f.message) && /new-agent/.test(f.message),
      ),
    ).toBe(true);
  });
});

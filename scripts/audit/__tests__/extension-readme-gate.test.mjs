// Tests for the extension README gate
// (contract in docs/developer/extension-readme.md).
//
// Contract is OpenAI-workspace-agent-template-style: H1 + description paragraph
// + optional `## Works with` (>=1 bullet) + required `## Capabilities` (>=2 bullets).
// Nothing else.

import { describe, expect, it, beforeEach } from "vitest";
import { spawnSync, execSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Base-ref resolution (cinatra#2212)
//
// The gate's base used to be the live `origin/<base>` ref, materialized by a
// `git fetch --no-tags --depth=1`. On the complete clone actions/checkout
// produces at fetch-depth: 0, that fetch does NOT move the ref when the live
// tip is already present — it only writes .git/shallow at that tip, severing
// its ancestry. A run whose merge commit was recorded BEFORE main moved on then
// has no reachable common ancestor and `git diff origin/<base>...HEAD` dies
// with `fatal: origin/<base>...HEAD: no merge base`.
//
// These build the CI shape at the git level (bare origin + a recorded
// refs/pull/N/merge + main advancing afterwards + a fetch-depth:0 workspace)
// and drive the REAL checkNoNewDebt(), so they prove both the failure mode and
// that the pinned-merge-base base is immune to it — and that a FRESH run's
// debt calculation is byte-identical under either base.

const gitIn = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function writeIn(cwd, rel, body) {
  mkdirSync(join(cwd, rel, ".."), { recursive: true });
  writeFileSync(join(cwd, rel), body);
}

function commitIn(cwd, msg) {
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "-c", "user.email=a@b.c", "-c", "user.name=test", "commit", "-q", "-m", msg);
  return gitIn(cwd, "rev-parse", "HEAD");
}

// Returns { ws, baseSha, mergeSha, liveTip } where `ws` is a workspace cloned
// exactly the way actions/checkout@fetch-depth:0 clones a pull_request run:
// every branch + the event's pinned merge commit, checked out detached.
//   advanceMain: main gains commits AFTER the merge commit is recorded (the
//                stale-snapshot / merge-train condition).
//   prAddsMarker: the PR adds one extensions/cinatra-ai/<slug>/.readme-pending.
function buildPullRequestWorkspace({ advanceMain, prAddsMarker }) {
  const root = mkdtempSync(join(tmpdir(), "readme-gate-basefetch-"));
  const origin = join(root, "origin.git");
  const up = join(root, "upstream");
  gitIn(root, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(up);
  gitIn(up, "init", "-q", "-b", "main");
  gitIn(up, "remote", "add", "origin", origin);

  // Base: the gate script must exist in the base tree or checkNoNewDebt takes
  // its bootstrap-mode early return and never reaches the diff.
  writeIn(up, "scripts/audit/extension-readme-gate.mjs", "// gate\n");
  writeIn(up, "extensions/cinatra-ai/base-agent/package.json", "{}\n");
  const baseSha = commitIn(up, "base"); // == github.event.pull_request.base.sha
  gitIn(up, "push", "-q", "origin", "main");

  // PR head, then the merge commit GitHub records as github.sha for the event.
  gitIn(up, "checkout", "-q", "-b", "pr-head");
  writeIn(up, "extensions/cinatra-ai/new-agent/package.json", "{}\n");
  if (prAddsMarker) writeIn(up, "extensions/cinatra-ai/new-agent/.readme-pending", "");
  const headSha = commitIn(up, "pr");
  gitIn(up, "checkout", "-q", "-b", "merge-ref", baseSha);
  gitIn(up, "-c", "user.email=a@b.c", "-c", "user.name=test", "merge", "-q", "--no-ff", "-m", "merge pr", headSha);
  const mergeSha = gitIn(up, "rev-parse", "HEAD");
  gitIn(up, "push", "-q", "origin", "merge-ref:refs/pull/1/merge");

  // The merge train rolls on while this run sits queued.
  let liveTip = baseSha;
  if (advanceMain) {
    gitIn(up, "checkout", "-q", "main");
    writeIn(up, "docs/other.md", "someone else's merge\n");
    liveTip = commitIn(up, "unrelated main commit");
    gitIn(up, "push", "-q", "origin", "main");
  }

  const ws = join(root, "workspace");
  mkdirSync(ws);
  gitIn(ws, "init", "-q");
  // file:// (not a plain path) so --depth behaves like it does over the wire.
  gitIn(ws, "remote", "add", "origin", `file://${origin}`);
  gitIn(ws, "fetch", "--no-tags", "--prune", "-q", "origin",
    "+refs/heads/*:refs/remotes/origin/*", `+${mergeSha}:refs/remotes/pull/1/merge`);
  gitIn(ws, "checkout", "-q", "--detach", mergeSha);
  return { ws, baseSha, mergeSha, liveTip };
}

const markerPathsOf = (findings) =>
  findings
    .filter((f) => f.kind === "error")
    .map((f) => f.message.replace(/^\[no-new-debt] new debt marker added vs \S+: /, ""))
    .sort();

describe("checkNoNewDebt — base resolution on a stale PR snapshot (cinatra#2212)", () => {
  it("depth-1 base fetch grafts a shallow island → 'no merge base'; the pinned merge base is immune", () => {
    const { ws, baseSha, liveTip } = buildPullRequestWorkspace({ advanceMain: true, prAddsMarker: true });

    // Connected clone, before the workflow's base fetch: the check works.
    expect(markerPathsOf(checkNoNewDebt(ws, "origin/main"))).toEqual([
      "extensions/cinatra-ai/new-agent/.readme-pending",
    ]);

    // The old workflow step, verbatim. It exits 0 and does not move the ref…
    const fetchOut = execFileSync(
      "git",
      ["fetch", "--no-tags", "--depth=1", "origin", "main:refs/remotes/origin/main"],
      { cwd: ws, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(fetchOut).toBe("");
    expect(gitIn(ws, "rev-parse", "origin/main")).toBe(liveTip);
    // …it only grafts the live tip as parentless.
    expect(gitIn(ws, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(readFileSync(join(ws, ".git", "shallow"), "utf8").trim()).toBe(liveTip);

    // The reported red: a diff failure dressed up as a gate finding.
    const broken = checkNoNewDebt(ws, "origin/main");
    expect(broken).toHaveLength(1);
    expect(broken[0].kind).toBe("error");
    expect(broken[0].message).toMatch(/\[no-new-debt] git diff failed/);
    expect(broken[0].message).toMatch(/no merge base/);

    // The fix: this run's own merge base, pinned as a SHA. Still correct even
    // with the graft in place, because the graft is at the LIVE tip, not here.
    const mergeBase = gitIn(ws, "merge-base", baseSha, "HEAD");
    expect(mergeBase).toBe(baseSha);
    expect(markerPathsOf(checkNoNewDebt(ws, mergeBase))).toEqual([
      "extensions/cinatra-ai/new-agent/.readme-pending",
    ]);
  });

  it("fresh run (main unmoved): live base ref and pinned merge base flag the SAME debt", () => {
    const { ws, baseSha } = buildPullRequestWorkspace({ advanceMain: false, prAddsMarker: true });
    const mergeBase = gitIn(ws, "merge-base", baseSha, "HEAD");
    expect(mergeBase).toBe(gitIn(ws, "rev-parse", "origin/main"));
    const viaRef = markerPathsOf(checkNoNewDebt(ws, "origin/main"));
    expect(viaRef).toEqual(["extensions/cinatra-ai/new-agent/.readme-pending"]);
    expect(markerPathsOf(checkNoNewDebt(ws, mergeBase))).toEqual(viaRef);
  });

  it("fresh run, no new marker: both bases agree the PR is clean", () => {
    const { ws, baseSha } = buildPullRequestWorkspace({ advanceMain: false, prAddsMarker: false });
    const mergeBase = gitIn(ws, "merge-base", baseSha, "HEAD");
    expect(checkNoNewDebt(ws, "origin/main")).toEqual([]);
    expect(checkNoNewDebt(ws, mergeBase)).toEqual([]);
  });

  it("stale snapshot, no new marker: the pinned merge base still reports clean (the old base could not)", () => {
    const { ws, baseSha } = buildPullRequestWorkspace({ advanceMain: true, prAddsMarker: false });
    execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", "main:refs/remotes/origin/main"], {
      cwd: ws,
      stdio: "ignore",
    });
    expect(checkNoNewDebt(ws, "origin/main")[0].message).toMatch(/no merge base/);
    expect(checkNoNewDebt(ws, gitIn(ws, "merge-base", baseSha, "HEAD"))).toEqual([]);
  });
});

describe("extension-readme-gate.yml — base resolution stays graft-free", () => {
  const WORKFLOW = resolve(REPO_ROOT, ".github/workflows/extension-readme-gate.yml");

  it("never shallow-fetches the base (a --depth fetch re-introduces cinatra#2212)", () => {
    expect(existsSync(WORKFLOW)).toBe(true);
    const yml = readFileSync(WORKFLOW, "utf8");
    // No `git fetch … --depth …` anywhere (prose mentioning --depth is fine).
    expect(yml).not.toMatch(/^\s*git fetch[^\n]*--depth/m);
    expect(yml).toMatch(/fetch-depth: 0/);
  });

  it("passes the run's own recorded base commit to the gate", () => {
    const yml = readFileSync(WORKFLOW, "utf8");
    expect(yml).toMatch(/BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    expect(yml).toMatch(/git merge-base "\$\{BASE_SHA\}" HEAD/);
    expect(yml).toMatch(/CINATRA_README_GATE_BASE_REF: \$\{\{ steps\.merge-base\.outputs\.sha \}\}/);
  });
});

// skill-packaging gate (cinatra#2089, epic #2086 S2) — the verdict's rule
// matrix, plus the AGREEMENT PINS that make "the same verdict at CI, store
// install and publish" a fact rather than a claim:
//
//   1. the one-hop router lint in the shared `.mjs` verdict and its TypeScript
//      twin `lintBundleRouterReferences` (src/lib/skill-bundle-store.ts, the S1
//      diagnostic this slice makes fail-closed) accept and reject the SAME
//      fixture matrix;
//   2. the upload size boundary matches the S0 authority
//      (`ANTHROPIC_SKILL_MAX_UPLOAD_BYTES`);
//   3. the skill-role vocabulary matches the manifest contract in
//      `@cinatra-ai/extension-types`.
//
// Do not change one side without the other.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_FRONTMATTER_KEYS,
  SKILL_BUNDLE_MAX_BYTES,
  SKILL_PACKAGE_NAME_RE,
  SKILL_ROLES,
  SKILL_ROUTER_MAX_LINES,
  applyLegacyExceptions,
  formatViolations,
  lintRouterOneHopReferences,
  matchesAllowlist,
  matchesGlob,
  readSkillFrontmatterStrict,
  resolveFixtureAllowlist,
  validateNonSkillExtensionPackage,
  validateSkillBundle,
  validateSkillExtensionPackage,
  validateSkillFrontmatter,
} from "../_lib/skill-packaging-verdict.mjs";
import { lintBundleRouterReferences } from "../../../src/lib/skill-bundle-store.ts";
import { ANTHROPIC_SKILL_MAX_UPLOAD_BYTES } from "../../../packages/llm/src/tools/anthropic-skill-content-hash.ts";
import { SKILL_EXTENSION_ROLES, resolveSkillExtensionRole } from "../../../packages/extension-types/src/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const router = (name, body = "Body.") =>
  `---\nname: ${name}\ndescription: Use when the task is to do the thing this skill describes.\n---\n\n${body}\n`;

const bundleOf = (name, files = []) => ({
  dirName: name,
  routerText: router(name),
  files: [{ path: "SKILL.md", byteLength: 100 }, ...files],
});

const codes = (violations) => violations.map((v) => v.code).sort();

// ---------------------------------------------------------------------------
// Frontmatter schema
// ---------------------------------------------------------------------------

describe("frontmatter schema (strict)", () => {
  it("accepts an Anthropic-clean router", () => {
    expect(validateSkillFrontmatter(router("my-skill"))).toBeNull();
  });

  it("accepts cinatra semantics nested under metadata", () => {
    const content =
      "---\nname: my-skill\ndescription: Use when doing the thing.\nmetadata:\n  match_when:\n    - agent_id: \"@cinatra-ai/x-agent\"\n---\n\nBody\n";
    expect(validateSkillFrontmatter(content)).toBeNull();
  });

  it("REJECTS a top-level match_when (the placement the upstream validator refuses)", () => {
    const content = "---\nname: my-skill\ndescription: Use when doing it.\nmatch_when: always\n---\n\nBody\n";
    expect(validateSkillFrontmatter(content)).toMatch(/Unexpected key\(s\).*match_when/s);
  });

  it("is STRICT, not fail-quiet: malformed YAML is a named reason, never a silent pass", () => {
    // The pre-S2 reader returned `undefined` here and the skill silently lost
    // its rules.
    const content = "---\nname: my-skill\ndescription: a: b unquoted mapping\n---\n\nBody\n";
    expect(validateSkillFrontmatter(content)).toBe(
      "Invalid YAML in frontmatter: mapping values are not allowed here",
    );
    expect(readSkillFrontmatterStrict(content).ok).toBe(false);
  });

  it("rejects an absent frontmatter block, a duplicate key, a non-kebab name and an over-long description", () => {
    expect(validateSkillFrontmatter("no frontmatter here")).toBe("No YAML frontmatter found");
    expect(validateSkillFrontmatter("---\nname: a\nname: b\ndescription: d\n---\n")).toMatch(/duplicate top-level key/);
    expect(validateSkillFrontmatter("---\nname: My_Skill\ndescription: d\n---\n")).toMatch(/kebab-case/);
    expect(
      validateSkillFrontmatter(`---\nname: a\ndescription: ${"x".repeat(1025)}\n---\n`),
    ).toMatch(/Description is too long/);
  });

  it("permits exactly the upstream key set", () => {
    expect([...ALLOWED_FRONTMATTER_KEYS].sort()).toEqual(
      ["allowed-tools", "compatibility", "description", "license", "metadata", "name"],
    );
  });
});

// ---------------------------------------------------------------------------
// One-hop router lint — rules + the S1 twin agreement pin
// ---------------------------------------------------------------------------

const LINT_MATRIX = [
  { md: "See [refs](references/guide.md).", paths: ["SKILL.md", "references/guide.md"] },
  { md: "See [refs](references/guide.md).", paths: ["SKILL.md"] },
  { md: "Read `references/deep/thing.md` first.", paths: ["SKILL.md"] },
  { md: "Read `references/deep/thing.md` first.", paths: ["SKILL.md", "references/deep/thing.md"] },
  // inline code naming a file under a directory the bundle DOES ship
  { md: "Read `references/gone.md`.", paths: ["SKILL.md", "references/kept.md"] },
  // inline code naming a path in ANOTHER tree (the authoring skills' prose)
  { md: "Bump `cinatra/oas.json` and `packages/agents/src/a2a-actions.ts`.", paths: ["SKILL.md"] },
  { md: "Copy `major-release-workflow/cinatra/workflow.bpmn`.", paths: ["SKILL.md", "references/x.md"] },
  { md: "Write `extensions/cinatra-ai/<slug>/package.json`.", paths: ["SKILL.md"] },
  // prose / non-file inline code that must NOT be flagged
  { md: "Call `message/send` then `tasks/get`.", paths: ["SKILL.md"] },
  { md: 'Set the zone to `"Europe/Vienna"` or `"America/Los_Angeles"`.', paths: ["SKILL.md"] },
  { md: "Fetch `{CINATRA_BASE_URL}/api/a2a/agents/{slug}`.", paths: ["SKILL.md"] },
  { md: "See [docs](https://example.com/a/b) and [anchor](#section).", paths: ["SKILL.md"] },
  { md: "Root [x](/abs/path.md) is not bundled-relative.", paths: ["SKILL.md"] },
  { md: "Escape attempt [x](../outside/thing.md).", paths: ["SKILL.md"] },
  { md: "Windows-ish [x](references\\guide.md).", paths: ["SKILL.md", "references/guide.md"] },
  { md: "Unterminated [x](references/guide.md", paths: ["SKILL.md"] },
  // an unterminated span EARLIER must not hide a later real reference
  { md: "Stray [x]( then later [refs](references/guide.md).", paths: ["SKILL.md"] },
  { md: "A stray ` backtick, then [refs](references/guide.md).", paths: ["SKILL.md"] },
  { md: "A stray ` backtick, then [refs](references/guide.md).", paths: ["SKILL.md", "references/guide.md"] },
  { md: "`Content-Type: text/event-stream`", paths: ["SKILL.md"] },
  { md: "", paths: ["SKILL.md"] },
];

describe("one-hop router lint", () => {
  it("flags a router that points at a file the bundle does not ship", () => {
    const r = lintRouterOneHopReferences("See [refs](references/guide.md).", ["SKILL.md"]);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["references/guide.md"]);
  });

  it("passes when the referenced file IS bundled", () => {
    expect(
      lintRouterOneHopReferences("See [refs](references/guide.md).", ["SKILL.md", "references/guide.md"]).ok,
    ).toBe(true);
  });

  it("does not mistake JSON-RPC methods, timezones or URL templates for bundled files", () => {
    const md = 'Call `message/send`; zone `"Europe/Vienna"`; url `{BASE}/api/a2a/x`.';
    expect(lintRouterOneHopReferences(md, ["SKILL.md"])).toEqual({ ok: true, missing: [] });
  });

  it("does not mistake an authoring skill's prose about ANOTHER tree for a bundled file", () => {
    // Real routers (the assistant authoring skills) name paths in the repo they
    // teach you to write. Those are not this bundle's files.
    const md =
      "Bump `packageVersion` in `cinatra/oas.json`; the executor lives in " +
      "`packages/agents/src/a2a-actions.ts`; scaffold " +
      "`extensions/cinatra-ai/<slug>/package.json`.";
    expect(lintRouterOneHopReferences(md, ["SKILL.md"])).toEqual({ ok: true, missing: [] });
  });

  it("STILL flags an inline-code reference under a directory the bundle DOES ship", () => {
    const r = lintRouterOneHopReferences("Read `references/gone.md`.", ["SKILL.md", "references/kept.md"]);
    expect(r).toEqual({ ok: false, missing: ["references/gone.md"] });
  });

  it("an UNTERMINATED code span earlier in the body no longer hides a later reference (fail-open guard)", () => {
    // Codex round: the pass used to `break` on an unterminated code span, so
    // everything after it was never scanned and the lint failed OPEN — harmless
    // as a diagnostic, wrong as enforcement. A single stray backtick is exactly
    // how that happens in real prose.
    expect(
      lintRouterOneHopReferences("A stray ` backtick, then [refs](references/guide.md).", ["SKILL.md"]),
    ).toEqual({ ok: false, missing: ["references/guide.md"] });
    // ...and the same body with the file present still passes.
    expect(
      lintRouterOneHopReferences("A stray ` backtick, then [refs](references/guide.md).", [
        "SKILL.md",
        "references/guide.md",
      ]),
    ).toEqual({ ok: true, missing: [] });
  });

  it("stays LINEAR on an adversarial body (no quadratic re-scan after an unterminated span)", () => {
    // 200k unmatched backticks + brackets: the guard must make each branch
    // search at most once, so this completes in well under a second.
    const md = "`[".repeat(100_000);
    const started = Date.now();
    expect(lintRouterOneHopReferences(md, ["SKILL.md"]).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("flags an EXPLICIT markdown link even when the bundle ships no such directory", () => {
    const r = lintRouterOneHopReferences("See [refs](references/guide.md).", ["SKILL.md"]);
    expect(r).toEqual({ ok: false, missing: ["references/guide.md"] });
  });

  it("AGREEMENT PIN: the .mjs verdict and the S1 TypeScript twin agree on every fixture", () => {
    for (const { md, paths } of LINT_MATRIX) {
      expect(lintRouterOneHopReferences(md, paths), `mjs vs ts for: ${md}`).toEqual(
        lintBundleRouterReferences(md, paths),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Bundle + package verdicts
// ---------------------------------------------------------------------------

describe("bundle verdict", () => {
  it("passes a conforming bundle", () => {
    expect(validateSkillBundle(bundleOf("my-skill"))).toEqual([]);
  });

  it("rejects a bundle directory whose name is not the frontmatter name", () => {
    const b = bundleOf("my-skill");
    b.dirName = "some-other-dir";
    expect(codes(validateSkillBundle(b))).toEqual(["bundle-name-mismatch"]);
  });

  it("rejects an over-long router", () => {
    const b = bundleOf("my-skill");
    b.routerText = router("my-skill", "line\n".repeat(SKILL_ROUTER_MAX_LINES + 10));
    expect(codes(validateSkillBundle(b))).toEqual(["router-too-long"]);
  });

  it("rejects a dangling one-hop reference (S1's diagnostic, now fail-closed)", () => {
    const b = bundleOf("my-skill");
    b.routerText = router("my-skill", "Read [more](references/missing.md).");
    expect(codes(validateSkillBundle(b))).toEqual(["dangling-reference"]);
  });

  it("rejects a bundle at or over the upload boundary", () => {
    const b = bundleOf("my-skill", [{ path: "big.bin", byteLength: SKILL_BUNDLE_MAX_BYTES }]);
    expect(codes(validateSkillBundle(b))).toEqual(["bundle-oversize"]);
  });
});

describe("skill extension package verdict", () => {
  const pkg = (overrides = {}) => ({
    packageName: "@cinatra-ai/my-skill",
    manifest: { kind: "skill" },
    bundles: [{ ...bundleOf("my-skill"), relDir: "skills/my-skill" }],
    ...overrides,
  });

  it("passes a conforming single-bundle `-skill` package", () => {
    expect(validateSkillExtensionPackage(pkg())).toEqual([]);
  });

  it("rejects the retired PLURAL suffix", () => {
    expect(codes(validateSkillExtensionPackage(pkg({ packageName: "@cinatra-ai/my-skills" })))).toEqual([
      "package-suffix",
    ]);
    expect(SKILL_PACKAGE_NAME_RE.test("@cinatra-ai/my-skill")).toBe(true);
    expect(SKILL_PACKAGE_NAME_RE.test("@cinatra-ai/my-skills")).toBe(false);
  });

  it("rejects TWO bundles and rejects ZERO bundles", () => {
    const two = pkg({
      bundles: [
        { ...bundleOf("a-skill"), relDir: "skills/a-skill" },
        { ...bundleOf("b-skill"), relDir: "skills/b-skill" },
      ],
    });
    expect(codes(validateSkillExtensionPackage(two))).toEqual(["not-exactly-one-bundle"]);
    expect(codes(validateSkillExtensionPackage(pkg({ bundles: [] })))).toEqual(["not-exactly-one-bundle"]);
  });

  it("rejects a SKILL.md outside the single bundle root", () => {
    expect(codes(validateSkillExtensionPackage(pkg({ straySkillMdPaths: ["docs/SKILL.md"] })))).toEqual([
      "stray-skill-md",
    ]);
  });

  it("rejects an unknown manifest skillRole and accepts each valid one", () => {
    expect(
      codes(validateSkillExtensionPackage(pkg({ manifest: { kind: "skill", skillRole: "wat" } }))),
    ).toEqual(["invalid-skill-role"]);
    for (const role of SKILL_ROLES) {
      expect(validateSkillExtensionPackage(pkg({ manifest: { kind: "skill", skillRole: role } }))).toEqual([]);
    }
  });
});

describe("non-skill extension package verdict", () => {
  it("rejects an embedded skill at ANY path", () => {
    const found = validateNonSkillExtensionPackage({
      packageName: "@cinatra-ai/some-agent",
      kind: "agent",
      skillMdPaths: ["skills/some-agent/SKILL.md", "deep/nested/anywhere/SKILL.md"],
      allowlist: [],
    });
    expect(codes(found)).toEqual(["skill-md-in-non-skill-package", "skill-md-in-non-skill-package"]);
  });

  it("exempts exactly the allowlisted fixture trees", () => {
    const found = validateNonSkillExtensionPackage({
      packageName: "@cinatra-ai/some-agent",
      kind: "agent",
      skillMdPaths: ["src/__tests__/fixtures/x/SKILL.md", "tests/fixtures/y/SKILL.md"],
      allowlist: ["**/__tests__/fixtures/**", "**/tests/fixtures/**"],
    });
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shared policy artifacts
// ---------------------------------------------------------------------------

describe("shared fixture-allowlist policy", () => {
  const policy = JSON.parse(
    readFileSync(join(REPO_ROOT, "config", "skill-fixture-allowlist.json"), "utf8"),
  );

  it("gives EXTENSION repos an empty allowlist (no exceptions)", () => {
    expect(resolveFixtureAllowlist(policy, "@cinatra-ai/any-extension")).toEqual([]);
  });

  it("gives the host and the scaffolder their documented defaults", () => {
    expect(resolveFixtureAllowlist(policy, "cinatra")).toEqual([
      "**/__tests__/fixtures/**",
      "**/tests/fixtures/**",
    ]);
    expect(resolveFixtureAllowlist(policy, "create-cinatra-extension")).toContain("templates/**");
  });

  it("matches the documented `**`/`*` grammar and nothing wider", () => {
    expect(matchesGlob("a/__tests__/fixtures/x/SKILL.md", "**/__tests__/fixtures/**")).toBe(true);
    expect(matchesGlob("__tests__/fixtures/x/SKILL.md", "**/__tests__/fixtures/**")).toBe(true);
    expect(matchesGlob("a/tests/other/x/SKILL.md", "**/tests/fixtures/**")).toBe(false);
    // `*` never crosses a segment boundary.
    expect(matchesGlob("a/b/SKILL.md", "a/*/SKILL.md")).toBe(true);
    expect(matchesGlob("a/b/c/SKILL.md", "a/*/SKILL.md")).toBe(false);
    expect(matchesAllowlist("x/SKILL.md", [])).toBe(false);
  });
});

describe("legacy exception ledger", () => {
  const ledger = JSON.parse(
    readFileSync(join(REPO_ROOT, "config", "skill-packaging-legacy-exceptions.json"), "utf8"),
  );

  it("the committed ledger is EMPTY — the cinatra#2090 migration completion proof", () => {
    // The ledger's own note declares an empty `exceptions` array THE proof the
    // S2/S3 packaging migration is complete. The last entry
    // (@cinatra-ai/assistant-skills) was deleted by the S3 consolidation fold;
    // a NEW entry needs an issue reference and a very good reason.
    expect(ledger.exceptions).toEqual([]);
  });

  it("waives ONLY the recorded (package, code) pairs (synthetic entry — the committed ledger is empty)", () => {
    const violations = [
      { code: "package-suffix", message: "m" },
      { code: "dangling-reference", message: "m" },
    ];
    const listed = applyLegacyExceptions(violations, {
      packageName: "@cinatra-ai/synthetic-legacy-skills",
      ledger: {
        ...ledger,
        exceptions: [
          {
            packageName: "@cinatra-ai/synthetic-legacy-skills",
            codes: ["package-suffix"],
            reason: "synthetic fixture — the committed ledger is empty",
            migratedBy: "cinatra#2090",
          },
        ],
      },
    });
    expect(codes(listed.waived)).toEqual(["package-suffix"]);
    expect(codes(listed.blocking)).toEqual(["dangling-reference"]);
  });

  it("waives NOTHING for a package that is not listed (fail closed for new packages)", () => {
    const unlisted = applyLegacyExceptions([{ code: "package-suffix", message: "m" }], {
      packageName: "@cinatra-ai/brand-new-skills",
      ledger,
    });
    expect(unlisted.waived).toEqual([]);
    expect(codes(unlisted.blocking)).toEqual(["package-suffix"]);
  });

  it("every entry names the issue that will delete it", () => {
    for (const e of ledger.exceptions) {
      expect(e.migratedBy, `${e.packageName} must name its migration issue`).toMatch(/^cinatra#\d+$/);
      expect(e.codes.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-authority agreement pins
// ---------------------------------------------------------------------------

describe("agreement pins", () => {
  it("the size boundary equals the S0 upload authority", () => {
    expect(SKILL_BUNDLE_MAX_BYTES).toBe(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES);
  });

  it("the role vocabulary equals the manifest contract", () => {
    expect([...SKILL_ROLES]).toEqual([...SKILL_EXTENSION_ROLES]);
  });

  it("the manifest role resolver defaults to injectable and honours the legacy internal flag", () => {
    expect(resolveSkillExtensionRole({ kind: "skill" })).toBe("injectable");
    expect(resolveSkillExtensionRole({ kind: "skill", internal: true })).toBe("internal");
    expect(resolveSkillExtensionRole({ kind: "skill", skillRole: "matcher" })).toBe("matcher");
    // an explicit role always wins over the legacy flag
    expect(resolveSkillExtensionRole({ kind: "skill", internal: true, skillRole: "injectable" })).toBe(
      "injectable",
    );
    expect(resolveSkillExtensionRole({ kind: "skill", skillRole: "nope" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The gate binary
// ---------------------------------------------------------------------------

describe("gate binary", () => {
  it("passes on the host's own in-package skills (the four core-shipped skills)", () => {
    const res = spawnSync("node", [join(REPO_ROOT, "scripts", "audit", "skill-packaging-gate.mjs")], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(res.stdout + res.stderr).toMatch(/host bundle\(s\)/);
    expect(res.status, res.stdout + res.stderr).toBe(0);
  });

  it("renders one canonical verdict text", () => {
    const text = formatViolations([{ code: "package-suffix", message: "bad name" }], "@x/y-skills");
    expect(text).toContain("skill-packaging verdict v");
    expect(text).toContain("[package-suffix] bad name");
  });
});

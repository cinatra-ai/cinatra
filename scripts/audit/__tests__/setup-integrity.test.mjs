import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import {
  checkSetupIntegrity,
  scanScriptForMissingPaths,
  listSetupScripts,
  runShellcheck,
} from "../setup-integrity.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const REAL_SETUP = join(REPO_ROOT, "scripts/setup.sh");
const BAD_FIXTURE = join(__dirname, "..", "__fixtures__", "setup-integrity-bad.sh");
const UNRELATED_GUARD_FIXTURE = join(__dirname, "..", "__fixtures__", "setup-integrity-unrelated-guard.sh");
const SHELLCHECK_LINT_FIXTURE = join(__dirname, "..", "__fixtures__", "setup-integrity-shellcheck-lint.sh");

// Is the shellcheck binary actually present in this environment? The
// shellcheck-enforcement test is skipped (it.skipIf) when it is absent so CI
// without shellcheck still passes; it RUNS wherever the binary exists.
const SHELLCHECK_AVAILABLE = runShellcheck(REAL_SETUP).ran;

describe("setup-integrity — discovery", () => {
  it("discovers the canonical scripts/setup.sh as a setup-family script", () => {
    const scripts = listSetupScripts(REPO_ROOT);
    expect(scripts).toContain(REAL_SETUP);
  });
  it("does NOT auto-discover the __fixtures__ bad script (it lives outside scripts/*.sh)", () => {
    expect(listSetupScripts(REPO_ROOT)).not.toContain(BAD_FIXTURE);
  });
});

describe("setup-integrity — the REAL scripts/setup.sh PASSES", () => {
  it("the working-tree scripts/setup.sh exists", () => {
    expect(existsSync(REAL_SETUP)).toBe(true);
  });
  it("reports zero bare missing in-tree path references", () => {
    // origin/main guards the OpenAI-shell build by globbing
    // `extensions/*/*/runtime/Dockerfile` and only building when one is found
    // (`if [ -n "$shell_runtime_context" ]`), so the `docker build` context is a
    // VARIABLE expansion, not a bare literal in-tree path → no violation.
    const result = checkSetupIntegrity({ repoRoot: REPO_ROOT, scripts: [REAL_SETUP] });
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
  });
  it("PASSES with shellcheck enabled — the real setup.sh is shellcheck-clean + guarded", () => {
    // setup.sh is both path-clean and shellcheck-clean on origin/main, so the
    // gate is green with shellcheck enforcement turned on.
    const withSc = checkSetupIntegrity({ repoRoot: REPO_ROOT, scripts: [REAL_SETUP], runShellcheck: true });
    const withoutSc = checkSetupIntegrity({ repoRoot: REPO_ROOT, scripts: [REAL_SETUP], runShellcheck: false });
    expect(withSc.ok).toBe(true);
    expect(withoutSc.ok).toBe(true);
    // No path violations and no shellcheck violations either way.
    expect(withSc.violations).toEqual(withoutSc.violations);
    expect(withSc.shellcheckViolations).toEqual([]);
  });
});

describe("setup-integrity — the bad fixture FAILS", () => {
  it("the bad fixture exists", () => {
    expect(existsSync(BAD_FIXTURE)).toBe(true);
  });
  it("flags the bare `docker build … <missing-in-tree-path>` under set -euo pipefail", () => {
    const result = checkSetupIntegrity({ repoRoot: REPO_ROOT, scripts: [BAD_FIXTURE] });
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    const docker = result.violations.find((v) => v.kind === "docker-build");
    expect(docker).toBeDefined();
    expect(docker.path).toBe("packages/connector-openai/runtime");
  });
  it("the referenced in-tree path genuinely does not exist (the missing-context-path regression this guards)", () => {
    expect(existsSync(join(REPO_ROOT, "packages/connector-openai/runtime"))).toBe(false);
  });
});

describe("setup-integrity — an UNRELATED, already-closed guard does NOT mask a bare build (no false-pass)", () => {
  it("the unrelated-guard fixture exists", () => {
    expect(existsSync(UNRELATED_GUARD_FIXTURE)).toBe(true);
  });
  it("flags the bare missing-path `docker build` even though an unrelated guard precedes it", () => {
    // A prior `if [ -f README.md ]; then … fi` is CLOSED before the build and
    // references a different path. The guard neither encloses the build nor
    // constrains its context, so the missing-path build must still be flagged —
    // a naive "any guard within N lines" scan would FALSELY pass this.
    const result = checkSetupIntegrity({ repoRoot: REPO_ROOT, scripts: [UNRELATED_GUARD_FIXTURE] });
    expect(result.ok).toBe(false);
    const docker = result.violations.find((v) => v.kind === "docker-build");
    expect(docker, JSON.stringify(result.violations, null, 2)).toBeDefined();
    expect(docker.path).toBe("packages/connector-openai/runtime");
  });
  it("a same-path enclosing guard still protects the build (no over-flagging)", () => {
    // The matching-guard form must remain unflagged: the
    // enclosing `if [ -d … ]` references the SAME path the build uses.
    const text = [
      "set -euo pipefail",
      "if [ -d packages/does-not-exist/runtime ]; then",
      "  docker build -t x packages/does-not-exist/runtime",
      "fi",
    ].join("\n");
    expect(scanScriptForMissingPaths(text, { scriptPath: "t.sh", repoRoot: REPO_ROOT })).toEqual([]);
  });
  it("an unrelated enclosing guard does NOT protect a bare build with a different path", () => {
    // The enclosing guard tests README.md but the build references a missing,
    // unrelated path — the guard must NOT count.
    const text = [
      "set -euo pipefail",
      "if [ -f README.md ]; then",
      "  docker build -t x packages/connector-openai/runtime",
      "fi",
    ].join("\n");
    const v = scanScriptForMissingPaths(text, { scriptPath: "t.sh", repoRoot: REPO_ROOT });
    expect(v.length).toBe(1);
    expect(v[0].kind).toBe("docker-build");
    expect(v[0].path).toBe("packages/connector-openai/runtime");
  });
});

describe("setup-integrity — guard + dynamic-context recognition", () => {
  it("does NOT flag a variable-expanded build context (the variable-repointed form)", () => {
    const text = [
      "set -euo pipefail",
      'shell_runtime_context=""',
      "for dockerfile in extensions/*/*/runtime/Dockerfile; do",
      '  if [ -f "$dockerfile" ]; then shell_runtime_context="$(dirname "$dockerfile")"; break; fi',
      "done",
      'if [ -n "$shell_runtime_context" ]; then',
      '  docker build -t cinatra/skill-shell:latest "$shell_runtime_context"',
      "fi",
    ].join("\n");
    expect(scanScriptForMissingPaths(text, { scriptPath: "t.sh", repoRoot: REPO_ROOT })).toEqual([]);
  });
  it("does NOT flag a literal context wrapped in an `if [ -d … ]` guard (the directory-guarded form)", () => {
    const text = [
      "set -euo pipefail",
      "if [ -d packages/does-not-exist/runtime ]; then",
      "  docker build -t x packages/does-not-exist/runtime",
      "fi",
    ].join("\n");
    expect(scanScriptForMissingPaths(text, { scriptPath: "t.sh", repoRoot: REPO_ROOT })).toEqual([]);
  });
  it("does NOT flag an external registry image or URL", () => {
    const text = [
      "set -euo pipefail",
      "docker pull registry.cinatra.ai/foo/bar:latest",
      "docker build -t x .",
    ].join("\n");
    // `.` (current dir) exists; the pull line is not a build. No violations.
    expect(scanScriptForMissingPaths(text, { scriptPath: "t.sh", repoRoot: REPO_ROOT })).toEqual([]);
  });
  it("flags a bare `source <missing-in-tree-path>`", () => {
    const text = ["set -euo pipefail", "source scripts/does-not-exist-helper.sh"].join("\n");
    const v = scanScriptForMissingPaths(text, { scriptPath: "t.sh", repoRoot: REPO_ROOT });
    expect(v.length).toBe(1);
    expect(v[0].kind).toBe("source");
    expect(v[0].path).toBe("scripts/does-not-exist-helper.sh");
  });
});

describe("setup-integrity — shellcheck backs the gate when present, degrades gracefully when absent", () => {
  it("runShellcheck reports ran:true with the real binary", () => {
    const r = runShellcheck(REAL_SETUP);
    expect(r.ran).toBe(true);
    expect(Array.isArray(r.lints)).toBe(true);
  });
  it("runShellcheck never throws and records ran:false when the binary is missing", () => {
    const r = runShellcheck(REAL_SETUP, { shellcheckBin: "shellcheck-definitely-not-installed-zzz" });
    expect(r.ran).toBe(false);
    expect(r.lints).toEqual([]);
    expect(typeof r.note).toBe("string");
  });
  it("an absent shellcheck binary never fails the gate (graceful skip)", () => {
    // runShellcheck:false models the binary being unavailable — the gate must
    // still PASS for a path-clean script.
    const result = checkSetupIntegrity({ repoRoot: REPO_ROOT, scripts: [REAL_SETUP], runShellcheck: false });
    expect(result.ok).toBe(true);
    expect(result.shellcheckViolations).toEqual([]);
    expect(result.scripts[0].shellcheck.ran).toBe(false);
  });

  it("the shellcheck-lint fixture exists", () => {
    expect(existsSync(SHELLCHECK_LINT_FIXTURE)).toBe(true);
  });

  // The enforcement proof: a script with a standard shellcheck lint (SC2086 —
  // an unquoted variable expansion) must FAIL the gate when shellcheck is
  // available. Skipped only when the binary is absent so CI without shellcheck
  // still passes; this env HAS shellcheck so it runs.
  it.skipIf(!SHELLCHECK_AVAILABLE)(
    "FAILS the gate on a fixture carrying a standard shellcheck lint (SC2086)",
    () => {
      const result = checkSetupIntegrity({ repoRoot: REPO_ROOT, scripts: [SHELLCHECK_LINT_FIXTURE], runShellcheck: true });
      expect(result.ok).toBe(false);
      expect(result.shellcheckViolations.length).toBeGreaterThanOrEqual(1);
      // The failure is shellcheck-driven, not a missing-path violation — the
      // fixture has no bare in-tree path reference.
      expect(result.violations).toEqual([]);
      const sv = result.shellcheckViolations.find((v) => v.script === SHELLCHECK_LINT_FIXTURE);
      expect(sv).toBeDefined();
      expect(sv.lints.join("\n")).toMatch(/SC2086/);
    },
  );

  it.skipIf(!SHELLCHECK_AVAILABLE)(
    "marks the lint fixture's per-script shellcheck result as failed (ran + failed)",
    () => {
      const r = runShellcheck(SHELLCHECK_LINT_FIXTURE);
      expect(r.ran).toBe(true);
      expect(r.failed).toBe(true);
      expect(r.lints.join("\n")).toMatch(/SC2086/);
    },
  );
});

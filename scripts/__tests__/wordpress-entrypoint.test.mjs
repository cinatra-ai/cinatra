// wordpress-entrypoint.sh — idempotent plugin-ensure contract tests.
//
// Why: #260 Step 6 moved the slow WordPress/abilities-api + WordPress/mcp-adapter
// clone+composer work to docker/wordpress/Dockerfile (baked at build time) so a
// FRESH dev container clears the uat-gate's ~5-min "core installed + cinatra
// plugin active" readiness window. The entrypoint's ensure_plugin() then becomes
// the FALLBACK for warm pre-bake volumes / stock images. Its correctness is the
// readiness contract: a COMPLETE plugin (baked, copied into the volume) must be
// LEFT ALONE — never re-cloned — even when `git describe` can't resolve the ref
// (the baked .git is owned by www-data, so root sees "dubious ownership"); an
// INCOMPLETE or WRONG-ref dir must be removed and re-cloned.
//
// These tests `source` the script (with main() neutered) and stub git/composer/
// chown to PATH so no network or docker is needed — they assert the SKIP vs
// RE-CLONE decision of ensure_plugin() across the four real-world states, plus
// the syntactic validity of the script (`bash -n`).

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const ENTRYPOINT = path.join(REPO_ROOT, "scripts", "wordpress-entrypoint.sh");

// A copy of the entrypoint with its trailing `main "$@"` invocation removed, so
// sourcing it defines the functions WITHOUT running main → exec docker-entrypoint.
const DEMAINED_BODY = readFileSync(ENTRYPOINT, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== 'main "$@"')
  .join("\n");

// Build a harness dir with stub `git`, `composer`, `chown` on PATH. Each stub
// records that it ran by appending to $CALLS_FILE, so a test can assert whether
// a clone/composer happened. `git config` / `git -C ... describe` are handled so
// ensure_plugin's ref logic runs; `git clone` records a CLONE call and creates a
// minimal complete dir so the subsequent composer/chown succeed.
function makeHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), "wp-entrypoint-test-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });

  // GIT_DESCRIBE controls what `git describe` reports (e.g. "pinned-ref" or
  // "unknown" to simulate the dubious-ownership/shallow case).
  const gitStub = `#!/usr/bin/env bash
case "$1" in
  config) exit 0 ;;
esac
# Find a "describe" anywhere in the args (we call: git -C <dir> describe ...).
for a in "$@"; do
  if [ "$a" = "describe" ]; then echo "\${GIT_DESCRIBE:-unknown}"; exit 0; fi
  if [ "$a" = "clone" ]; then
    echo "git clone" >> "$CALLS_FILE"
    target="\${@: -1}"
    mkdir -p "$target"
    touch "$target/\${CLONE_MAIN_FILE:-plugin.php}"
    mkdir -p "$target/vendor"; touch "$target/vendor/autoload.php"
    exit 0
  fi
done
exit 0
`;
  const composerStub = `#!/usr/bin/env bash
echo "composer $*" >> "$CALLS_FILE"
exit 0
`;
  const chownStub = `#!/usr/bin/env bash
exit 0
`;
  writeFileSync(path.join(bin, "git"), gitStub);
  writeFileSync(path.join(bin, "composer"), composerStub);
  writeFileSync(path.join(bin, "chown"), chownStub);
  for (const f of ["git", "composer", "chown"]) chmodSync(path.join(bin, f), 0o755);
  return { dir, bin };
}

// Run ensure_plugin against a prepared plugin dir and return the recorded calls.
// state: prepares $dir before the call. gitDescribe: value `git describe` echoes.
// pinnedRef: the ref ensure_plugin is asked to pin to. NOTE — refs here are
// deliberately NON-version tokens ("pinned-ref" / "stale-ref"); a literal
// `vX.Y.Z` would trip the source-leak SLG_MILESTONE_VERSION rule, and the logic
// under test only ever string-COMPARES current_ref to the pinned ref, so the
// exact value is irrelevant.
function runEnsurePlugin({ prepare, gitDescribe, needsVendor, pinnedRef = "pinned-ref" }) {
  const { dir, bin } = makeHarness();
  const pluginDir = path.join(dir, "plugin");
  const callsFile = path.join(dir, "calls.log");
  const demained = path.join(dir, "entrypoint.demained.sh");
  writeFileSync(callsFile, "");
  writeFileSync(demained, DEMAINED_BODY);
  prepare(pluginDir);

  // Source the de-mained entrypoint (functions only, no main), then invoke
  // ensure_plugin with controlled args. needsVendor toggles the vendor check.
  const script = `
    set -euo pipefail
    export PATH="${bin}:$PATH"
    export CALLS_FILE="${callsFile}"
    export GIT_DESCRIBE="${gitDescribe}"
    export CLONE_MAIN_FILE="plugin.php"
    source "${demained}"
    ensure_plugin "test-plugin" "${pluginDir}" \
      "https://example.invalid/repo.git" "${pinnedRef}" "plugin.php" "${needsVendor}"
  `;
  const res = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const calls = spawnSync("cat", [callsFile], { encoding: "utf8" }).stdout;
  rmSync(dir, { recursive: true, force: true });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls };
}

describe("wordpress-entrypoint.sh — script validity", () => {
  it("passes `bash -n` (no syntax errors)", () => {
    const res = spawnSync("bash", ["-n", ENTRYPOINT], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
  });
});

describe("ensure_plugin() — idempotent skip vs re-clone contract", () => {
  it("SKIPS a complete baked dir whose .git resolves the pinned ref (no clone)", () => {
    const r = runEnsurePlugin({
      gitDescribe: "pinned-ref",
      needsVendor: "1",
      prepare: (p) => {
        mkdirSync(path.join(p, ".git"), { recursive: true });
        writeFileSync(path.join(p, "plugin.php"), "<?php");
        mkdirSync(path.join(p, "vendor"), { recursive: true });
        writeFileSync(path.join(p, "vendor", "autoload.php"), "<?php");
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).not.toContain("git clone");
    expect(r.stdout).toContain("complete (ref=pinned-ref), skipping clone");
  });

  it("SKIPS a complete dir whose .git ref is unresolvable (dubious ownership / shallow)", () => {
    // The baked plugin's .git is owned by www-data; root's `git describe`
    // returns "unknown". Completeness alone must prove it is the pinned copy.
    const r = runEnsurePlugin({
      gitDescribe: "unknown",
      needsVendor: "1",
      prepare: (p) => {
        mkdirSync(path.join(p, ".git"), { recursive: true });
        writeFileSync(path.join(p, "plugin.php"), "<?php");
        mkdirSync(path.join(p, "vendor"), { recursive: true });
        writeFileSync(path.join(p, "vendor", "autoload.php"), "<?php");
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).not.toContain("git clone");
    expect(r.stdout).toContain("skipping clone");
  });

  it("SKIPS a complete dir that has NO .git (baked, .git stripped)", () => {
    const r = runEnsurePlugin({
      gitDescribe: "unused",
      needsVendor: "1",
      prepare: (p) => {
        mkdirSync(p, { recursive: true });
        writeFileSync(path.join(p, "plugin.php"), "<?php");
        mkdirSync(path.join(p, "vendor"), { recursive: true });
        writeFileSync(path.join(p, "vendor", "autoload.php"), "<?php");
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).not.toContain("git clone");
    expect(r.stdout).toContain("present (baked, complete), skipping clone");
  });

  it("RE-CLONES a dir present but INCOMPLETE (vendor/autoload.php missing)", () => {
    const r = runEnsurePlugin({
      gitDescribe: "pinned-ref",
      needsVendor: "1",
      prepare: (p) => {
        mkdirSync(path.join(p, ".git"), { recursive: true });
        writeFileSync(path.join(p, "plugin.php"), "<?php"); // main file present
        // vendor/autoload.php deliberately ABSENT → incomplete for needs_vendor=1
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain("git clone");
    expect(r.calls).toContain("composer");
  });

  it("RE-CLONES a .git dir whose ref is WRONG and resolvable (stale pin)", () => {
    const r = runEnsurePlugin({
      gitDescribe: "stale-ref", // resolvable but != the pinned ref
      needsVendor: "1",
      prepare: (p) => {
        mkdirSync(path.join(p, ".git"), { recursive: true });
        writeFileSync(path.join(p, "plugin.php"), "<?php");
        mkdirSync(path.join(p, "vendor"), { recursive: true });
        writeFileSync(path.join(p, "vendor", "autoload.php"), "<?php");
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain("git clone");
  });

  it("CLONES when the plugin dir is entirely absent (stock image / first fallback)", () => {
    const r = runEnsurePlugin({
      gitDescribe: "unused",
      needsVendor: "1",
      prepare: () => {
        /* leave $pluginDir absent */
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain("git clone");
    expect(r.calls).toContain("composer");
  });

  it("treats abilities-api (needs_vendor=0) as complete WITHOUT a vendor tree", () => {
    const r = runEnsurePlugin({
      gitDescribe: "pinned-ref",
      needsVendor: "0", // abilities-api loads bootstrap.php directly
      prepare: (p) => {
        mkdirSync(path.join(p, ".git"), { recursive: true });
        writeFileSync(path.join(p, "plugin.php"), "<?php");
        // no vendor/ — fine for needs_vendor=0
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).not.toContain("git clone");
    expect(r.stdout).toContain("skipping clone");
  });
});

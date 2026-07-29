// wordpress-entrypoint.sh — idempotent plugin-ensure + activation contract tests.
//
// Why: #260 Step 6 moved the slow WordPress/mcp-adapter fetch to
// docker/wordpress/Dockerfile (baked at build time) so a FRESH dev container
// clears the uat-gate's ~5-min "core installed + cinatra plugin active" readiness
// window. #2016 S1 pins the stack: WP 6.9 (core Abilities API — the separate
// abilities-api plugin is DROPPED), mcp-adapter + enable-abilities-for-mcp as
// pinned, sha256-checksummed release ZIPs. The entrypoint's ensure_plugin() is
// the FALLBACK for warm pre-bake volumes / stock images: a COMPLETE plugin dir
// (baked, copied into the volume) must be LEFT ALONE — never re-fetched — while
// an INCOMPLETE or absent dir is removed and re-fetched from the pinned ZIP
// (with a fail-closed sha256 check).
//
// These tests `source` the script (with main() neutered) and stub
// curl/sha256sum/unzip/composer/chown/wp to PATH so no network or docker is
// needed. They assert (1) the SKIP vs RE-FETCH decision of ensure_plugin()
// across the real-world states, (2) the bundlesVendor path (bundled ⇒ no
// composer install), (3) the deterministic activate_plugins order
// (mcp-adapter -> fixture-thirdparty-mcp -> enable-abilities-for-mcp -> cinatra),
// and (4) the syntactic validity of the script (`bash -n`).

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

// Build a harness dir with stub commands on PATH. Each stub records that it ran
// by appending to $CALLS_FILE so a test can assert whether a fetch/composer
// happened. `curl` creates its -o target; `unzip` extracts a single top-level
// dir (`pkg/`) with the main file (+ vendor when $MAKE_VENDOR=1) into its -d dir;
// `sha256sum` consumes stdin and passes (checksum correctness is verified for
// real at image-build time on runners); `wp` records `plugin activate <name>`.
function makeHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), "wp-entrypoint-test-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });

  const curlStub = `#!/usr/bin/env bash
echo "curl" >> "$CALLS_FILE"
prev=""
for a in "$@"; do
  case "$prev" in -*o) : > "$a" ;; esac
  prev="$a"
done
exit 0
`;
  const sha256Stub = `#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
echo "sha256sum" >> "$CALLS_FILE"
exit 0
`;
  const unzipStub = `#!/usr/bin/env bash
echo "unzip" >> "$CALLS_FILE"
dest=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-d" ]; then dest="$a"; fi
  prev="$a"
done
mkdir -p "$dest/pkg"
touch "$dest/pkg/\${CLONE_MAIN_FILE:-plugin.php}"
if [ "\${MAKE_VENDOR:-0}" = "1" ]; then mkdir -p "$dest/pkg/vendor"; touch "$dest/pkg/vendor/autoload.php"; fi
exit 0
`;
  const composerStub = `#!/usr/bin/env bash
echo "composer $*" >> "$CALLS_FILE"
exit 0
`;
  const chownStub = `#!/usr/bin/env bash
exit 0
`;
  const wpStub = `#!/usr/bin/env bash
args=("$@")
for i in "\${!args[@]}"; do
  if [ "\${args[$i]}" = "activate" ]; then
    name="\${args[$((i+1))]}"
    echo "plugin activate \${name}" >> "$CALLS_FILE"
    echo "Plugin '\${name}' activated."
  fi
done
exit 0
`;
  writeFileSync(path.join(bin, "curl"), curlStub);
  writeFileSync(path.join(bin, "sha256sum"), sha256Stub);
  writeFileSync(path.join(bin, "unzip"), unzipStub);
  writeFileSync(path.join(bin, "composer"), composerStub);
  writeFileSync(path.join(bin, "chown"), chownStub);
  writeFileSync(path.join(bin, "wp"), wpStub);
  for (const f of ["curl", "sha256sum", "unzip", "composer", "chown", "wp"]) {
    chmodSync(path.join(bin, f), 0o755);
  }
  return { dir, bin };
}

// Run ensure_plugin against a prepared plugin dir and return the recorded calls.
// state: prepares $dir before the call. needsVendor / bundlesVendor / makeVendor
// toggle the vendor logic + what the unzip stub extracts.
function runEnsurePlugin({ prepare, needsVendor, bundlesVendor, makeVendor = 0, mainFile = "plugin.php" }) {
  const { dir, bin } = makeHarness();
  const pluginDir = path.join(dir, "plugin");
  const callsFile = path.join(dir, "calls.log");
  const demained = path.join(dir, "entrypoint.demained.sh");
  writeFileSync(callsFile, "");
  writeFileSync(demained, DEMAINED_BODY);
  prepare(pluginDir);

  const script = `
    set -euo pipefail
    export PATH="${bin}:$PATH"
    export CALLS_FILE="${callsFile}"
    export CLONE_MAIN_FILE="${mainFile}"
    export MAKE_VENDOR="${makeVendor}"
    source "${demained}"
    ensure_plugin "test-plugin" "${pluginDir}" \
      "https://example.invalid/plugin.zip" "deadbeef" "${mainFile}" "${needsVendor}" "${bundlesVendor}"
  `;
  const res = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const calls = readFileSync(callsFile, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls };
}

describe("wordpress-entrypoint.sh — script validity", () => {
  it("passes `bash -n` (no syntax errors)", () => {
    const res = spawnSync("bash", ["-n", ENTRYPOINT], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
  });
});

describe("ensure_plugin() — idempotent skip vs re-fetch contract (checksummed ZIP)", () => {
  it("SKIPS a complete baked dir (main + vendor) — no fetch", () => {
    const r = runEnsurePlugin({
      needsVendor: "1",
      bundlesVendor: "1",
      prepare: (p) => {
        mkdirSync(p, { recursive: true });
        writeFileSync(path.join(p, "plugin.php"), "<?php");
        mkdirSync(path.join(p, "vendor"), { recursive: true });
        writeFileSync(path.join(p, "vendor", "autoload.php"), "<?php");
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).not.toContain("curl");
    expect(r.stdout).toContain("complete (baked/warm), skipping fetch");
  });

  it("SKIPS a complete needs_vendor=0 dir WITHOUT a vendor tree (eafm case)", () => {
    const r = runEnsurePlugin({
      needsVendor: "0", // enable-abilities-for-mcp ships built; no vendor needed
      bundlesVendor: "1",
      prepare: (p) => {
        mkdirSync(p, { recursive: true });
        writeFileSync(path.join(p, "plugin.php"), "<?php");
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).not.toContain("curl");
    expect(r.stdout).toContain("skipping fetch");
  });

  it("RE-FETCHES an incomplete dir (vendor missing) and, when bundled, runs NO composer", () => {
    const r = runEnsurePlugin({
      needsVendor: "1",
      bundlesVendor: "1", // ZIP ships vendor/ → no composer install
      makeVendor: 1, // the fetched ZIP contains vendor/autoload.php
      prepare: (p) => {
        mkdirSync(p, { recursive: true });
        writeFileSync(path.join(p, "plugin.php"), "<?php"); // main present
        // vendor/autoload.php deliberately ABSENT → incomplete for needs_vendor=1
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain("curl");
    expect(r.calls).toContain("sha256sum");
    expect(r.calls).not.toContain("composer");
  });

  it("RE-FETCHES + runs composer when the ZIP does NOT bundle vendor (bundlesVendor=0)", () => {
    const r = runEnsurePlugin({
      needsVendor: "1",
      bundlesVendor: "0", // ZIP lacks vendor/ → composer install required
      makeVendor: 0, // fetched ZIP has no vendor tree
      prepare: () => {
        /* leave $pluginDir absent */
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain("curl");
    expect(r.calls).toContain("composer");
  });

  it("FETCHES when the plugin dir is entirely absent (stock image / first fallback)", () => {
    const r = runEnsurePlugin({
      needsVendor: "1",
      bundlesVendor: "1",
      makeVendor: 1,
      prepare: () => {
        /* leave $pluginDir absent */
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain("curl");
    expect(r.calls).toContain("sha256sum");
    expect(r.calls).not.toContain("composer");
  });
});

describe("activate_plugins() — deterministic activation order", () => {
  it("activates mcp-adapter -> fixture-thirdparty-mcp -> scale-smoke-plugin -> enable-abilities-for-mcp -> cinatra", () => {
    const { dir, bin } = makeHarness();
    const callsFile = path.join(dir, "calls.log");
    const demained = path.join(dir, "entrypoint.demained.sh");
    writeFileSync(callsFile, "");
    writeFileSync(demained, DEMAINED_BODY);
    const script = `
      set -euo pipefail
      export PATH="${bin}:$PATH"
      export CALLS_FILE="${callsFile}"
      source "${demained}"
      WP_PATH=/tmp activate_plugins
    `;
    const res = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    const calls = readFileSync(callsFile, "utf8").trim().split("\n");
    rmSync(dir, { recursive: true, force: true });
    expect(res.status, res.stderr).toBe(0);
    expect(calls).toEqual([
      "plugin activate mcp-adapter",
      "plugin activate fixture-thirdparty-mcp",
      "plugin activate scale-smoke-plugin",
      "plugin activate enable-abilities-for-mcp",
      "plugin activate cinatra",
    ]);
  });
});

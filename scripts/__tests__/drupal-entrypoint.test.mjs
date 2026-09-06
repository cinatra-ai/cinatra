// drupal-entrypoint.sh — deterministic, idempotent module-install contract tests.
//
// Why: cinatra#3196. The UAT stack's Drupal bootstrap intermittently died in
// install_mcp_tools(). `drupal/mcp_tools` pulls `drupal/tool` and core's
// `update` module in as dependencies, so
// `drush en mcp_tools mcp_tools_remote mcp_tools_content -y` tries to install
// `update`; when `update.settings` is ALREADY sitting in active configuration
// while `update` itself is not enabled, Drupal's ConfigInstaller throws
//
//   In PreExistingConfigException.php line 65:
//     Configuration objects (update.settings) provided by update already exist
//     in active configuration
//
// and `set -e` aborts bootstrap() before activate_widget_module() ever runs —
// so the `cinatra` module is never enabled and the readiness poll times out
// with a bare "WordPress/Drupal not ready" on an unrelated pull request.
//
// The contract these tests pin (issue acceptance items 1 and 3):
//   1. `update` is enabled explicitly, idempotently and FIRST — before the
//      dependent mcp_tools enable — and a pre-existing `update.settings` is
//      reconciled (deleted, in a defined order) and the enable retried once,
//      rather than being allowed to abort the bootstrap. `set -e` stays on.
//   2. A failure that survives the reconcile is LOUD on the entrypoint's own
//      stdout: the underlying drush exception text plus an explicit
//      `[cinatra-drupal] ERROR:` line naming the command that failed, so the
//      job's own step log carries the cause instead of only an uploaded
//      compose-log artifact.
//
// Like the sibling wordpress-entrypoint test, these `source` the script (with
// main() neutered) and stub drush/composer on PATH, so no container, no
// database and no network are needed. Acceptance item 2 (ten consecutive fresh
// bring-ups) needs a container runtime and is a CI-runner-only check.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const ENTRYPOINT = path.join(REPO_ROOT, "scripts", "drupal-entrypoint.sh");

// A copy of the entrypoint with its trailing `main "$@"` invocation removed, so
// sourcing it defines the functions WITHOUT running main → exec apache2-foreground.
const DEMAINED_BODY = readFileSync(ENTRYPOINT, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== 'main "$@"')
  .join("\n");

// The verbatim shape of the failure recorded on the issue: drush prints the
// module list it is about to install, then the PHP exception, on stderr.
const PREEXISTING_CONFIG_STDERR = `In PreExistingConfigException.php line 65:

  Configuration objects (update.settings) provided by update already exist in
   active configuration
`;

// A stub drush backed by a tiny file-based site state:
//   $STATE_DIR/enabled                 — one enabled module name per line
//   $STATE_DIR/stray-update-settings   — present ⇔ update.settings sits in
//                                        active configuration with the `update`
//                                        module NOT enabled (the #3196 state)
// `drush en` throws the PreExistingConfigException whenever it would have to
// install `update` (directly, or transitively via mcp_tools) while that stray
// object exists — exactly the real ConfigInstaller behaviour.
// `drush config:delete update.settings` clears the stray object (and fails when
// $STUB_CONFIG_DELETE_FAILS=1, to exercise the unrecoverable path).
function makeHarness({ enabled = [], stray = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), "drupal-entrypoint-test-"));
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  const drupalPath = path.join(dir, "drupal");
  const webRoot = path.join(drupalPath, "web");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(
    path.join(state, "enabled"),
    enabled.length ? `${enabled.join("\n")}\n` : "",
  );
  if (stray) writeFileSync(path.join(state, "stray-update-settings"), "");

  const drushStub = `#!/usr/bin/env bash
args=()
for a in "$@"; do
  case "$a" in --root=*) ;; *) args+=("$a") ;; esac
done
echo "drush \${args[*]}" >> "$CALLS_FILE"

fail_preexisting() {
  cat >&2 <<'STUBEOF'
${PREEXISTING_CONFIG_STDERR}STUBEOF
  exit 1
}

case "\${args[0]:-}" in
  pm:list)
    cat "$STATE_DIR/enabled" 2>/dev/null || true
    exit 0
    ;;
  en)
    mods=()
    for m in "\${args[@]:1}"; do
      case "$m" in -y|--*) ;; *) mods+=("$m") ;; esac
    done
    for m in "\${mods[@]}"; do
      # core's \`update\` is a transitive dependency of mcp_tools, so enabling
      # either one installs it — and throws while its config pre-exists.
      if [ "$m" = "update" ] || [ "$m" = "mcp_tools" ]; then
        if [ -f "$STATE_DIR/stray-update-settings" ] \\
           && ! grep -qx update "$STATE_DIR/enabled" 2>/dev/null; then
          fail_preexisting
        fi
      fi
    done
    for m in "\${mods[@]}"; do
      echo "$m" >> "$STATE_DIR/enabled"
      if [ "$m" = "mcp_tools" ]; then
        echo "tool" >> "$STATE_DIR/enabled"
        echo "update" >> "$STATE_DIR/enabled"
      fi
    done
    exit 0
    ;;
  config:delete)
    if [ "\${STUB_CONFIG_DELETE_FAILS:-0}" = "1" ]; then
      echo "  [error] Could not delete \${args[1]:-}" >&2
      exit 1
    fi
    if [ "\${args[1]:-}" = "update.settings" ]; then
      rm -f "$STATE_DIR/stray-update-settings"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
  const composerStub = `#!/usr/bin/env bash
echo "composer $*" >> "$CALLS_FILE"
exit 0
`;
  writeFileSync(path.join(bin, "drush"), drushStub);
  writeFileSync(path.join(bin, "composer"), composerStub);
  for (const f of ["drush", "composer"]) chmodSync(path.join(bin, f), 0o755);

  return { dir, bin, state, drupalPath, webRoot };
}

// Run install_mcp_tools() against a prepared site state and return what the
// script did: its exit status, its own stdout/stderr, the recorded command
// calls, and the resulting enabled-module list.
function runInstallMcpTools({
  enabled = [],
  stray = false,
  filesPresent = false,
  configDeleteFails = false,
} = {}) {
  const h = makeHarness({ enabled, stray });
  const callsFile = path.join(h.dir, "calls.log");
  const demained = path.join(h.dir, "entrypoint.demained.sh");
  writeFileSync(callsFile, "");
  writeFileSync(demained, DEMAINED_BODY);
  if (filesPresent) {
    mkdirSync(path.join(h.webRoot, "modules", "contrib", "mcp_tools"), {
      recursive: true,
    });
    writeFileSync(
      path.join(h.webRoot, "modules", "contrib", "mcp_tools", "mcp_tools.module"),
      "<?php",
    );
  }

  const script = `
    set -euo pipefail
    export PATH="${h.bin}:$PATH"
    export CALLS_FILE="${callsFile}"
    export STATE_DIR="${h.state}"
    export STUB_CONFIG_DELETE_FAILS="${configDeleteFails ? 1 : 0}"
    source "${demained}"
    DRUPAL_PATH="${h.drupalPath}" WEB_ROOT="${h.webRoot}" install_mcp_tools
  `;
  const res = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const calls = readFileSync(callsFile, "utf8").trim();
  const enabledAfter = existsSync(path.join(h.state, "enabled"))
    ? readFileSync(path.join(h.state, "enabled"), "utf8").trim().split("\n")
    : [];
  const strayLeft = existsSync(path.join(h.state, "stray-update-settings"));
  rmSync(h.dir, { recursive: true, force: true });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    calls: calls ? calls.split("\n") : [],
    enabledAfter,
    strayLeft,
  };
}

const enCall = (line) => line.startsWith("drush en ");

describe("drupal-entrypoint.sh — script validity", () => {
  it("passes `bash -n` (no syntax errors)", () => {
    const res = spawnSync("bash", ["-n", ENTRYPOINT], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
  });

  it("keeps strict error handling (`set -euo pipefail`) — the fix never weakens it", () => {
    expect(readFileSync(ENTRYPOINT, "utf8")).toContain("set -euo pipefail");
  });
});

describe("install_mcp_tools() — deterministic module-install order (#3196 item 1)", () => {
  it("enables `update` explicitly BEFORE the dependent mcp_tools enable", () => {
    const r = runInstallMcpTools({ enabled: ["node", "system"] });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const ens = r.calls.filter(enCall);
    expect(ens).toEqual([
      "drush en update -y",
      "drush en mcp_tools mcp_tools_remote mcp_tools_content -y",
    ]);
  });

  it("is idempotent: an already-enabled `update` is not re-enabled", () => {
    const r = runInstallMcpTools({ enabled: ["node", "system", "update"] });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.calls.filter(enCall)).toEqual([
      "drush en mcp_tools mcp_tools_remote mcp_tools_content -y",
    ]);
  });

  it("does nothing at all when mcp_tools is already enabled and its files are present", () => {
    const r = runInstallMcpTools({
      enabled: ["node", "system", "update", "mcp_tools"],
      filesPresent: true,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.calls.filter(enCall)).toEqual([]);
    expect(r.stdout).toContain("mcp_tools already enabled");
  });
});

describe("install_mcp_tools() — survives a pre-existing update.settings (#3196 item 1)", () => {
  it("reconciles the stray configuration object and completes the install", () => {
    const r = runInstallMcpTools({ enabled: ["node", "system"], stray: true });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.calls.filter((l) => l.startsWith("drush config:delete"))).toEqual([
      "drush config:delete update.settings -y",
    ]);
    // `update` first (throws), the stray object deleted, `update` retried, then
    // the dependent modules — a defined, deterministic order.
    expect(r.calls.filter(enCall)).toEqual([
      "drush en update -y",
      "drush en update -y",
      "drush en mcp_tools mcp_tools_remote mcp_tools_content -y",
    ]);
    expect(r.strayLeft).toBe(false);
    expect(r.enabledAfter).toContain("update");
    expect(r.enabledAfter).toContain("mcp_tools");
  });

  it("prints the underlying exception on its own stdout while recovering", () => {
    const r = runInstallMcpTools({ enabled: ["node", "system"], stray: true });
    expect(r.stdout).toContain("PreExistingConfigException");
    expect(r.stdout).toContain("Configuration objects (update.settings)");
  });
});

describe("install_mcp_tools() — fails loudly on the entrypoint's own stdout (#3196 item 3)", () => {
  it("logs the drush exception AND a marked ERROR line when the failure survives the reconcile", () => {
    const r = runInstallMcpTools({
      enabled: ["node", "system"],
      stray: true,
      configDeleteFails: true,
    });
    // The bootstrap still fails — `set -e` is untouched — but the cause is now
    // in the entrypoint's OWN log stream, greppable next to its marker, rather
    // than only in a subprocess's stderr recoverable from an uploaded artifact.
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("PreExistingConfigException");
    expect(r.stdout).toContain("Configuration objects (update.settings)");
    expect(r.stdout).toContain("[cinatra-drupal] ERROR:");
    expect(r.stdout).toContain("drush en update");
  });
});

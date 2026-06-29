import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const SETUP_SH = join(REPO_ROOT, "scripts/setup.sh");
const SETUP_SRC = readFileSync(SETUP_SH, "utf8");

// cinatra#674 — the pre-wizard `cinatra dev setup dev` doctor self-check (e.g.
// "LLM MCP access — no public MCP URL", unsatisfiable on a clean local install)
// is ADVISORY: the CLI sets `process.exitCode = 1` AFTER printing the
// "Cinatra dev setup complete." marker, so a fresh `make setup` would otherwise
// abort under `set -euo pipefail` even though setup actually succeeded. The
// guard in setup.sh treats a non-zero `setup:dev` as a REAL failure only when
// the completion marker is ABSENT; with the marker present it warns + continues.

describe("cinatra#674 — setup.sh wraps `setup:dev` in a non-fatal advisory guard", () => {
  it("does NOT invoke `pnpm setup:dev` as a bare, unguarded line", () => {
    // A bare `pnpm setup:dev` on its own statement line (no pipe / capture)
    // under `set -euo pipefail` aborts make setup on any non-zero — including
    // the advisory post-boot exit. The guarded form pipes through `tee` and
    // reads ${PIPESTATUS[0]}, so a bare invocation would be the regression.
    const bare = SETUP_SRC.split("\n").some((line) =>
      /^\s*pnpm setup:dev\s*$/.test(line),
    );
    expect(bare, "found a bare unguarded `pnpm setup:dev` line").toBe(false);
  });

  it("captures setup:dev's exit code without `set -e` aborting (set +e / PIPESTATUS / set -e)", () => {
    expect(SETUP_SRC).toMatch(/set \+e[\s\S]*pnpm setup:dev[\s\S]*PIPESTATUS\[0\][\s\S]*set -e/);
  });

  it("discriminates on the EXACT completion marker (anchored grep) before failing loud", () => {
    // The success discriminator must match the CLI's actual marker text
    // ("Cinatra dev setup complete.") via an anchored `grep -qx`, and the error
    // path must still `error` out (fail loud) when the marker is absent.
    expect(SETUP_SRC).toMatch(/grep -qx 'Cinatra dev setup complete\.'/);
    expect(SETUP_SRC).toMatch(/error "Cinatra dev setup FAILED/);
  });

  it("treats a signal exit (>=128, e.g. Ctrl-C) as a real abort, not advisory", () => {
    expect(SETUP_SRC).toMatch(/SETUP_DEV_STATUS" -lt 128/);
  });
});

// ---------------------------------------------------------------------------
// Behavioral proof: extract the guard and run it against a STUBBED `pnpm` that
// reproduces each of the three real CLI outcomes, asserting the exit behavior.
// ---------------------------------------------------------------------------

// The exact guard block lives between the dev-setup `info` line and the closing
// `fi`. We re-run it inside a minimal harness so the test exercises the REAL
// shell logic (set +e / tee / PIPESTATUS / marker grep / error-vs-warn), not a
// paraphrase. `error()`/`warn()`/`info()` are stubbed; `error` exits 1 like the
// real script.
function extractGuard() {
  // Capture from the first `SETUP_DEV_LOG=$(mktemp …` line through the line that
  // resets the trap after the guard ("rm -f \"$SETUP_DEV_LOG\"; trap - EXIT").
  const start = SETUP_SRC.indexOf("SETUP_DEV_LOG=$(mktemp");
  expect(start, "guard start marker not found in setup.sh").toBeGreaterThan(-1);
  const tail = SETUP_SRC.indexOf('rm -f "$SETUP_DEV_LOG"; trap - EXIT', start + 1);
  // There are two such reset lines (error branch + happy tail); take the LAST.
  const lastReset = SETUP_SRC.lastIndexOf('rm -f "$SETUP_DEV_LOG"; trap - EXIT');
  expect(lastReset).toBeGreaterThanOrEqual(tail);
  const end = SETUP_SRC.indexOf("\n", lastReset) + 1;
  return SETUP_SRC.slice(start, end);
}

function runGuardWithStub({ stubStdout, stubExit }) {
  const dir = mkdtempSync(join(tmpdir(), "cinatra-674-"));
  try {
    // Stub `pnpm`: print the canned stdout (real newlines), then exit with the
    // canned code. The marker must land on its OWN line so `grep -qx` matches.
    const stub = join(dir, "pnpm");
    const heredoc = `cat <<'__STUB_EOF__'\n${stubStdout}\n__STUB_EOF__`;
    writeFileSync(stub, `#!/usr/bin/env bash\n${heredoc}\nexit ${stubExit}\n`);
    chmodSync(stub, 0o755);

    const guard = extractGuard();
    const harness = `#!/usr/bin/env bash
set -euo pipefail
info()  { echo "[+] $1"; }
warn()  { echo "[!] $1"; }
error() { echo "[x] $1"; exit 1; }
info "Running Cinatra dev setup..."
${guard}
echo "REACHED_SETUP_COMPLETE"
`;
    const harnessPath = join(dir, "harness.sh");
    writeFileSync(harnessPath, harness);

    const res = spawnSync("bash", [harnessPath], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("cinatra#674 — guard behavior (real shell, stubbed pnpm)", () => {
  it("exit 0: continues (setup reached completion cleanly)", () => {
    const res = runGuardWithStub({
      stubStdout: "Cinatra dev setup complete.",
      stubExit: 0,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("REACHED_SETUP_COMPLETE");
  });

  it("ADVISORY: exit 1 WITH the completion marker → warns and CONTINUES (does not abort)", () => {
    const res = runGuardWithStub({
      stubStdout:
        "Cinatra dev setup complete.\nLLM MCP access — no public MCP URL (advisory FAIL)",
      stubExit: 1,
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toMatch(/post-completion advisory check/);
    expect(res.stdout).toContain("REACHED_SETUP_COMPLETE");
  });

  it("REAL FAILURE: exit 1 WITHOUT the completion marker → fails loud (aborts)", () => {
    const res = runGuardWithStub({
      stubStdout: "Error: database connection refused (ECONNREFUSED)",
      stubExit: 1,
    });
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toMatch(/Cinatra dev setup FAILED/);
    expect(res.stdout).not.toContain("REACHED_SETUP_COMPLETE");
  });

  it("SIGNAL: exit 130 (Ctrl-C) WITH the marker still aborts (>=128 is never advisory)", () => {
    // A 128+signal exit must not be masked as advisory even if a marker happens
    // to have been printed before the interrupt.
    const res = runGuardWithStub({
      stubStdout: "Cinatra dev setup complete.",
      stubExit: 130,
    });
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toMatch(/Cinatra dev setup FAILED/);
    expect(res.stdout).not.toContain("REACHED_SETUP_COMPLETE");
  });

  it("does NOT misclassify a substring/non-anchored marker as completion", () => {
    // `grep -qx` requires the WHOLE line; a marker embedded in a larger line
    // (e.g. an error mentioning it) must NOT count as completion.
    const res = runGuardWithStub({
      stubStdout: "ERROR before Cinatra dev setup complete. could be printed",
      stubExit: 1,
    });
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toMatch(/Cinatra dev setup FAILED/);
  });
});

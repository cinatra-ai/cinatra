// dev-stop.mjs — DEVPERF-06 clean-lifecycle guard tests.
//
// Why: scripts/dev-stop.mjs is the worktree-scoped, SIGTERM-only dev-server
// shutdown. Its critical safety contract is the PORT-3000 refusal — the main
// checkout's dev server runs there, and a `pnpm dev:stop` accidentally
// triggered in the main repo (or by a careless contributor) MUST NOT take
// down the main server. The refusal is also the simplest behavioral test the
// script exposes (everything else requires forking a real process onto a port,
// which is too brittle for CI).
//
// Tests cover (a) the explicit refusal on port 3000 with a non-zero exit code
// and (b) the no-op exit when no listener and no .env.local resolve a port.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT_SRC = path.join(REPO_ROOT, "scripts", "dev-stop.mjs");

// dev-stop.mjs derives its REPO_ROOT from `import.meta.url` (always the
// script's parent's parent), so PORT precedence inside it is fixed to:
//   pidMeta.port  >  REPO_ROOT/.env.local PORT  >  process.env.PORT
// To test the PORT-3000 refusal contract deterministically (the real worktree
// .env.local has a non-3000 PORT and would short-circuit a process.env.PORT
// override) we COPY the script into a temp REPO_ROOT and seed the temp
// .env.local with PORT=3000. The script then resolves the temp REPO_ROOT for
// every probe — never touching the real repo or its dev server.
function withFakeRepoRoot(envLocalContent) {
  const root = mkdtempSync(path.join(tmpdir(), "devperf-devstop-"));
  const scripts = path.join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(SCRIPT_SRC, path.join(scripts, "dev-stop.mjs"));
  if (envLocalContent !== null) {
    writeFileSync(path.join(root, ".env.local"), envLocalContent);
  }
  return root;
}

describe("dev-stop.mjs — DEVPERF-06 PORT 3000 safety guard", () => {
  it("refuses with exit code 2 when the resolved PORT is 3000 and --allow-port-3000 is NOT passed", () => {
    const fakeRoot = withFakeRepoRoot("PORT=3000\n");
    try {
      const result = spawnSync("node", [path.join(fakeRoot, "scripts", "dev-stop.mjs")], {
        env: { ...process.env, PORT: "" },
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Exit code 2 is the contract: 0 = no-op success, 1 = fail-closed bound
      // port, 2 = main-checkout refusal, 3 = ownership-unverified. Assert 2.
      expect(
        result.status,
        `expected refusal exit=2, got=${result.status}; stderr: ${result.stderr}; stdout: ${result.stdout}`,
      ).toBe(2);
      expect(result.stderr || "").toMatch(/PORT 3000/);
      expect(result.stderr || "").toMatch(/--allow-port-3000/);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("with --allow-port-3000 the refusal guard does NOT fire (ownership verification still gates signaling)", () => {
    // With the override, the script proceeds past the refusal guard and into
    // candidate enumeration. Two acceptable outcomes (both prove the guard
    // disengaged AND no foreign process was signaled):
    //   exit 0: no listener on :3000 → "nothing to stop" path
    //   exit 3: a listener exists (e.g. the main checkout dev server) but no
    //           candidate pid ownership-verifies for the fake REPO_ROOT, so
    //           dev-stop refuses to signal foreign processes.
    // Exit 2 would mean the refusal guard fired anyway despite --allow-port-3000
    // — that's the regression we're gating against.
    const fakeRoot = withFakeRepoRoot("PORT=3000\n");
    try {
      const result = spawnSync(
        "node",
        [path.join(fakeRoot, "scripts", "dev-stop.mjs"), "--allow-port-3000"],
        { env: { ...process.env, PORT: "" }, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(
        [0, 3],
        `expected 0 (no listener) or 3 (foreign listener, ownership refused), got=${result.status}; stderr: ${result.stderr}`,
      ).toContain(result.status);
      // The PORT 3000 refusal message must NOT appear when override is active.
      expect(result.stderr || "").not.toMatch(/refusing to act on PORT 3000/);
      // When a listener exists and the script refuses on ownership grounds,
      // the message names the foreign-process refusal — that is the SIGTERM-
      // never-fires guarantee for an unrelated pid bound to the same port.
      if (result.status === 3) {
        expect(result.stderr).toMatch(/no pid is ownership-verified/);
      }
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("exits 0 (nothing to stop) when no PORT resolves anywhere", () => {
    // No .env.local, no PORT in process env, no pid-file. The script must
    // log "no PORT resolvable" and exit 0 — NEVER attempt to signal anything.
    const fakeRoot = withFakeRepoRoot(null);
    try {
      const result = spawnSync("node", [path.join(fakeRoot, "scripts", "dev-stop.mjs")], {
        env: { ...process.env, PORT: "" },
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(result.status, `expected no-op exit=0, got=${result.status}; stderr: ${result.stderr}`).toBe(0);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});

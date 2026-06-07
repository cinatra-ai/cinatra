// Hermetic vitest coverage for the clone-runtime helpers.
//
// Pure module under test. The tests mostly avoid touching real processes;
// only `isPidAlive` / `processCommandLineMatches` cases use a forked sleep.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  CLONE_NEXTJS_PORT_LIMIT,
  CLONE_WAYFLOW_PORT_LIMIT,
  acquireRuntimeLock,
  assertPortBandOk,
  cloneComposePath,
  cloneComposeProjectName,
  cloneLockPath,
  cloneLogPath,
  clonePidPath,
  cloneRuntimeDir,
  cloneTailscaleHostname,
  cloneTailscaleServePath,
  cloneTailscaleStateDir,
  ensureCloneRuntimeDir,
  isPidAlive,
  isRuntimeLockHeld,
  processCommandLineMatches,
  redactTailscaleAuthkey,
  releaseRuntimeLock,
  scrubTailscaleAuthkey,
  truncateCloneLog,
  validateTailscaleAuthkey,
} from "../src/clone-runtime.mjs";

import { CLONE_NEXTJS_PORT_BASE, CLONE_WAYFLOW_PORT_BASE } from "../src/clone-registry.mjs";

const tmpRoots = [];

function tmpHome() {
  const root = mkdtempSync(path.join(os.tmpdir(), "clone-runtime-test-"));
  tmpRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tmpRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// --- paths ----------------------------------------------------------------

describe("clone runtime paths", () => {
  it("derives runtime dir under HOME/.cinatra/clones/<slug>", () => {
    const home = tmpHome();
    expect(cloneRuntimeDir("my-slug", { home })).toBe(path.join(home, ".cinatra", "clones", "my-slug"));
  });

  it("throws for invalid slug", () => {
    const home = tmpHome();
    expect(() => cloneRuntimeDir("INVALID_UPPER", { home })).toThrow(/Invalid clone slug/);
  });

  it("derives pid / log / lock / compose paths under runtime dir", () => {
    const home = tmpHome();
    const dir = cloneRuntimeDir("clone-alpha", { home });
    expect(clonePidPath("clone-alpha", { home })).toBe(path.join(dir, "nextjs.pid"));
    expect(cloneLogPath("clone-alpha", { home })).toBe(path.join(dir, "nextjs.log"));
    expect(cloneLockPath("clone-alpha", { home })).toBe(path.join(dir, "clone.lock"));
    expect(cloneComposePath("clone-alpha", { home })).toBe(path.join(dir, "compose.yml"));
    expect(cloneTailscaleStateDir("clone-alpha", { home })).toBe(path.join(dir, "tailscale-state"));
    expect(cloneTailscaleServePath("clone-alpha", { home })).toBe(path.join(dir, "tailscale-serve.json"));
  });

  it("ensureCloneRuntimeDir creates dir idempotently", () => {
    const home = tmpHome();
    const a = ensureCloneRuntimeDir("clone-alpha", { home });
    const b = ensureCloneRuntimeDir("clone-alpha", { home });
    expect(a).toBe(b);
    expect(existsSync(a)).toBe(true);
  });
});

// --- naming ----------------------------------------------------------------

describe("cloneComposeProjectName", () => {
  it("composes slug + slot index", () => {
    expect(cloneComposeProjectName("clone-alpha", 5)).toBe("cinatra-clone-clone-alpha-5");
  });

  it("rejects invalid slot index", () => {
    expect(() => cloneComposeProjectName("ok", -1)).toThrow(/slot index/);
    expect(() => cloneComposeProjectName("ok", 100)).toThrow(/slot index/);
  });

  it("rejects invalid slug", () => {
    expect(() => cloneComposeProjectName("UPPER", 0)).toThrow(/Invalid clone slug/);
  });
});

describe("cloneTailscaleHostname", () => {
  it("includes slot index", () => {
    expect(cloneTailscaleHostname("clone-beta", 0)).toBe("cinatra-clone-beta-0");
  });
});

// --- process liveness -----------------------------------------------------

describe("isPidAlive", () => {
  it("returns false for an obviously-dead pid", () => {
    expect(isPidAlive(999_999_999)).toBe(false);
  });

  it("returns true for our own pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns true for a live but non-signalable pid (EPERM=alive)", () => {
    // pid 1 (init/launchd) always exists; a non-root user gets EPERM from
    // `process.kill(1, 0)`. The old code treated EVERY error as dead, so an
    // alive-but-EPERM clone pid bypassed every fail-closed prune guard. It
    // MUST read as alive. (Running as root → kill succeeds → also alive.)
    expect(isPidAlive(1)).toBe(true);
  });

  it("returns false for non-numeric / negative pids", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    // @ts-expect-error — runtime guard
    expect(isPidAlive("abc")).toBe(false);
    // @ts-expect-error — runtime guard
    expect(isPidAlive(null)).toBe(false);
  });
});

describe("processCommandLineMatches", () => {
  let child;

  beforeAll(() => {
    // Spawn a long-lived child whose command line contains a known marker.
    child = spawn("sleep", ["120"], { stdio: "ignore", detached: false });
  });

  afterAll(() => {
    if (child && child.pid && !child.killed) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // best-effort
      }
    }
  });

  it("returns alive=false for a dead pid", () => {
    const res = processCommandLineMatches(999_999_999);
    expect(res.alive).toBe(false);
  });

  it("returns ours=false for a non-dev process (sleep)", () => {
    const res = processCommandLineMatches(child.pid);
    expect(res.alive).toBe(true);
    expect(res.ours).toBe(false);
    expect(res.why).toMatch(/not a clone dev process/);
  });

  // Regression: `runCloneStart` records the `pnpm dev` WRAPPER pid (argv is
  // `node …/pnpm dev`, no bare "next"). The old code only matched "next",
  // so a healthy running clone read as ours=false → `clone stop` refused to
  // signal (leaked Next.js), `status` mislabelled, and prune's in-flight
  // guard could DROP a live DB. The match is now CLONE_DEV_PROC_RE-only.
  describe("recognises the spawned pnpm-dev wrapper", () => {
    let wrapper;
    beforeAll(() => {
      // `exec -a` rewrites argv[0] so `ps -o command=` reports the wrapper.
      wrapper = spawn("bash", ["-c", "exec -a 'node /usr/local/bin/pnpm dev' sleep 120"], {
        stdio: "ignore",
        detached: false,
      });
    });
    afterAll(() => {
      if (wrapper?.pid && !wrapper.killed) {
        try { process.kill(wrapper.pid, "SIGKILL"); } catch { /* best-effort */ }
      }
    });
    it("returns ours=true for the `node …/pnpm dev` wrapper", () => {
      const res = processCommandLineMatches(wrapper.pid);
      expect(res.alive).toBe(true);
      expect(res.ours).toBe(true);
    });
  });

  // Regression: a process whose command line merely CONTAINS the substring
  // "next" (e.g. a path like `…/nextcloud/…`) must
  // NOT be treated as a clone dev process. The old `mustContain: ["next"]`
  // substring fallback wrongly matched it.
  describe("rejects a substring-only 'next' match", () => {
    let nextish;
    beforeAll(() => {
      nextish = spawn("bash", ["-c", "exec -a 'node /opt/nextcloud/server.js' sleep 120"], {
        stdio: "ignore",
        detached: false,
      });
    });
    afterAll(() => {
      if (nextish?.pid && !nextish.killed) {
        try { process.kill(nextish.pid, "SIGKILL"); } catch { /* best-effort */ }
      }
    });
    it("returns ours=false for `…/nextcloud/server.js`", () => {
      const res = processCommandLineMatches(nextish.pid);
      expect(res.alive).toBe(true);
      expect(res.ours).toBe(false);
      expect(res.why).toMatch(/not a clone dev process/);
    });
  });

  // Regression: a same-worktree `next build` (not `next dev`) must NOT be
  // treated as the clone dev server, or `clone stop`
  // could signal an unrelated build via a reused pid file.
  describe("rejects bare `next <non-dev>` subcommands", () => {
    let nextBuild;
    beforeAll(() => {
      nextBuild = spawn("bash", ["-c", "exec -a 'node /repo/.bin/next build' sleep 120"], {
        stdio: "ignore",
        detached: false,
      });
    });
    afterAll(() => {
      if (nextBuild?.pid && !nextBuild.killed) {
        try { process.kill(nextBuild.pid, "SIGKILL"); } catch { /* best-effort */ }
      }
    });
    it("returns ours=false for `next build`", () => {
      const res = processCommandLineMatches(nextBuild.pid);
      expect(res.alive).toBe(true);
      expect(res.ours).toBe(false);
      expect(res.why).toMatch(/not a clone dev process/);
    });
  });

  // Regression: registry stores e.g. `/tmp/<wt>` but the process cwd resolves
  // to `/private/tmp/<wt>` on macOS. The old strict `cwd !== cwdMustEqual`
  // compare always failed; both sides must be symlink-canonicalised. The
  // process must also look like a clone dev process, so use the wrapper.
  it("canonicalises cwd on both sides of the comparison", () => {
    const realDir = mkdtempSync(path.join(os.tmpdir(), "clone-cwd-real-"));
    const linkDir = path.join(os.tmpdir(), `clone-cwd-link-${process.pid}-${Date.now()}`);
    symlinkSync(realDir, linkDir);
    const proc = spawn(
      "bash",
      ["-c", "exec -a 'node /usr/local/bin/pnpm dev' sleep 120"],
      { cwd: realDir, stdio: "ignore" },
    );
    try {
      // Process cwd resolves to realDir; assert against the SYMLINK path.
      const res = processCommandLineMatches(proc.pid, { cwdMustEqual: linkDir });
      expect(res.alive).toBe(true);
      expect(res.ours).toBe(true);
    } finally {
      if (proc?.pid && !proc.killed) {
        try { process.kill(proc.pid, "SIGKILL"); } catch { /* best-effort */ }
      }
      try { unlinkSync(linkDir); } catch { /* best-effort */ }
      try { rmSync(realDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

// --- runtime lock ---------------------------------------------------------

describe("runtime lock", () => {
  it("acquire creates the lock file; release removes it", () => {
    const home = tmpHome();
    acquireRuntimeLock("clone-alpha", { home });
    expect(isRuntimeLockHeld("clone-alpha", { home })).toBe(true);
    releaseRuntimeLock("clone-alpha", { home });
    expect(isRuntimeLockHeld("clone-alpha", { home })).toBe(false);
  });

  it("release is idempotent when lock already gone", () => {
    const home = tmpHome();
    expect(() => releaseRuntimeLock("clone-alpha", { home })).not.toThrow();
  });

  it("refuses to acquire when lock is held by a live pid", () => {
    const home = tmpHome();
    acquireRuntimeLock("clone-alpha", { home });
    try {
      expect(() => acquireRuntimeLock("clone-alpha", { home })).toThrow(/runtime lock held/);
    } finally {
      releaseRuntimeLock("clone-alpha", { home });
    }
  });

  it("auto-cleans a stale lock whose owner pid is dead", () => {
    const home = tmpHome();
    ensureCloneRuntimeDir("clone-alpha", { home });
    // Write a lock that claims a dead pid.
    writeFileSync(cloneLockPath("clone-alpha", { home }), "999999999\n2026-01-01T00:00:00.000Z\n");
    // The next acquire should succeed (it auto-cleans).
    acquireRuntimeLock("clone-alpha", { home });
    expect(isRuntimeLockHeld("clone-alpha", { home })).toBe(true);
    // Lock should now show the current pid.
    const contents = readFileSync(cloneLockPath("clone-alpha", { home }), "utf8");
    expect(contents).toContain(String(process.pid));
    releaseRuntimeLock("clone-alpha", { home });
  });
});

// --- port band -------------------------------------------------------------

describe("assertPortBandOk", () => {
  it("accepts the lowest nextjs port", () => {
    expect(() => assertPortBandOk(CLONE_NEXTJS_PORT_BASE, "nextjs")).not.toThrow();
  });

  it("accepts the highest nextjs port", () => {
    expect(() => assertPortBandOk(CLONE_NEXTJS_PORT_LIMIT, "nextjs")).not.toThrow();
  });

  it("rejects a port below the nextjs band", () => {
    expect(() => assertPortBandOk(CLONE_NEXTJS_PORT_BASE - 1, "nextjs")).toThrow(/outside band/);
  });

  it("rejects a port above the nextjs band", () => {
    expect(() => assertPortBandOk(CLONE_NEXTJS_PORT_LIMIT + 1, "nextjs")).toThrow(/outside band/);
  });

  it("accepts the lowest wayflow port", () => {
    expect(() => assertPortBandOk(CLONE_WAYFLOW_PORT_BASE, "wayflow")).not.toThrow();
  });

  it("rejects a port outside the wayflow band", () => {
    expect(() => assertPortBandOk(CLONE_WAYFLOW_PORT_BASE - 1, "wayflow")).toThrow(/outside band/);
    expect(() => assertPortBandOk(CLONE_WAYFLOW_PORT_LIMIT + 1, "wayflow")).toThrow(/outside band/);
  });

  it("throws on unknown port kind", () => {
    expect(() => assertPortBandOk(3100, "frobnicator")).toThrow(/unknown port kind/);
  });

  it("rejects non-numeric port", () => {
    // @ts-expect-error — runtime guard
    expect(() => assertPortBandOk("3100", "nextjs")).toThrow(/not a number/);
  });
});

// --- log truncation --------------------------------------------------------

describe("truncateCloneLog", () => {
  it("creates an empty log when missing", () => {
    const home = tmpHome();
    const logPath = truncateCloneLog("clone-alpha", { home });
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toBe("");
  });

  it("truncates an existing log", () => {
    const home = tmpHome();
    ensureCloneRuntimeDir("clone-alpha", { home });
    writeFileSync(cloneLogPath("clone-alpha", { home }), "previous run contents", { mode: 0o600 });
    truncateCloneLog("clone-alpha", { home });
    expect(readFileSync(cloneLogPath("clone-alpha", { home }), "utf8")).toBe("");
  });
});

// --- Tailscale authkey -----------------------------------------------------

describe("validateTailscaleAuthkey", () => {
  it("accepts a well-formed key", () => {
    expect(validateTailscaleAuthkey("tskey-auth-abc123_DEF-456")).toBe("tskey-auth-abc123_DEF-456");
  });

  it("rejects empty / non-string", () => {
    expect(() => validateTailscaleAuthkey("")).toThrow(/TS_AUTHKEY is required/);
    // @ts-expect-error — runtime guard
    expect(() => validateTailscaleAuthkey(null)).toThrow(/TS_AUTHKEY is required/);
    // @ts-expect-error — runtime guard
    expect(() => validateTailscaleAuthkey(123)).toThrow(/TS_AUTHKEY is required/);
  });

  it("rejects keys without the tskey-auth- prefix", () => {
    expect(() => validateTailscaleAuthkey("tskey-something-else")).toThrow(/format invalid/);
    expect(() => validateTailscaleAuthkey("abcdef")).toThrow(/format invalid/);
  });

  it("the rejection diagnostic contains the redacted form, not the raw key", () => {
    try {
      validateTailscaleAuthkey("tskey-something-completely-different-yet-secret");
      throw new Error("should have thrown");
    } catch (err) {
      const msg = String(err.message);
      expect(msg).not.toContain("tskey-something-completely-different-yet-secret");
      expect(msg).toMatch(/tskey-auth-…/);
    }
  });
});

describe("redactTailscaleAuthkey", () => {
  it("redacts a full key down to a marker + last 4 chars", () => {
    expect(redactTailscaleAuthkey("tskey-auth-abcdef-1234567890XYZW")).toBe("tskey-auth-…XYZW");
  });

  it("handles edge cases", () => {
    expect(redactTailscaleAuthkey("")).toBe("<empty>");
    // @ts-expect-error — runtime guard
    expect(redactTailscaleAuthkey(undefined)).toBe("<not-a-string>");
  });
});

describe("scrubTailscaleAuthkey", () => {
  it("replaces every occurrence of the key in arbitrary content", () => {
    const key = "tskey-auth-abcdef-1234567890XYZW";
    const text = `failed to start: TS_AUTHKEY=${key} not authorised\n${key} appears twice`;
    const cleaned = scrubTailscaleAuthkey(text, key);
    expect(cleaned).not.toContain(key);
    expect(cleaned).toContain("tskey-auth-…XYZW");
  });

  it("is a no-op for short / falsy keys", () => {
    expect(scrubTailscaleAuthkey("content", "")).toBe("content");
    expect(scrubTailscaleAuthkey("content", "ab")).toBe("content");
    expect(scrubTailscaleAuthkey("", "tskey-auth-xyz12345")).toBe("");
  });
});

// ===========================================================================
// Argv-helper coverage for security-sensitive CLI parsing.
// ===========================================================================

import {
  findPositionalSlug,
  rejectTailscaleAuthkeyFlag,
} from "../src/clone-runtime.mjs";

describe("rejectTailscaleAuthkeyFlag", () => {
  it("rejects --tailscale-authkey space form", () => {
    expect(() =>
      rejectTailscaleAuthkeyFlag(["--tailscale-authkey", "tskey-auth-secret"]),
    ).toThrow(/TS_AUTHKEY via env/);
  });

  it("rejects --tailscale-authkey= equals form", () => {
    expect(() =>
      rejectTailscaleAuthkeyFlag(["--tailscale-authkey=tskey-auth-secret"]),
    ).toThrow(/TS_AUTHKEY via env/);
  });

  it("rejects equals form even when value is empty", () => {
    expect(() => rejectTailscaleAuthkeyFlag(["--tailscale-authkey="])).toThrow();
  });

  it("does not reject other flags", () => {
    expect(() =>
      rejectTailscaleAuthkeyFlag(["--slug", "x", "--worktree-path", "/tmp/wt"]),
    ).not.toThrow();
  });

  it("is a no-op for non-array input", () => {
    expect(() => rejectTailscaleAuthkeyFlag(null)).not.toThrow();
    expect(() => rejectTailscaleAuthkeyFlag(undefined)).not.toThrow();
  });

  it("the error message does NOT contain the raw key", () => {
    try {
      rejectTailscaleAuthkeyFlag(["--tailscale-authkey", "tskey-auth-very-secret-value"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err.message).not.toContain("tskey-auth-very-secret-value");
      expect(err.message).toMatch(/TS_AUTHKEY via env/);
    }
    // Equals form too.
    try {
      rejectTailscaleAuthkeyFlag(["--tailscale-authkey=tskey-auth-very-secret-value"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err.message).not.toContain("tskey-auth-very-secret-value");
    }
  });
});

describe("findPositionalSlug", () => {
  it("returns null when no positional present", () => {
    expect(findPositionalSlug(["--slug", "x"])).toBe(null);
  });

  it("returns a bare slug", () => {
    expect(findPositionalSlug(["my-slug"])).toBe("my-slug");
  });

  it("skips the value of --worktree-path so /tmp/wt is NOT the slug", () => {
    expect(findPositionalSlug(["--worktree-path", "/tmp/wt"])).toBe(null);
  });

  it("skips the value of --slug too", () => {
    expect(findPositionalSlug(["--slug", "explicit-slug", "positional-slug"])).toBe(
      "positional-slug",
    );
  });

  it("skips the value of --source-env", () => {
    expect(findPositionalSlug(["--source-env", "/tmp/.env.local"])).toBe(null);
  });

  it("rejects positional tokens that don't match the slug regex", () => {
    expect(findPositionalSlug(["/tmp/wt"])).toBe(null);
    expect(findPositionalSlug(["UPPER-CASE"])).toBe(null);
    expect(findPositionalSlug(["x".repeat(40)])).toBe(null);
  });

  it("returns first valid slug among multiple positionals", () => {
    expect(findPositionalSlug(["alpha", "beta"])).toBe("alpha");
  });

  it("handles non-array input gracefully", () => {
    expect(findPositionalSlug(null)).toBe(null);
    expect(findPositionalSlug(undefined)).toBe(null);
  });
});

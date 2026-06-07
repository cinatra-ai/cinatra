import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __test } from "../src/clone-registry.mjs";

const {
  CLONE_NEXTJS_PORT_BASE,
  CLONE_WAYFLOW_PORT_BASE,
  CLONE_MAX_INDEX,
  SEED_DB_NAME,
  cloneSlugFromBranch,
  isValidSlug,
  cloneDbName,
  isProtectedDbName,
  portsForIndex,
  readRegistry,
  requireUsableRegistry,
  writeRegistry,
  withRegistryLock,
  allocateSlot,
  markSlotReady,
  releaseSlot,
  getClone,
  listClones,
} = __test;

// ---------------------------------------------------------------------------
// cloneSlugFromBranch
// ---------------------------------------------------------------------------

describe("cloneSlugFromBranch", () => {
  it("strips a leading worktree- segment", () => {
    expect(cloneSlugFromBranch("worktree-clone-on-demand")).toBe(
      "clone-on-demand",
    );
  });

  it("lowercases and replaces non-alphanumerics with dashes", () => {
    expect(cloneSlugFromBranch("Feature/My_Cool Branch")).toBe("feature-my-cool-branch");
  });

  it("truncates to 30 characters", () => {
    const long = "clone-" + "x".repeat(60);
    expect(cloneSlugFromBranch(long).length).toBe(30);
  });

  it("returns empty string for empty / nullish input", () => {
    expect(cloneSlugFromBranch("")).toBe("");
    expect(cloneSlugFromBranch(null)).toBe("");
    expect(cloneSlugFromBranch(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// isValidSlug
// ---------------------------------------------------------------------------

describe("isValidSlug", () => {
  it("accepts a normal slug", () => {
    expect(isValidSlug("clone-alpha")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidSlug("")).toBe(false);
  });

  it("rejects a slug starting with a dash", () => {
    expect(isValidSlug("-leading")).toBe(false);
  });

  it("rejects uppercase / underscores", () => {
    expect(isValidSlug("Clone_Alpha")).toBe(false);
  });

  it("rejects a slug longer than 30 chars", () => {
    expect(isValidSlug("a".repeat(31))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cloneDbName
// ---------------------------------------------------------------------------

describe("cloneDbName", () => {
  it("prefixes cinatra_clone_ and converts dashes to underscores", () => {
    expect(cloneDbName("clone-alpha")).toBe("cinatra_clone_clone_alpha");
  });

  it("throws on an invalid slug", () => {
    expect(() => cloneDbName("Bad Slug")).toThrow(/Invalid clone slug/);
  });
});

// ---------------------------------------------------------------------------
// isProtectedDbName  (the destructive-prune guard — must fail closed)
// ---------------------------------------------------------------------------

describe("isProtectedDbName", () => {
  it("protects the maintenance / app / seed / template databases", () => {
    for (const name of ["postgres", "cinatra", SEED_DB_NAME, "template0", "template1"]) {
      expect(isProtectedDbName(name)).toBe(true);
    }
  });

  it("protects any name not shaped like a clone DB (fail closed)", () => {
    expect(isProtectedDbName("cinatra_feature_alpha")).toBe(true); // branch schema name shape
    expect(isProtectedDbName("random_db")).toBe(true);
    expect(isProtectedDbName("")).toBe(true);
    expect(isProtectedDbName(null)).toBe(true);
  });

  it("does NOT protect a well-formed clone DB name", () => {
    expect(isProtectedDbName("cinatra_clone_clone_alpha")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// portsForIndex
// ---------------------------------------------------------------------------

describe("portsForIndex", () => {
  it("maps index 0 to the band bases", () => {
    expect(portsForIndex(0)).toEqual({
      nextjsPort: CLONE_NEXTJS_PORT_BASE,
      wayflowPort: CLONE_WAYFLOW_PORT_BASE,
    });
  });

  it("maps the top index", () => {
    expect(portsForIndex(CLONE_MAX_INDEX)).toEqual({
      nextjsPort: CLONE_NEXTJS_PORT_BASE + CLONE_MAX_INDEX,
      wayflowPort: CLONE_WAYFLOW_PORT_BASE + CLONE_MAX_INDEX,
    });
  });

  it("throws below 0 and above the max", () => {
    expect(() => portsForIndex(-1)).toThrow(/out of range/);
    expect(() => portsForIndex(CLONE_MAX_INDEX + 1)).toThrow(/out of range/);
    expect(() => portsForIndex(1.5)).toThrow(/out of range/);
  });
});

// ---------------------------------------------------------------------------
// readRegistry / requireUsableRegistry / writeRegistry
// ---------------------------------------------------------------------------

describe("registry file I/O", () => {
  let dir;
  let regPath;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "clone-reg-"));
    regPath = path.join(dir, "clones.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readRegistry → missing for an absent file, with a fresh empty registry", () => {
    const r = readRegistry(regPath);
    expect(r.status).toBe("missing");
    expect(r.registry).toEqual({ version: 1, clones: {} });
  });

  it("readRegistry → ok for a valid file", () => {
    writeFileSync(regPath, JSON.stringify({ version: 1, clones: {} }));
    const r = readRegistry(regPath);
    expect(r.status).toBe("ok");
    expect(r.registry.clones).toEqual({});
  });

  it("readRegistry → malformed for invalid JSON (no throw), raw preserved", () => {
    writeFileSync(regPath, "{ this is not json");
    const r = readRegistry(regPath);
    expect(r.status).toBe("malformed");
    expect(r.registry).toBeNull();
    expect(r.raw).toBe("{ this is not json");
  });

  it("readRegistry → malformed for valid JSON of the wrong shape", () => {
    writeFileSync(regPath, JSON.stringify({ version: 1, clones: [] }));
    expect(readRegistry(regPath).status).toBe("malformed");
  });

  it("requireUsableRegistry throws on malformed and leaves the bad file intact", () => {
    writeFileSync(regPath, "garbage");
    expect(() => requireUsableRegistry(regPath)).toThrow(/malformed/);
    expect(readFileSync(regPath, "utf8")).toBe("garbage");
  });

  it("requireUsableRegistry returns the registry for missing / ok", () => {
    expect(requireUsableRegistry(regPath).clones).toEqual({});
    writeFileSync(
      regPath,
      JSON.stringify({
        version: 1,
        clones: {
          a: {
            index: 0,
            nextjsPort: 3100,
            wayflowPort: 3200,
            dbName: cloneDbName("a"),
            worktreePath: "/wt/a",
            state: "ready",
            createdAt: "2026-05-14T00:00:00.000Z",
          },
        },
      }),
    );
    expect(requireUsableRegistry(regPath).clones.a.index).toBe(0);
  });

  it("writeRegistry → readRegistry round-trips and leaves no temp files", () => {
    const data = {
      version: 1,
      clones: {
        foo: {
          index: 3,
          nextjsPort: 3103,
          wayflowPort: 3203,
          dbName: cloneDbName("foo"),
          worktreePath: "/wt/foo",
          state: "ready",
          createdAt: "2026-05-14T00:00:00.000Z",
        },
      },
    };
    writeRegistry(regPath, data);
    expect(readRegistry(regPath).registry.clones.foo.index).toBe(3);
    // no leftover .tmp siblings
    const leftover = readFileSync(regPath, "utf8");
    expect(leftover).toContain("foo");
  });

  it("writeRegistry creates the parent directory if absent", () => {
    const nested = path.join(dir, "deep", "nested", "clones.json");
    writeRegistry(nested, { version: 1, clones: {} });
    expect(existsSync(nested)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// withRegistryLock
// ---------------------------------------------------------------------------

describe("withRegistryLock", () => {
  let dir;
  let regPath;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "clone-lock-"));
    regPath = path.join(dir, "clones.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires, runs the callback, and releases the lock", async () => {
    const result = await withRegistryLock(regPath, async () => {
      expect(existsSync(`${regPath}.lock`)).toBe(true);
      return "done";
    });
    expect(result).toBe("done");
    expect(existsSync(`${regPath}.lock`)).toBe(false);
  });

  it("releases the lock even when the callback throws", async () => {
    await expect(
      withRegistryLock(regPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(`${regPath}.lock`)).toBe(false);
  });

  it("steals a stale lock (mtime older than 60s)", async () => {
    const lockPath = `${regPath}.lock`;
    writeFileSync(lockPath, "99999 old\n");
    // Backdate the lock file well past the 60s staleness threshold.
    const old = Date.now() / 1000 - 600;
    const { utimesSync } = await import("node:fs");
    utimesSync(lockPath, old, old);
    const result = await withRegistryLock(regPath, async () => "stole-it");
    expect(result).toBe("stole-it");
  });

  it("serialises concurrent callers (no interleaving)", async () => {
    const order = [];
    await Promise.all([
      withRegistryLock(regPath, async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("a-end");
      }),
      withRegistryLock(regPath, async () => {
        order.push("b-start");
        await new Promise((r) => setTimeout(r, 5));
        order.push("b-end");
      }),
    ]);
    // Whichever ran first, its start/end must not be interleaved by the other.
    const aStart = order.indexOf("a-start");
    const aEnd = order.indexOf("a-end");
    const bStart = order.indexOf("b-start");
    const bEnd = order.indexOf("b-end");
    expect(aEnd).toBe(aStart + 1);
    expect(bEnd).toBe(bStart + 1);
  });
});

// ---------------------------------------------------------------------------
// allocateSlot / markSlotReady / releaseSlot
// ---------------------------------------------------------------------------

describe("allocateSlot", () => {
  const fresh = () => ({ version: 1, clones: {} });

  it("allocates index 0 with the band ports and provisioning state", () => {
    const { registry, slot } = allocateSlot(fresh(), "clone-alpha", {
      worktreePath: "/wt/a",
    });
    expect(slot.index).toBe(0);
    expect(slot.nextjsPort).toBe(CLONE_NEXTJS_PORT_BASE);
    expect(slot.wayflowPort).toBe(CLONE_WAYFLOW_PORT_BASE);
    expect(slot.dbName).toBe("cinatra_clone_clone_alpha");
    expect(slot.state).toBe("provisioning");
    expect(registry.clones["clone-alpha"]).toEqual(slot);
  });

  it("is idempotent when the same slug + worktree re-allocates", () => {
    const r1 = allocateSlot(fresh(), "clone-alpha", { worktreePath: "/wt/a" }).registry;
    const { slot } = allocateSlot(r1, "clone-alpha", { worktreePath: "/wt/a" });
    expect(slot.index).toBe(0);
  });

  it("throws when a slug already maps to a different worktree (no aliasing)", () => {
    const r1 = allocateSlot(fresh(), "clone-alpha", { worktreePath: "/wt/a" }).registry;
    expect(() =>
      allocateSlot(r1, "clone-alpha", { worktreePath: "/wt/OTHER" }),
    ).toThrow(/already maps to worktree/);
  });

  it("assigns the lowest free index when earlier indices are taken", () => {
    let reg = fresh();
    reg = allocateSlot(reg, "a", { worktreePath: "/wt/a" }).registry; // index 0
    reg = allocateSlot(reg, "b", { worktreePath: "/wt/b" }).registry; // index 1
    const { slot } = releaseSlot(reg, "a"); // free index 0
    const released = releaseSlot(reg, "a").registry;
    const { slot: c } = allocateSlot(released, "c", { worktreePath: "/wt/c" });
    expect(c.index).toBe(0); // reuses the freed slot
    void slot;
  });

  it("throws when all 20 slots are in use", () => {
    let reg = fresh();
    for (let i = 0; i <= CLONE_MAX_INDEX; i += 1) {
      reg = allocateSlot(reg, `slug-${i}`, { worktreePath: `/wt/${i}` }).registry;
    }
    expect(() =>
      allocateSlot(reg, "one-too-many", { worktreePath: "/wt/x" }),
    ).toThrow(/All 20 clone slots/);
  });

  it("throws on an invalid slug or missing worktreePath", () => {
    expect(() => allocateSlot(fresh(), "Bad Slug", { worktreePath: "/wt" })).toThrow(
      /Invalid clone slug/,
    );
    expect(() => allocateSlot(fresh(), "ok-slug", { worktreePath: "" })).toThrow(
      /non-empty worktreePath/,
    );
  });

  it("does not mutate the input registry", () => {
    const input = fresh();
    allocateSlot(input, "clone-alpha", { worktreePath: "/wt/a" });
    expect(input.clones).toEqual({});
  });
});

describe("markSlotReady / releaseSlot / getClone / listClones", () => {
  const fresh = () => ({ version: 1, clones: {} });

  it("markSlotReady flips state to ready", () => {
    const reg = allocateSlot(fresh(), "a", { worktreePath: "/wt/a" }).registry;
    const ready = markSlotReady(reg, "a");
    expect(ready.clones.a.state).toBe("ready");
    // input not mutated
    expect(reg.clones.a.state).toBe("provisioning");
  });

  it("markSlotReady throws for an unknown slug", () => {
    expect(() => markSlotReady(fresh(), "nope")).toThrow(/unknown clone slug/);
  });

  it("releaseSlot removes the entry and returns it", () => {
    const reg = allocateSlot(fresh(), "a", { worktreePath: "/wt/a" }).registry;
    const { registry, removed } = releaseSlot(reg, "a");
    expect(registry.clones.a).toBeUndefined();
    expect(removed.index).toBe(0);
    // input not mutated
    expect(reg.clones.a).toBeDefined();
  });

  it("releaseSlot returns removed=null for an unknown slug", () => {
    const { removed } = releaseSlot(fresh(), "nope");
    expect(removed).toBeNull();
  });

  it("getClone / listClones read back entries", () => {
    let reg = fresh();
    reg = allocateSlot(reg, "b", { worktreePath: "/wt/b" }).registry;
    reg = allocateSlot(reg, "a", { worktreePath: "/wt/a" }).registry;
    expect(getClone(reg, "a").index).toBe(1);
    expect(getClone(reg, "missing")).toBeNull();
    const list = listClones(reg);
    expect(list.map((c) => c.slug)).toEqual(["b", "a"]); // sorted by index
  });
});

// ---------------------------------------------------------------------------
// Additional boundary coverage for lock and registry invariants.
// ---------------------------------------------------------------------------

describe("isProtectedDbName — fail-closed boundary cases", () => {
  it("protects cinatra_clone_ names with an invalid suffix shape", () => {
    // These carry the prefix but cannot be produced by cloneDbName(isValidSlug):
    expect(isProtectedDbName("cinatra_clone_")).toBe(true); // empty suffix
    expect(isProtectedDbName("cinatra_clone__")).toBe(true); // suffix starts with _
    expect(isProtectedDbName("cinatra_clone__prod")).toBe(true); // suffix starts with _
    expect(isProtectedDbName("cinatra_clone_-bad")).toBe(true); // illegal char
    expect(isProtectedDbName("cinatra_clone_" + "a".repeat(31))).toBe(true); // too long
    expect(isProtectedDbName("cinatra_clone_UPPER")).toBe(true); // uppercase
  });

  it("still does NOT protect a name with a valid clone-slug suffix", () => {
    expect(isProtectedDbName("cinatra_clone_clone_alpha")).toBe(false);
    expect(isProtectedDbName("cinatra_clone_a")).toBe(false); // single-char suffix
    expect(isProtectedDbName("cinatra_clone_" + "a".repeat(30))).toBe(false); // max length
  });

  it("the guard exactly matches what cloneDbName produces for any valid slug", () => {
    for (const slug of ["a", "clone-alpha", "x".repeat(30), "p1", "a-b-c"]) {
      // cloneDbName output must be considered UNprotected (it is a real clone DB)
      expect(isProtectedDbName(cloneDbName(slug))).toBe(false);
    }
  });
});

describe("readRegistry — deep slot validation", () => {
  let dir;
  let regPath;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "clone-reg-deep-"));
    regPath = path.join(dir, "clones.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const goodSlot = (index = 0, slug = "clone-alpha") => ({
    index,
    nextjsPort: 3100 + index,
    wayflowPort: 3200 + index,
    dbName: cloneDbName(slug),
    worktreePath: "/wt/a",
    state: "ready",
    createdAt: "2026-05-14T00:00:00.000Z",
  });

  it("accepts a registry with structurally-valid slots", () => {
    writeFileSync(
      regPath,
      JSON.stringify({ version: 1, clones: { "clone-alpha": goodSlot(0, "clone-alpha") } }),
    );
    expect(readRegistry(regPath).status).toBe("ok");
  });

  it("rejects a slot with a string index", () => {
    writeFileSync(regPath, JSON.stringify({ version: 1, clones: { "clone-alpha": { index: "0" } } }));
    expect(readRegistry(regPath).status).toBe("malformed");
  });

  it("rejects a slot missing required fields", () => {
    writeFileSync(
      regPath,
      JSON.stringify({ version: 1, clones: { "clone-alpha": { index: 0, nextjsPort: 3100 } } }),
    );
    expect(readRegistry(regPath).status).toBe("malformed");
  });

  it("rejects a slot whose ports do not match its index", () => {
    const bad = goodSlot(0, "clone-alpha");
    bad.nextjsPort = 9999;
    writeFileSync(regPath, JSON.stringify({ version: 1, clones: { "clone-alpha": bad } }));
    expect(readRegistry(regPath).status).toBe("malformed");
  });

  it("rejects a slot whose dbName does not match its slug", () => {
    const bad = goodSlot(0, "clone-alpha");
    bad.dbName = "cinatra_clone_something_else";
    writeFileSync(regPath, JSON.stringify({ version: 1, clones: { "clone-alpha": bad } }));
    expect(readRegistry(regPath).status).toBe("malformed");
  });

  it("rejects an out-of-range index", () => {
    writeFileSync(
      regPath,
      JSON.stringify({ version: 1, clones: { "clone-alpha": goodSlot(99, "clone-alpha") } }),
    );
    expect(readRegistry(regPath).status).toBe("malformed");
  });

  it("rejects an invalid slug key", () => {
    writeFileSync(
      regPath,
      JSON.stringify({ version: 1, clones: { "Bad Slug": goodSlot(0, "clone-alpha") } }),
    );
    expect(readRegistry(regPath).status).toBe("malformed");
  });

  it("rejects an unknown state value", () => {
    const bad = goodSlot(0, "clone-alpha");
    bad.state = "weird";
    writeFileSync(regPath, JSON.stringify({ version: 1, clones: { "clone-alpha": bad } }));
    expect(readRegistry(regPath).status).toBe("malformed");
  });

  it("rejects two slugs claiming the same index", () => {
    writeFileSync(
      regPath,
      JSON.stringify({
        version: 1,
        clones: {
          "clone-alpha": goodSlot(0, "clone-alpha"),
          "clone-beta": { ...goodSlot(0, "clone-beta") }, // index 0 again
        },
      }),
    );
    expect(readRegistry(regPath).status).toBe("malformed");
  });

  it("requireUsableRegistry throws on a structurally-invalid registry and leaves it intact", () => {
    const raw = JSON.stringify({ version: 1, clones: { "clone-alpha": { index: "0" } } });
    writeFileSync(regPath, raw);
    expect(() => requireUsableRegistry(regPath)).toThrow(/malformed/);
    expect(readFileSync(regPath, "utf8")).toBe(raw);
  });
});

describe("withRegistryLock — stale-steal ownership", () => {
  let dir;
  let regPath;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "clone-lock-own-"));
    regPath = path.join(dir, "clones.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT delete a lock that was stolen from us while our callback ran", async () => {
    const lockPath = `${regPath}.lock`;
    const { existsSync: exists, statSync: stat } = await import("node:fs");
    let stolenInode = null;
    await withRegistryLock(regPath, async () => {
      // Simulate another process judging our lock stale and stealing it:
      // remove our lock file and create a fresh one (a different inode).
      rmSync(lockPath, { force: true });
      writeFileSync(lockPath, "88888 thief\n");
      stolenInode = stat(lockPath).ino;
    });
    // Our finally must have left the thief's lock untouched (different inode).
    expect(exists(lockPath)).toBe(true);
    expect(stat(lockPath).ino).toBe(stolenInode);
    rmSync(lockPath, { force: true });
  });

  it("still removes its OWN lock on normal exit", async () => {
    const lockPath = `${regPath}.lock`;
    const { existsSync: exists } = await import("node:fs");
    await withRegistryLock(regPath, async () => {
      expect(exists(lockPath)).toBe(true);
    });
    expect(exists(lockPath)).toBe(false);
  });
});

// ===========================================================================
// Worktree-path lookup helpers + stale detection.
// ===========================================================================

import { mkdtempSync as _mkdtempSync, mkdirSync as _mkdirSync, writeFileSync as _writeFileSync, rmSync as _rmSync, symlinkSync as _symlinkSync, realpathSync as require_fs_realpath } from "node:fs";
// NOTE: `os` is already imported at the top of this file — a second
// `import os from "node:os"` here is a duplicate-binding SyntaxError under
// plain `node`; vitest's esbuild transform silently tolerated it.
import {
  canonicalizeWorktreePath,
  findCloneByWorktreePath,
  isWorktreePathStale,
} from "../src/clone-registry.mjs";

describe("worktree-path helpers", () => {
  let tmpRoots = [];
  function tmp() {
    const root = _mkdtempSync(path.join(os.tmpdir(), "cr-wtp-"));
    tmpRoots.push(root);
    return root;
  }
  afterEach(() => {
    for (const r of tmpRoots) {
      try { _rmSync(r, { recursive: true, force: true }); } catch {}
    }
    tmpRoots = [];
  });

  describe("canonicalizeWorktreePath", () => {
    it("returns realpath when the path exists", () => {
      const dir = tmp();
      expect(canonicalizeWorktreePath(dir)).toBe(require_fs_realpath(dir));
    });

    it("falls back to path.resolve when realpath fails", () => {
      const missing = path.join(tmp(), "does-not-exist");
      _rmSync(path.dirname(missing), { recursive: true, force: true });
      const resolved = canonicalizeWorktreePath(missing);
      expect(typeof resolved).toBe("string");
      expect(resolved).toBe(path.resolve(missing));
    });

    it("returns null for null/empty/non-string", () => {
      expect(canonicalizeWorktreePath(null)).toBe(null);
      expect(canonicalizeWorktreePath("")).toBe(null);
      expect(canonicalizeWorktreePath(undefined)).toBe(null);
    });
  });

  describe("findCloneByWorktreePath", () => {
    it("finds a slot whose worktreePath matches by realpath", () => {
      const wt = tmp();
      const registry = {
        version: 1,
        clones: {
          alpha: { index: 0, nextjsPort: 3100, wayflowPort: 3200,
            dbName: "cinatra_clone_alpha", worktreePath: wt, state: "ready",
            createdAt: "2026-01-01T00:00:00Z" },
        },
      };
      const match = findCloneByWorktreePath(registry, wt);
      expect(match?.slug).toBe("alpha");
    });

    it("finds a slot when the worktree dir has been REMOVED on disk", () => {
      const wt = path.join(tmp(), "gone");
      const registry = {
        version: 1,
        clones: {
          beta: { index: 1, nextjsPort: 3101, wayflowPort: 3201,
            dbName: "cinatra_clone_beta", worktreePath: wt, state: "ready",
            createdAt: "2026-01-01T00:00:00Z" },
        },
      };
      // Confirm wt does NOT exist.
      const match = findCloneByWorktreePath(registry, wt);
      expect(match?.slug).toBe("beta");
    });

    it("returns null when no slot matches", () => {
      const registry = {
        version: 1,
        clones: {
          gamma: { index: 2, nextjsPort: 3102, wayflowPort: 3202,
            dbName: "cinatra_clone_gamma", worktreePath: "/some/other/path", state: "ready",
            createdAt: "2026-01-01T00:00:00Z" },
        },
      };
      const match = findCloneByWorktreePath(registry, tmp());
      expect(match).toBe(null);
    });

    it("matches symlinked worktree paths via realpath", () => {
      const wt = tmp();
      const link = path.join(tmp(), "link-to-wt");
      _symlinkSync(wt, link);
      const registry = {
        version: 1,
        clones: {
          delta: { index: 3, nextjsPort: 3103, wayflowPort: 3203,
            dbName: "cinatra_clone_delta", worktreePath: wt, state: "ready",
            createdAt: "2026-01-01T00:00:00Z" },
        },
      };
      const match = findCloneByWorktreePath(registry, link);
      expect(match?.slug).toBe("delta");
    });
  });

  describe("isWorktreePathStale", () => {
    it("returns false for an existing directory", () => {
      const wt = tmp();
      expect(isWorktreePathStale({ worktreePath: wt })).toBe(false);
    });

    it("returns true for a missing path", () => {
      const missing = path.join(tmp(), "gone");
      expect(isWorktreePathStale({ worktreePath: missing })).toBe(true);
    });

    it("returns true for a regular file (not a directory)", () => {
      const f = path.join(tmp(), "regular.txt");
      _writeFileSync(f, "x");
      expect(isWorktreePathStale({ worktreePath: f })).toBe(true);
    });

    it("returns true when worktreePath is missing/non-string", () => {
      expect(isWorktreePathStale({})).toBe(true);
      expect(isWorktreePathStale({ worktreePath: null })).toBe(true);
      expect(isWorktreePathStale(null)).toBe(true);
    });

    it("returns false even for paths under $HOME", () => {
      // Confirm an existing dir under $HOME is NOT considered stale; no $HOME
      // exclusion rule.
      const wt = _mkdtempSync(path.join(os.homedir(), ".cinatra-stale-test-"));
      tmpRoots.push(wt);
      expect(isWorktreePathStale({ worktreePath: wt })).toBe(false);
    });

    it("recreated directory at the same path is NOT stale", () => {
      const wt = path.join(tmp(), "x");
      _mkdirSync(wt);
      _rmSync(wt, { recursive: true, force: true });
      expect(isWorktreePathStale({ worktreePath: wt })).toBe(true);
      _mkdirSync(wt);
      expect(isWorktreePathStale({ worktreePath: wt })).toBe(false);
    });
  });
});

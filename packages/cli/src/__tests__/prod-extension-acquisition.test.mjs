import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as tar from "tar";

// Targeted fs fault injection: everything passes through to the real node:fs
// except renameSync, which throws ONCE when renaming onto the path armed via
// `renameControl.failTo` — used to prove the acquisition swap restores the
// previously verified tree when the final rename into place fails.
const renameControl = vi.hoisted(() => ({ failTo: null }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal();
  const renameSync = (from, to) => {
    if (renameControl.failTo !== null && to === renameControl.failTo) {
      renameControl.failTo = null;
      throw new Error("injected rename failure");
    }
    return real.renameSync(from, to);
  };
  return { ...real, renameSync, default: { ...real, renameSync } };
});

import {
  ACQUISITION_MARKER_FILENAME,
  LOCK_FILENAME,
  MAX_DECOMPRESSED_BYTES,
  acquireProdRequiredExtensions,
  classifyEntryPath,
  computeTreeSha256FromDir,
  foldTreeHash,
  gunzipBounded,
  inspectTarball,
  readRequiredExtensionsLock,
} from "../prod-extension-acquisition.mjs";

const tmpDirs = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function scratch(prefix = "acq-test-") {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const SHA_A = "a".repeat(40);
const TREE_A = "b".repeat(64);

function lockDoc(overrides = {}) {
  return {
    schemaVersion: 1,
    packages: [
      {
        packageName: "@scope/sample-connector",
        repo: "scope-org/sample-connector",
        resolvedSha: SHA_A,
        packageVersion: "0.1.0",
        treeSha256: TREE_A,
        ...overrides,
      },
    ],
  };
}

function writeLock(dir, doc) {
  const p = path.join(dir, LOCK_FILENAME);
  writeFileSync(p, JSON.stringify(doc, null, 2));
  return p;
}

// --- synthesized archives -----------------------------------------------

/** Build a gzip'd tar buffer from explicit entries via tar.Pack (lets us
 * synthesize entry types codeload would never legitimately produce). */
function packArchive(entries) {
  const pack = new tar.Pack({ gzip: false });
  const chunks = [];
  pack.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => pack.on("end", resolve));
  for (const e of entries) {
    const body = e.body ?? "";
    const header = new tar.Header({
      path: e.path,
      mode: e.mode ?? (e.type === "Directory" ? 0o755 : 0o644),
      type: e.type ?? "File",
      size: e.type === "File" || e.type === undefined ? Buffer.byteLength(body) : 0,
      linkpath: e.linkpath,
      mtime: new Date(0),
      uid: 0,
      gid: 0,
    });
    header.encode();
    const entry = new tar.ReadEntry(header);
    pack.add(entry);
    if (header.size > 0) entry.write(Buffer.from(body));
    entry.end();
  }
  pack.end();
  return done.then(() => gzipSync(Buffer.concat(chunks)));
}

/** A well-formed single-root archive like codeload produces. */
function goodArchive({ root = `sample-connector-${SHA_A}`, name = "@scope/sample-connector", version = "0.1.0", extra = [] } = {}) {
  return packArchive([
    { path: `${root}/`, type: "Directory" },
    { path: `${root}/package.json`, body: JSON.stringify({ name, version }) },
    { path: `${root}/index.ts`, body: "export const x = 1;\n" },
    ...extra,
  ]);
}

async function inspect(gzBuffer) {
  const tarBuffer = await gunzipBounded(gzBuffer);
  return inspectTarball(tarBuffer, { tar });
}

// --- lock validation ------------------------------------------------------

describe("readRequiredExtensionsLock", () => {
  it("accepts a well-formed lock", () => {
    const dir = scratch();
    const p = writeLock(dir, lockDoc());
    const lock = readRequiredExtensionsLock(p);
    expect(lock.packages).toHaveLength(1);
  });

  it("throws when the lock is missing", () => {
    expect(() => readRequiredExtensionsLock(path.join(scratch(), LOCK_FILENAME))).toThrow(/lockfile not found/);
  });

  it.each([
    ["packageName", "Not-A-Name", /packageName/],
    ["packageName", "@scope/../escape", /packageName/],
    ["repo", "no-slash", /repo/],
    ["repo", "a/../b", /repo/],
    ["resolvedSha", "main", /resolvedSha/],
    ["resolvedSha", "A".repeat(40), /resolvedSha/],
    ["packageVersion", "latest", /packageVersion/],
    ["treeSha256", "zz", /treeSha256/],
  ])("rejects a bad %s (%s)", (field, value, re) => {
    const dir = scratch();
    const p = writeLock(dir, lockDoc({ [field]: value }));
    expect(() => readRequiredExtensionsLock(p)).toThrow(re);
  });

  it("rejects duplicates and empty package lists", () => {
    const dir = scratch();
    const doc = lockDoc();
    doc.packages.push({ ...doc.packages[0] });
    expect(() => readRequiredExtensionsLock(writeLock(dir, doc))).toThrow(/duplicate/);
    const dir2 = scratch();
    expect(() => readRequiredExtensionsLock(writeLock(dir2, { schemaVersion: 1, packages: [] }))).toThrow(
      /no "packages"/,
    );
  });
});

// --- path hardening rules ---------------------------------------------------

describe("classifyEntryPath", () => {
  it("strips the single archive root", () => {
    expect(classifyEntryPath("root-abc/package.json")).toEqual({ stripped: "package.json" });
    expect(classifyEntryPath("./root-abc/a/b.ts")).toEqual({ stripped: "a/b.ts" });
    expect(classifyEntryPath("root-abc/")).toEqual({ stripped: "" });
  });
  it("rejects absolute paths, traversal, and drive-letter paths", () => {
    expect(classifyEntryPath("/etc/passwd").violation).toMatch(/absolute/);
    expect(classifyEntryPath("root/../../escape").violation).toMatch(/traversal/);
    expect(classifyEntryPath("C:\\windows\\system32").violation).toMatch(/absolute/);
  });
});

// --- archive inspection -------------------------------------------------

describe("inspectTarball hardening", () => {
  it("accepts a well-formed codeload-shaped archive", async () => {
    const { records, packageJsonRaw, violations } = await inspect(await goodArchive());
    expect(violations).toEqual([]);
    expect(records.map((r) => r.relPath).sort()).toEqual(["index.ts", "package.json"]);
    expect(JSON.parse(packageJsonRaw).name).toBe("@scope/sample-connector");
  });

  it("rejects symlink entries", async () => {
    const gz = await goodArchive({
      extra: [{ path: `sample-connector-${SHA_A}/evil-link`, type: "SymbolicLink", linkpath: "/etc/passwd" }],
    });
    const { violations } = await inspect(gz);
    expect(violations.some((v) => v.includes("forbidden entry type") && v.includes("SymbolicLink"))).toBe(true);
  });

  it("rejects hardlink entries", async () => {
    const gz = await goodArchive({
      extra: [{ path: `sample-connector-${SHA_A}/evil-hard`, type: "Link", linkpath: "package.json" }],
    });
    const { violations } = await inspect(gz);
    expect(violations.some((v) => v.includes("forbidden entry type") && v.includes("Link"))).toBe(true);
  });

  it("rejects FIFO/device entries", async () => {
    const gz = await goodArchive({
      extra: [{ path: `sample-connector-${SHA_A}/evil-fifo`, type: "FIFO" }],
    });
    const { violations } = await inspect(gz);
    expect(violations.some((v) => v.includes("forbidden entry type"))).toBe(true);
  });

  it("rejects path traversal entries", async () => {
    const gz = await goodArchive({
      extra: [{ path: `sample-connector-${SHA_A}/../escape.txt`, body: "boom" }],
    });
    const { violations } = await inspect(gz);
    expect(violations.some((v) => v.includes("traversal"))).toBe(true);
  });

  it("rejects a smuggled acquisition marker", async () => {
    const gz = await goodArchive({
      extra: [{ path: `sample-connector-${SHA_A}/${ACQUISITION_MARKER_FILENAME}`, body: "{}" }],
    });
    const { violations } = await inspect(gz);
    expect(violations.some((v) => v.includes("reserved acquisition-marker"))).toBe(true);
  });

  it("rejects a non-directory entry at the archive root", async () => {
    const gz = await packArchive([{ path: "rogue-root-file", body: "x" }]);
    const { violations } = await inspect(gz);
    expect(violations.some((v) => v.includes("archive root"))).toBe(true);
  });

  it("rejects setuid/setgid/sticky mode bits on files and directories", async () => {
    for (const extra of [
      { path: `sample-connector-${SHA_A}/sneaky`, body: "x", mode: 0o4755 },
      { path: `sample-connector-${SHA_A}/sneaky2`, body: "x", mode: 0o2644 },
      { path: `sample-connector-${SHA_A}/sneaky3`, body: "x", mode: 0o1644 },
      { path: `sample-connector-${SHA_A}/odd-dir/`, type: "Directory", mode: 0o2775 },
    ]) {
      const gz = await goodArchive({ extra: [extra] });
      const { violations } = await inspect(gz);
      expect(
        violations.some((v) => v.includes("special mode bits")),
        `mode ${(extra.mode).toString(8)} must be rejected`,
      ).toBe(true);
    }
  });

  it("accepts umask-noisy modes (codeload emits 664/775) — normalized at extraction", async () => {
    const gz = await goodArchive({
      extra: [
        { path: `sample-connector-${SHA_A}/plain.txt`, body: "x", mode: 0o664 },
        { path: `sample-connector-${SHA_A}/run.sh`, body: "#!/bin/sh\n", mode: 0o775 },
      ],
    });
    const { violations, records } = await inspect(gz);
    expect(violations).toEqual([]);
    const dest = scratch();
    const tarBuffer = await gunzipBounded(gz);
    const { extractVerifiedTarball } = await import("../prod-extension-acquisition.mjs");
    await extractVerifiedTarball(tarBuffer, dest, { tar });
    const { statSync } = await import("node:fs");
    expect(statSync(path.join(dest, "plain.txt")).mode & 0o7777).toBe(0o644);
    expect(statSync(path.join(dest, "run.sh")).mode & 0o7777).toBe(0o755);
    // and the disk re-hash matches the archive hash (modes normalized, not lost)
    expect(computeTreeSha256FromDir(dest)).toBe(foldTreeHash(records));
  });
});

// --- tree hash ------------------------------------------------------------

describe("tree hashing", () => {
  it("foldTreeHash is order-independent and mode-sensitive", () => {
    const a = [
      { relPath: "b.txt", executable: false, sha256: "1".repeat(64) },
      { relPath: "a.txt", executable: false, sha256: "2".repeat(64) },
    ];
    const b = [a[1], a[0]];
    expect(foldTreeHash(a)).toBe(foldTreeHash(b));
    const exec = [{ ...a[0], executable: true }, a[1]];
    expect(foldTreeHash(exec)).not.toBe(foldTreeHash(a));
  });

  it("archive hash equals on-disk hash incl. the exec bit, marker excluded", async () => {
    const gz = await goodArchive({
      extra: [
        {
          path: `sample-connector-${SHA_A}/bin/run.sh`,
          body: "#!/bin/sh\necho hi\n",
          mode: 0o755,
        },
      ],
    });
    const { records } = await inspect(gz);
    const archiveHash = foldTreeHash(records);

    const dir = scratch();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@scope/sample-connector", version: "0.1.0" }));
    writeFileSync(path.join(dir, "index.ts"), "export const x = 1;\n");
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "bin/run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(path.join(dir, "bin/run.sh"), 0o755);
    writeFileSync(path.join(dir, ACQUISITION_MARKER_FILENAME), "{}"); // must be excluded
    expect(computeTreeSha256FromDir(dir)).toBe(archiveHash);
  });

  it("gunzipBounded rejects output over the bound", async () => {
    const big = gzipSync(Buffer.alloc(4096));
    await expect(gunzipBounded(big, 1024)).rejects.toThrow(/exceeds/);
    expect(MAX_DECOMPRESSED_BYTES).toBeGreaterThan(0);
  });
});

// --- end-to-end acquisition --------------------------------------------------

function fetchFor(gzBuffer, { status = 200 } = {}) {
  return async () => ({
    ok: status === 200,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    headers: { get: () => null },
    body: (async function* () {
      yield gzBuffer;
    })(),
  });
}

async function workspaceWithLock(gzBuffer) {
  const root = scratch("acq-ws-");
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const tarBuffer = await gunzipBounded(gzBuffer);
  const { records } = await inspectTarball(tarBuffer, { tar });
  writeLock(root, lockDoc({ treeSha256: foldTreeHash(records) }));
  return root;
}

describe("acquireProdRequiredExtensions", () => {
  it("skips outside a pnpm workspace (the standalone runtime image)", async () => {
    const root = scratch();
    const result = await acquireProdRequiredExtensions({ repoRoot: root, log: () => {} });
    expect(result).toEqual({ skipped: true, reason: "not-a-workspace" });
  });

  it("skips the standalone runtime root POSITIVELY even when pnpm-workspace.yaml was traced in", async () => {
    // Next's output-file tracing mirrors pnpm-workspace.yaml AND marker-less
    // extension sources into .next/standalone — the runtime image is NOT
    // detectable by "no workspace file". server.js + .next/ at the root is.
    const root = scratch();
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(path.join(root, "server.js"), "// next standalone server entry\n");
    mkdirSync(path.join(root, ".next"));
    // A traced, marker-less extension dir — the exact state that made the
    // acquisition refuse ("exists but is not acquisition-managed") and brick
    // `setup prod` in the runtime image before this guard.
    mkdirSync(path.join(root, "extensions/scope/sample-connector"), { recursive: true });
    const result = await acquireProdRequiredExtensions({ repoRoot: root, log: () => {} });
    expect(result).toEqual({ skipped: true, reason: "standalone-runtime-image" });
  });

  it("does NOT skip a real workspace that merely has a .next/ build dir", async () => {
    const gz = await goodArchive();
    const root = await workspaceWithLock(gz);
    mkdirSync(path.join(root, ".next")); // dev/build tree: .next exists, root server.js does not
    const r = await acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} });
    expect(r.skipped).toBeUndefined();
    expect(r.results).toEqual([
      expect.objectContaining({ action: "downloaded", pkgName: "@scope/sample-connector" }),
    ]);
  });

  it("downloads, verifies, and installs; re-run verifies in place", async () => {
    const gz = await goodArchive();
    const root = await workspaceWithLock(gz);
    const r1 = await acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} });
    expect(r1.results).toEqual([
      expect.objectContaining({ action: "downloaded", changed: true, pkgName: "@scope/sample-connector" }),
    ]);
    const dest = path.join(root, "extensions/scope/sample-connector");
    expect(existsSync(path.join(dest, "package.json"))).toBe(true);
    expect(existsSync(path.join(dest, ACQUISITION_MARKER_FILENAME))).toBe(true);

    let fetched = 0;
    const r2 = await acquireProdRequiredExtensions({
      repoRoot: root,
      fetchImpl: async (...args) => {
        fetched += 1;
        return fetchFor(gz)(...args);
      },
      log: () => {},
    });
    expect(fetched).toBe(0);
    expect(r2.results[0].action).toBe("verified-existing");
  });

  it("fails loud on HTTP failure", async () => {
    const gz = await goodArchive();
    const root = await workspaceWithLock(gz);
    await expect(
      acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz, { status: 404 }), log: () => {} }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("fails loud on tree-hash mismatch and leaves nothing on disk", async () => {
    const gz = await goodArchive();
    const root = await workspaceWithLock(gz);
    const tampered = await goodArchive({ extra: [{ path: `sample-connector-${SHA_A}/extra.txt`, body: "x" }] });
    await expect(
      acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(tampered), log: () => {} }),
    ).rejects.toThrow(/tree hash mismatch/);
    expect(existsSync(path.join(root, "extensions/scope/sample-connector"))).toBe(false);
  });

  it("fails loud on package name/version mismatch", async () => {
    const gz = await goodArchive();
    const root = await workspaceWithLock(gz);
    const wrongVersion = await goodArchive({ version: "9.9.9" });
    const tarBuffer = await gunzipBounded(wrongVersion);
    const { records } = await inspectTarball(tarBuffer, { tar });
    writeLock(root, lockDoc({ treeSha256: foldTreeHash(records) })); // hash matches, manifest does not
    await expect(
      acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(wrongVersion), log: () => {} }),
    ).rejects.toThrow(/version "9\.9\.9" does not match/);
    expect(gz.length).toBeGreaterThan(0);
  });

  it("fails loud on an unsafe archive", async () => {
    const evil = await goodArchive({
      extra: [{ path: `sample-connector-${SHA_A}/evil`, type: "SymbolicLink", linkpath: "/etc" }],
    });
    const root = await workspaceWithLock(await goodArchive());
    await expect(
      acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(evil), log: () => {} }),
    ).rejects.toThrow(/unsafe archive/);
  });

  it("refuses to clobber an unmanaged directory (a dev checkout)", async () => {
    const gz = await goodArchive();
    const root = await workspaceWithLock(gz);
    const dest = path.join(root, "extensions/scope/sample-connector");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "package.json"), "{}");
    await expect(
      acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} }),
    ).rejects.toThrow(/not acquisition-managed/);
  });

  it("re-acquires when the lock pin moved past the marker", async () => {
    const gz = await goodArchive();
    const root = await workspaceWithLock(gz);
    await acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} });

    // Move the pin: same content tree but a different resolvedSha in the lock.
    const lock = JSON.parse(readFileSync(path.join(root, LOCK_FILENAME), "utf8"));
    lock.packages[0].resolvedSha = "c".repeat(40);
    writeFileSync(path.join(root, LOCK_FILENAME), JSON.stringify(lock));
    const r = await acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} });
    expect(r.results[0].action).toBe("downloaded");
    const marker = JSON.parse(
      readFileSync(path.join(root, "extensions/scope/sample-connector", ACQUISITION_MARKER_FILENAME), "utf8"),
    );
    expect(marker.resolvedSha).toBe("c".repeat(40));
  });

  it("keeps the previously verified tree when a pin-moved re-acquisition fails", async () => {
    const gz = await goodArchive();
    const root = await workspaceWithLock(gz);
    await acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} });

    // Move the pin, then make the replacement download fail.
    const lock = JSON.parse(readFileSync(path.join(root, LOCK_FILENAME), "utf8"));
    lock.packages[0].resolvedSha = "c".repeat(40);
    writeFileSync(path.join(root, LOCK_FILENAME), JSON.stringify(lock));
    await expect(
      acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz, { status: 404 }), log: () => {} }),
    ).rejects.toThrow(/HTTP 404/);
    // The old verified tree must still be in place (no empty slot).
    expect(existsSync(path.join(root, "extensions/scope/sample-connector/package.json"))).toBe(true);
  });

  it("restores the old verified tree when the final rename into place fails (slot never left empty)", async () => {
    const gz = await goodArchive();
    const root = await workspaceWithLock(gz);
    await acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} });

    // Move the pin so a real re-acquisition runs, then fail the final swap
    // (the rename of the fully verified replacement onto the slot).
    const lock = JSON.parse(readFileSync(path.join(root, LOCK_FILENAME), "utf8"));
    lock.packages[0].resolvedSha = "c".repeat(40);
    writeFileSync(path.join(root, LOCK_FILENAME), JSON.stringify(lock));
    const dest = path.join(root, "extensions/scope/sample-connector");
    renameControl.failTo = dest;
    await expect(
      acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} }),
    ).rejects.toThrow(/injected rename failure/);

    // The old verified tree is restored — original content AND marker — and
    // no .acquire-* working dirs are left behind.
    expect(existsSync(path.join(dest, "package.json"))).toBe(true);
    const marker = JSON.parse(readFileSync(path.join(dest, ACQUISITION_MARKER_FILENAME), "utf8"));
    expect(marker.resolvedSha).toBe(SHA_A);
    const debris = readdirSync(path.join(root, "extensions")).filter((n) => n.startsWith(".acquire-"));
    expect(debris).toEqual([]);
  });

  it("fails loud when the lock and the declared extensions drift apart", async () => {
    const gz = await goodArchive();
    const root = await workspaceWithLock(gz);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        cinatra: { extensions: ["@scope/sample-connector@^0.1.0", "@scope/undeclared-in-lock@^0.1.0"] },
      }),
    );
    await expect(
      acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} }),
    ).rejects.toThrow(/declared but not locked: @scope\/undeclared-in-lock/);
  });

  it("fails loud when a present manifest declares no required extensions at all", async () => {
    // Fail-closed bijection: only a root with NO package.json skips the
    // cross-check; a manifest without the block while the lock pins packages
    // is itself drift.
    const gz = await goodArchive();
    const root = await workspaceWithLock(gz);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "scratch" }));
    await expect(
      acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} }),
    ).rejects.toThrow(/locked but not declared: @scope\/sample-connector/);
  });

  it("applies canonical modes regardless of the process umask", async () => {
    const previousUmask = process.umask(0o077);
    try {
      const gz = await goodArchive({
        extra: [{ path: `sample-connector-${SHA_A}/bin/run.sh`, body: "#!/bin/sh\n", mode: 0o775 }],
      });
      const root = await workspaceWithLock(gz);
      await acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} });
      const { statSync } = await import("node:fs");
      const dest = path.join(root, "extensions/scope/sample-connector");
      expect(statSync(path.join(dest, "package.json")).mode & 0o7777).toBe(0o644);
      expect(statSync(path.join(dest, "bin/run.sh")).mode & 0o7777).toBe(0o755);
      expect(statSync(path.join(dest, "bin")).mode & 0o7777).toBe(0o755);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("fails loud when marker-claimed content was tampered with", async () => {
    const gz = await goodArchive();
    const root = await workspaceWithLock(gz);
    await acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} });
    writeFileSync(path.join(root, "extensions/scope/sample-connector/index.ts"), "tampered\n");
    await expect(
      acquireProdRequiredExtensions({ repoRoot: root, fetchImpl: fetchFor(gz), log: () => {} }),
    ).rejects.toThrow(/does not match the locked treeSha256/);
  });
});

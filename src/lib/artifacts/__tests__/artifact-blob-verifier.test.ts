// cinatra#926 — DB↔blob verifier: dangling rows / orphan files / sha
// mismatch, understanding BOTH key shapes (legacy scope-derived +
// content-addressed) forever. REPORT-ONLY: the verifier never deletes.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: () => null,
  writeMetadataValueToDatabase: () => {},
}));

import {
  verifyArtifactBlobs,
  type ArtifactBlobRow,
} from "../artifact-blob-verifier";
import { ARTIFACT_STAGING_DIR_NAME } from "../local-disk-blob-store";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("verifyArtifactBlobs", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "v5-verify-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fileAt(relKey: string, content: string, mtime?: Date): void {
    const abs = path.join(root, relKey);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    if (mtime) utimesSync(abs, mtime, mtime);
  }

  function contentKey(orgId: string, content: string): string {
    const h = sha(content);
    return `orgs/${orgId}/blobs/sha256/${h.slice(0, 2)}/${h}.bin`;
  }

  const run = (rows: ArtifactBlobRow[], opts?: { orgId?: string; graceMs?: number }) =>
    verifyArtifactBlobs({
      ...opts,
      deps: { listBlobRows: () => rows, root },
    });

  it("clean store (both key shapes) → empty report", async () => {
    const legacyKey = "orgs/org1/artifacts/a1/versions/v1/b1.bin";
    fileAt(legacyKey, "legacy bytes");
    const caKey = contentKey("org1", "content bytes");
    fileAt(caKey, "content bytes");
    const report = await run([
      { id: "b1", orgId: "org1", storageKey: legacyKey, sha256: sha("legacy bytes") },
      { id: "b2", orgId: "org1", storageKey: caKey, sha256: sha("content bytes") },
    ]);
    expect(report.danglingRows).toEqual([]);
    expect(report.orphanFiles).toEqual([]);
    expect(report.shaMismatches).toEqual([]);
    expect(report.scannedRows).toBe(2);
    expect(report.scannedFiles).toBe(2);
  });

  it("(a) reports a dangling row (row → missing file) for both shapes", async () => {
    const report = await run([
      {
        id: "b1",
        orgId: "org1",
        storageKey: "orgs/org1/artifacts/a1/versions/v1/gone.bin",
        sha256: sha("x"),
      },
      { id: "b2", orgId: "org1", storageKey: contentKey("org1", "y"), sha256: sha("y") },
    ]);
    expect(report.danglingRows.map((d) => d.blobId).sort()).toEqual(["b1", "b2"]);
  });

  it("(b) reports orphan files (file → no row) with grace labeling; never deletes", async () => {
    const youngKey = contentKey("org1", "young orphan");
    fileAt(youngKey, "young orphan");
    const oldKey = contentKey("org1", "old orphan");
    fileAt(oldKey, "old orphan", new Date(Date.now() - 60 * 60 * 1000));
    const report = await run([], { graceMs: 15 * 60 * 1000 });
    const byPath = Object.fromEntries(report.orphanFiles.map((o) => [o.relPath, o]));
    expect(byPath[youngKey]?.youngerThanGrace).toBe(true);
    expect(byPath[oldKey]?.youngerThanGrace).toBe(false);
    expect(byPath[oldKey]?.reason).toBe("no-row");
  });

  it("(b) reports staging residue past the grace age only", async () => {
    const staging = path.join(root, ARTIFACT_STAGING_DIR_NAME);
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "in-flight"), "x");
    const oldAbs = path.join(staging, "stale");
    writeFileSync(oldAbs, "y");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(oldAbs, old, old);
    const report = await run([], { graceMs: 15 * 60 * 1000 });
    expect(report.orphanFiles).toHaveLength(1);
    expect(report.orphanFiles[0].reason).toBe("staging-residue");
    expect(report.orphanFiles[0].relPath).toBe(`${ARTIFACT_STAGING_DIR_NAME}/stale`);
  });

  it("(c) reports a content re-hash mismatch", async () => {
    const key = "orgs/org1/artifacts/a1/versions/v1/b1.bin";
    fileAt(key, "actual bytes");
    const report = await run([
      { id: "b1", orgId: "org1", storageKey: key, sha256: sha("expected bytes") },
    ]);
    expect(report.shaMismatches).toHaveLength(1);
    expect(report.shaMismatches[0].source).toBe("content-rehash");
    expect(report.shaMismatches[0].actualSha256).toBe(sha("actual bytes"));
  });

  it("(c) reports a key-embedded-sha mismatch on a content-addressed key", async () => {
    const key = contentKey("org1", "the path says these bytes");
    fileAt(key, "the path says these bytes");
    const report = await run([
      { id: "b1", orgId: "org1", storageKey: key, sha256: sha("but the row says these") },
    ]);
    const sources = report.shaMismatches.map((m) => m.source).sort();
    expect(sources).toContain("key-embedded-sha");
  });

  it("orgId filter scopes rows AND the orphan walk to that org's subtree", async () => {
    const otherOrgKey = contentKey("org2", "other org bytes");
    fileAt(otherOrgKey, "other org bytes");
    const myKey = contentKey("org1", "mine");
    fileAt(myKey, "mine");
    const report = await run(
      [{ id: "b1", orgId: "org1", storageKey: myKey, sha256: sha("mine") }],
      { orgId: "org1" },
    );
    // org2's file is NOT reported against org1's filtered row set.
    expect(report.orphanFiles).toEqual([]);
    expect(report.danglingRows).toEqual([]);
  });

  it("connectorRef carve-out: pointer-only artifacts contribute no row and no file → clean report", async () => {
    // A connectorRef (pointer-only) artifact never mints an artifact_blobs
    // row and never writes a local file — the store containing only pointer
    // artifacts is EMPTY from the verifier's perspective. Regression pin for
    // cinatra#926's "no-storage carve-out stays".
    const report = await run([]);
    expect(report.scannedRows).toBe(0);
    expect(report.scannedFiles).toBe(0);
    expect(report.danglingRows).toEqual([]);
    expect(report.orphanFiles).toEqual([]);
    expect(report.shaMismatches).toEqual([]);
  });
});

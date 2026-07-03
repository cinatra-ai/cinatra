// DB↔blob verifier for the on-server artifact byte store (cinatra#926).
//
// REPORT-ONLY — this module never deletes or mutates anything. GC stays
// DB-reachability only; the verifier is the operator's eyes:
//   (a) DANGLING ROWS   — an `artifact_blobs` row whose file is missing;
//   (b) ORPHAN FILES    — a file under `<root>/orgs/` no live row references,
//                         plus `.staging/` residue older than the grace age
//                         (younger-than-grace orphans are reported as such,
//                         never eligible for deletion);
//   (c) SHA MISMATCH    — file bytes re-hash ≠ the row's sha256, and (for
//                         content-addressed keys) key-embedded sha ≠ row sha.
//
// It understands BOTH key shapes FOREVER:
//   legacy   `orgs/<org>/artifacts/<aid>/versions/<rev>/<blobId>.bin`
//   content  `orgs/<org>/blobs/sha256/<aa>/<sha256>.bin`
//
// connectorRef (pointer-only) artifacts create NO artifact_blobs row and NO
// local file, so they are structurally invisible here — a clean report over
// a store containing only pointer artifacts is the pinned expectation.
//
// Invoked from an admin surface or a script — NEVER boot-blocking.

import "server-only";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { resolveArtifactDataRoot } from "./artifact-data-root";
import {
  ARTIFACT_STAGING_DIR_NAME,
  DEFAULT_ARTIFACT_DELETE_GRACE_MS,
  isContentAddressedStorageKey,
  sha256FromContentAddressedKey,
} from "./local-disk-blob-store";

export type ArtifactBlobRow = {
  id: string;
  orgId: string;
  storageKey: string;
  sha256: string;
};

export type ArtifactBlobVerifierReport = {
  root: string;
  scannedRows: number;
  scannedFiles: number;
  /** (a) row → missing file */
  danglingRows: Array<{ blobId: string; orgId: string; storageKey: string }>;
  /** (b) file → no row; staging residue past the grace age */
  orphanFiles: Array<{
    relPath: string;
    reason: "no-row" | "staging-residue";
    ageMs: number;
    /** Never delete-eligible; reported for operator awareness only. */
    youngerThanGrace: boolean;
  }>;
  /** (c) re-hash ≠ row sha256 / content-addressed key sha ≠ row sha256 */
  shaMismatches: Array<{
    blobId: string;
    orgId: string;
    storageKey: string;
    expectedSha256: string;
    actualSha256: string;
    source: "content-rehash" | "key-embedded-sha";
  }>;
};

export type VerifyArtifactBlobsOptions = {
  /** Restrict the row scan (and orphan attribution) to one org. */
  orgId?: string;
  /** Skip the byte re-hash (cheap structural pass only). Default: hash. */
  skipContentRehash?: boolean;
  /** Grace age for staging residue / young-orphan labeling. */
  graceMs?: number;
  /** Injectable seams (unit tests). Defaults are the production reads. */
  deps?: {
    listBlobRows?: (orgId?: string) => Promise<ArtifactBlobRow[]> | ArtifactBlobRow[];
    root?: string;
    now?: () => number;
  };
};

async function defaultListBlobRows(orgId?: string): Promise<ArtifactBlobRow[]> {
  const { runPostgresQueriesSync } = await import("@/lib/postgres-sync");
  const { getPostgresConnectionString, postgresSchema } = await import(
    "@/lib/postgres-config"
  );
  const schema = postgresSchema.replaceAll('"', '""');
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: orgId
          ? `SELECT id, org_id, storage_key, sha256 FROM "${schema}"."artifact_blobs" WHERE org_id = $1`
          : `SELECT id, org_id, storage_key, sha256 FROM "${schema}"."artifact_blobs"`,
        values: orgId ? [orgId] : [],
      },
    ],
  });
  return ((res?.rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    orgId: String(r.org_id),
    storageKey: String(r.storage_key),
    sha256: String(r.sha256),
  }));
}

async function sha256OfFile(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(absPath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Recursively collect files under `dir`, returned root-relative (posix). */
async function walkFiles(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, abs, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  }
}

export async function verifyArtifactBlobs(
  options?: VerifyArtifactBlobsOptions,
): Promise<ArtifactBlobVerifierReport> {
  const root = options?.deps?.root ?? resolveArtifactDataRoot();
  const now = options?.deps?.now ?? Date.now;
  const graceMs = options?.graceMs ?? DEFAULT_ARTIFACT_DELETE_GRACE_MS;
  const listBlobRows = options?.deps?.listBlobRows ?? defaultListBlobRows;

  const report: ArtifactBlobVerifierReport = {
    root,
    scannedRows: 0,
    scannedFiles: 0,
    danglingRows: [],
    orphanFiles: [],
    shaMismatches: [],
  };

  const rows = await listBlobRows(options?.orgId);
  report.scannedRows = rows.length;
  const referencedKeys = new Set<string>();

  for (const row of rows) {
    referencedKeys.add(row.storageKey);
    // (c) structural: a content-addressed key must embed the row's sha.
    const keySha = sha256FromContentAddressedKey(row.storageKey);
    if (isContentAddressedStorageKey(row.storageKey) && keySha && keySha !== row.sha256) {
      report.shaMismatches.push({
        blobId: row.id,
        orgId: row.orgId,
        storageKey: row.storageKey,
        expectedSha256: row.sha256,
        actualSha256: keySha,
        source: "key-embedded-sha",
      });
    }
    const abs = path.join(root, row.storageKey);
    let exists = false;
    try {
      const st = await fsStat(abs);
      exists = st.isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      report.danglingRows.push({
        blobId: row.id,
        orgId: row.orgId,
        storageKey: row.storageKey,
      });
      continue;
    }
    if (!options?.skipContentRehash) {
      try {
        const actual = await sha256OfFile(abs);
        if (actual !== row.sha256) {
          report.shaMismatches.push({
            blobId: row.id,
            orgId: row.orgId,
            storageKey: row.storageKey,
            expectedSha256: row.sha256,
            actualSha256: actual,
            source: "content-rehash",
          });
        }
      } catch {
        // unreadable between stat and hash — surfaces as dangling next run
      }
    }
  }

  // (b) orphan files: everything under `<root>/orgs/` no row references.
  // With an org filter, only that org's subtree is attributable — scanning
  // other orgs' files against a filtered row set would mass-false-positive.
  const orgScanRoot = options?.orgId
    ? path.join(root, "orgs", options.orgId)
    : path.join(root, "orgs");
  const files: string[] = [];
  await walkFiles(root, orgScanRoot, files);
  report.scannedFiles = files.length;
  for (const relPath of files) {
    if (referencedKeys.has(relPath)) continue;
    let ageMs = 0;
    try {
      const st = await fsStat(path.join(root, relPath));
      ageMs = Math.max(0, now() - st.mtimeMs);
    } catch {
      continue; // raced with a concurrent delete
    }
    report.orphanFiles.push({
      relPath,
      reason: "no-row",
      ageMs,
      youngerThanGrace: ageMs < graceMs,
    });
  }

  // (b) staging residue past the grace age (an in-flight put's staged file
  // is younger than grace and deliberately NOT reported).
  const stagingAbs = path.join(root, ARTIFACT_STAGING_DIR_NAME);
  const stagingFiles: string[] = [];
  await walkFiles(root, stagingAbs, stagingFiles);
  report.scannedFiles += stagingFiles.length;
  for (const relPath of stagingFiles) {
    let ageMs = 0;
    try {
      const st = await fsStat(path.join(root, relPath));
      ageMs = Math.max(0, now() - st.mtimeMs);
    } catch {
      continue;
    }
    if (ageMs < graceMs) continue;
    report.orphanFiles.push({
      relPath,
      reason: "staging-residue",
      ageMs,
      youngerThanGrace: false,
    });
  }

  return report;
}

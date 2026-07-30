/**
 * cinatra#2088 (epic #2086 S1) — bundle-aware skill content authority,
 * REAL-SURFACE integration test (no mocks on the store/DB path).
 *
 * Guarded by `describe.skipIf(!HAS_REAL_DB)` like the other integration suites:
 * CI without a reachable Postgres emits zero failures. With a real
 * `SUPABASE_DB_URL` it drives, against a fresh per-test schema provisioned from
 * the drizzle-store bootstrap DDL:
 *
 *   1. a MULTI-FILE bundle (SKILL.md router + a text reference + a BINARY
 *      resource) written to the authority, then read back byte-exact — the
 *      binary survives (bytea authority), the manifest resolves;
 *   2. the acceptance round-trip: DB → materialized directory → canonical zip,
 *      with the SAME bundle digest recomputed independently at EACH step;
 *   3. content-addressed blob DEDUP (two files with identical bytes share one
 *      blob row) + INGEST idempotence (a re-ingest writes nothing new);
 *   4. append-only immutability (UPDATE/DELETE on the blob + manifest tables
 *      raise);
 *   5. whole-bundle ROLLBACK — the rollback revision's manifest is the TARGET
 *      revision's complete FILE SET, restored via the copy CTE, and the
 *      current-bundle head advances to it;
 *   6. CAPTURE of a DERIVED (extension) skill that has no lifecycle revision at
 *      all — idempotent, content-addressed, head-advancing on a real change;
 *   7. two DIFFERENT skills with byte-identical bundles each resolving their own
 *      manifest (the skill-keyed revision id) while still sharing one blob;
 *   8. capture never clobbering an AUTHORITY-OWNED head with disk content;
 *   9. the one-hop router-reference lint surfacing a dangling reference.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";


// The root vitest config aliases the heavy `@cinatra-ai/llm` barrel to the
// narrow actor-context stub, which lacks the canonical-zip helper this suite
// uses to prove the DB → dir → zip round-trip. Merge the REAL (light —
// node:crypto only) content-hash module over that stub. (The store itself
// carries its pure bundle-identity helpers inline, so its own production
// imports need no mock at all.)
vi.mock("@cinatra-ai/llm", async () => {
  const contentHash = await import("../../../../packages/llm/src/tools/anthropic-skill-content-hash");
  const actorStub = await import("../../../../packages/llm/src/actor-context");
  return { ...actorStub, ...contentHash };
});

const TEST_SCHEMA = "cinatra_test_skill_bundle_2088";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Minimal STORE-only zip reader: entry path → raw bytes. */
function readStoreZip(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.length - 22;
  const total = zip.readUInt16LE(eocd + 10);
  let cd = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < total; i++) {
    const size = zip.readUInt32LE(cd + 24);
    const nameLen = zip.readUInt16LE(cd + 28);
    const extraLen = zip.readUInt16LE(cd + 30);
    const commentLen = zip.readUInt16LE(cd + 32);
    const localOff = zip.readUInt32LE(cd + 42);
    const name = zip.subarray(cd + 46, cd + 46 + nameLen).toString("utf8");
    const lNameLen = zip.readUInt16LE(localOff + 26);
    const lExtraLen = zip.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    out.set(name, zip.subarray(dataStart, dataStart + size));
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe.skipIf(!HAS_REAL_DB)("cinatra#2088 bundle-aware content authority (real DB + disk)", () => {
  let client: Client;
  let priorSchemaEnv: string | undefined;
  let store: typeof import("../../skill-bundle-store");
  let llm: typeof import("@cinatra-ai/llm");

  const SKILL_ID = "skill-int-2088";
  const REV_1 = "rev-int-2088-1";
  const REV_2 = "rev-int-2088-2";

  const routerBytes = Buffer.from("---\nname: int-2088\n---\n# Router\nSee [guide](references/guide.md).\n", "utf8");
  const guideBytes = Buffer.from("# Guide\nreference body\n", "utf8");
  // A non-UTF-8 binary resource (invalid UTF-8 bytes) — must survive byte-exact.
  const binaryBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01, 0x02, 0x80]);

  beforeAll(async () => {
    priorSchemaEnv = process.env.SUPABASE_SCHEMA;
    process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);

    const { buildCreateStoreSchemaQueries } = await import("../../drizzle-store");
    for (const q of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      const head = q.text.trim().slice(0, 6).toUpperCase();
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S" && head !== "DO $$") {
        continue;
      }
      try {
        await client.query(q.text, (q as { values?: unknown[] }).values as never[]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("does not exist")) throw err;
      }
    }
    (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

    // Seed the two revisions + a skills head so readRevisionBundle resolves and
    // the rollback CAS has a row to swap (INSERT is allowed by the append-only
    // trigger; only UPDATE/DELETE raise).
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revisions" (id, skill_id, source) VALUES ($1,$2,'manual'),($3,$2,'manual')`,
      [REV_1, SKILL_ID, REV_2],
    );

    store = await import("../../skill-bundle-store");
    llm = await import("@cinatra-ai/llm");
    // The bootstrap DROP + full store DDL exceeds vitest's 10s default hook
    // timeout on a cold server, which surfaced as a whole-suite failure with no
    // assertion behind it. Bounded generously; a genuinely unreachable DB still
    // fails fast at connect().
  }, 60_000);

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await client?.end().catch(() => {});
    delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
    if (priorSchemaEnv === undefined) delete process.env.SUPABASE_SCHEMA;
    else process.env.SUPABASE_SCHEMA = priorSchemaEnv;
  }, 60_000);

  it("writes a multi-file bundle and reads it back byte-exact (binary survives)", () => {
    const written = store.writeRevisionBundleToDatabase({
      revisionId: REV_1,
      skillId: SKILL_ID,
      files: [
        { path: "SKILL.md", bytes: routerBytes, isRouter: true },
        { path: "references/guide.md", bytes: guideBytes },
        { path: "assets/logo.png", bytes: binaryBytes },
      ],
    });
    const bundle = store.readRevisionBundleFromDatabase(SKILL_ID, REV_1);
    expect(bundle).not.toBeNull();
    expect(bundle!.bundleDigest).toBe(written);
    // Sorted on BOTH sides: the manifest read's `ORDER BY path` follows the
    // DATABASE collation (`SKILL.md` sorts before `references/…` under C, after
    // it under en_US.utf8), and nothing depends on that order — the bundle digest
    // sorts internally. Asserting a raw C-collation order made this suite pass or
    // fail on the operator's initdb locale.
    expect([...bundle!.files.map((f) => f.path)].sort()).toEqual(
      ["SKILL.md", "assets/logo.png", "references/guide.md"].sort(),
    );
    const byPath = new Map(bundle!.files.map((f) => [f.path, f]));
    expect(byPath.get("SKILL.md")!.bytes.equals(routerBytes)).toBe(true);
    expect(byPath.get("SKILL.md")!.isRouter).toBe(true);
    expect(byPath.get("references/guide.md")!.bytes.equals(guideBytes)).toBe(true);
    // Binary byte-exact through the bytea authority.
    expect(byPath.get("assets/logo.png")!.bytes.equals(binaryBytes)).toBe(true);
    expect(byPath.get("assets/logo.png")!.digest).toBe(sha(binaryBytes));
  });

  it("fail-closed cross-skill scoping: a foreign skillId resolves to null", () => {
    expect(store.readRevisionBundleFromDatabase("some-other-skill", REV_1)).toBeNull();
  });

  it("acceptance round-trip: DB → materialized dir → canonical zip, identical bundle digest at each step", async () => {
    const bundle = store.readRevisionBundleFromDatabase(SKILL_ID, REV_1)!;
    const dbDigest = bundle.bundleDigest;

    // (a) materialize to a directory, re-read from disk, recompute the digest.
    const destParent = mkdtempSync(path.join(tmpdir(), "bundle-mat-"));
    const destDir = path.join(destParent, "skill");
    try {
      const mat = await store.materializeRevisionBundleToDirectory(SKILL_ID, REV_1, destDir);
      expect(mat.bundleDigest).toBe(dbDigest);
      expect(mat.fileCount).toBe(3);

      // Walk the materialized dir, hash each file, recompute the bundle digest.
      const diskEntries: { path: string; digest: string }[] = [];
      const walk = (dir: string, rel: string) => {
        for (const name of readdirSync(dir)) {
          const full = path.join(dir, name);
          const r = rel ? `${rel}/${name}` : name;
          if (statSync(full).isDirectory()) walk(full, r);
          else diskEntries.push({ path: r, digest: sha(readFileSync(full)) });
        }
      };
      walk(destDir, "");
      // The binary on disk is byte-exact.
      expect(readFileSync(path.join(destDir, "assets/logo.png")).equals(binaryBytes)).toBe(true);
      const diskDigest = store.computeBundleDigest(diskEntries);
      expect(diskDigest).toBe(dbDigest);

      // (b) build the canonical S0 zip from the SAME authority bytes, read its
      // entries back, strip the root dir, recompute the bundle digest.
      const router = bundle.files.find((f) => f.isRouter)!;
      const zip = llm.buildCanonicalSkillZip({
        skillMd: router.bytes,
        bundledFiles: bundle.files.filter((f) => !f.isRouter).map((f) => ({ relPath: f.path, bytes: f.bytes })),
        rootDir: llm.deriveSkillRootDir(router.bytes, "int-2088"),
      });
      const entries = readStoreZip(zip.zipBytes);
      const rootDir = zip.rootDir;
      const zipEntries: { path: string; digest: string }[] = [];
      for (const [name, bytes] of entries) {
        expect(name.startsWith(`${rootDir}/`)).toBe(true);
        zipEntries.push({ path: name.slice(rootDir.length + 1), digest: sha(bytes) });
      }
      const zipDigest = store.computeBundleDigest(zipEntries);
      expect(zipDigest).toBe(dbDigest);
    } finally {
      rmSync(destParent, { recursive: true, force: true });
    }
  });

  it("content-addressed blob dedup + ingest idempotence: identical bytes share one row; a re-write adds nothing", async () => {
    // guide.md's bytes appear once; write a SECOND revision that also carries an
    // identical-bytes file → the blob is shared (one row per digest).
    store.writeRevisionBundleToDatabase({
      revisionId: REV_2,
      skillId: SKILL_ID,
      files: [
        { path: "SKILL.md", bytes: routerBytes, isRouter: true },
        { path: "copy/guide.md", bytes: guideBytes }, // same bytes as rev1's guide
      ],
    });
    const blobCount = await client.query(
      `SELECT count(*)::int AS n FROM "${TEST_SCHEMA}"."skill_bundle_blobs" WHERE content_digest = $1`,
      [sha(guideBytes)],
    );
    expect(blobCount.rows[0].n).toBe(1); // dedup: one blob for the shared bytes

    // Idempotent re-write of rev1 changes nothing (manifest + blobs ON CONFLICT).
    const before = await client.query(
      `SELECT count(*)::int AS n FROM "${TEST_SCHEMA}"."skill_revision_files" WHERE revision_id = $1`,
      [REV_1],
    );
    store.writeRevisionBundleToDatabase({
      revisionId: REV_1,
      skillId: SKILL_ID,
      files: [
        { path: "SKILL.md", bytes: routerBytes, isRouter: true },
        { path: "references/guide.md", bytes: guideBytes },
        { path: "assets/logo.png", bytes: binaryBytes },
      ],
    });
    const after = await client.query(
      `SELECT count(*)::int AS n FROM "${TEST_SCHEMA}"."skill_revision_files" WHERE revision_id = $1`,
      [REV_1],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("append-only: UPDATE/DELETE on the blob + manifest tables raise", async () => {
    await expect(
      client.query(`UPDATE "${TEST_SCHEMA}"."skill_bundle_blobs" SET byte_length = 0`),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.query(`DELETE FROM "${TEST_SCHEMA}"."skill_revision_files" WHERE revision_id = $1`, [REV_1]),
    ).rejects.toThrow(/append-only/);
  });

  it("whole-bundle rollback: the rollback revision's manifest is the TARGET revision's complete file set", async () => {
    const { buildSkillRollbackQuery } = await import("../../skill-lifecycle-store");
    // Point the head at REV_2 (the 2-file revision), then roll back to REV_1
    // (the 3-file revision). The rollback revision must carry REV_1's file SET.
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skills" (id, payload, active_revision_id) VALUES ($1, '{}', $2)`,
      [SKILL_ID, REV_2],
    );
    const ROLL = "rev-int-2088-rollback";
    const q = buildSkillRollbackQuery(TEST_SCHEMA, {
      skillId: SKILL_ID,
      expectedActiveRevisionId: REV_2,
      newRevisionId: ROLL,
      targetRevisionId: REV_1,
      restoredContent: routerBytes.toString("utf8"),
      restoredContentDigest: sha(routerBytes),
      restoredPayloadJson: JSON.stringify({ id: SKILL_ID }),
      authorUserId: "u1",
      // The target's bundle identity, resolved from its manifest exactly as
      // applySkillRollbackInDatabase does.
      targetBundleDigest: store.readRevisionBundleFromDatabase(SKILL_ID, REV_1)!.bundleDigest,
    });
    await client.query(q.text, q.values as never[]);

    const rollbackManifest = await client.query(
      `SELECT path FROM "${TEST_SCHEMA}"."skill_revision_files" WHERE revision_id = $1 ORDER BY path`,
      [ROLL],
    );
    const target = await client.query(
      `SELECT path FROM "${TEST_SCHEMA}"."skill_revision_files" WHERE revision_id = $1 ORDER BY path`,
      [REV_1],
    );
    expect(rollbackManifest.rows.map((r: { path: string }) => r.path)).toEqual(
      target.rows.map((r: { path: string }) => r.path),
    );
    // The rollback revision reads back as a complete, digest-consistent bundle
    // identical to the target's file set.
    const rolledBundle = store.readRevisionBundleFromDatabase(SKILL_ID, ROLL)!;
    const targetBundle = store.readRevisionBundleFromDatabase(SKILL_ID, REV_1)!;
    expect(rolledBundle.bundleDigest).toBe(targetBundle.bundleDigest);

    // The CURRENT bundle is now the restored one: the head advanced to the
    // rollback revision, so byte-bound sync mirrors the restored file set.
    const head = store.readSkillBundleHeadFromDatabase(SKILL_ID)!;
    expect(head.revisionId).toBe(ROLL);
    expect(head.bundleDigest).toBe(targetBundle.bundleDigest);
    expect(store.readCurrentSkillBundleFromDatabase(SKILL_ID)!.bundleDigest).toBe(targetBundle.bundleDigest);
  });

  it("captures a DERIVED (extension) skill from disk with no lifecycle revision at all, and is idempotent", async () => {
    // The lifecycle revision layer is custom/personal-only, so an extension
    // skill has NO skill_revisions row and a NULL skills.active_revision_id.
    // Its bundle identity comes from the authority's own head pointer.
    const DERIVED_SKILL = "derived-ext-2088";
    const root = mkdtempSync(path.join(tmpdir(), "derived-capture-"));
    const dir = path.join(root, "ext-skill");
    mkdirSync(path.join(dir, "references"), { recursive: true });
    const routerPath = path.join(dir, "SKILL.md");
    writeFileSync(routerPath, "---\nname: ext-skill\n---\n# Ext\nSee [g](references/g.md).\n");
    writeFileSync(path.join(dir, "references", "g.md"), "# G\n");
    try {
      const first = await store.captureSkillBundleFromDisk(DERIVED_SKILL, routerPath);
      expect(first.changed).toBe(true);
      expect(first.revisionId).toBe(store.derivedBundleRevisionId(DERIVED_SKILL, first.bundleDigest));
      expect(first.lint).toEqual({ ok: true, missing: [] });
      // No skill_revisions row exists for this skill — the manifest is the
      // authority, and the current bundle still resolves.
      const revRows = await client.query(
        `SELECT count(*)::int AS n FROM "${TEST_SCHEMA}"."skill_revisions" WHERE skill_id = $1`,
        [DERIVED_SKILL],
      );
      expect(revRows.rows[0].n).toBe(0);
      const current = store.readCurrentSkillBundleFromDatabase(DERIVED_SKILL)!;
      expect(current.bundleDigest).toBe(first.bundleDigest);
      expect([...current.files.map((f) => f.path)].sort()).toEqual(["SKILL.md", "references/g.md"].sort());

      // Re-capture of UNCHANGED bytes advances nothing and writes nothing.
      const second = await store.captureSkillBundleFromDisk(DERIVED_SKILL, routerPath);
      expect(second.changed).toBe(false);
      expect(second.revisionId).toBe(first.revisionId);

      // A CONTENT CHANGE mints a new content-addressed revision + head; the
      // prior manifest stays immutable (append-only history).
      writeFileSync(path.join(dir, "references", "g.md"), "# G\nchanged\n");
      const third = await store.captureSkillBundleFromDisk(DERIVED_SKILL, routerPath);
      expect(third.changed).toBe(true);
      expect(third.bundleDigest).not.toBe(first.bundleDigest);
      expect(store.readSkillBundleHeadFromDatabase(DERIVED_SKILL)!.revisionId).toBe(third.revisionId);
      expect(store.readRevisionBundleFromDatabase(DERIVED_SKILL, first.revisionId)!.bundleDigest).toBe(
        first.bundleDigest,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("two DIFFERENT skills with byte-identical bundles each resolve their OWN manifest", async () => {
    // The manifest PK is (revision_id, path) — a digest-only revision id would
    // be shared by byte-identical bundles, so the second skill's manifest insert
    // would be swallowed by ON CONFLICT DO NOTHING while its head advanced,
    // leaving it permanently unreadable. The revision id is keyed by
    // (skillId, bundleDigest) precisely to prevent that.
    const root = mkdtempSync(path.join(tmpdir(), "twin-capture-"));
    const body = "---\nname: twin\n---\n# Twin\n";
    const mk = (name: string) => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      const p = path.join(dir, "SKILL.md");
      writeFileSync(p, body);
      return p;
    };
    try {
      const a = await store.captureSkillBundleFromDisk("twin-a-2088", mk("a"));
      const b = await store.captureSkillBundleFromDisk("twin-b-2088", mk("b"));
      expect(a.bundleDigest).toBe(b.bundleDigest); // byte-identical bundles
      expect(a.revisionId).not.toBe(b.revisionId); // but distinct revision ids
      const bundleA = store.readCurrentSkillBundleFromDatabase("twin-a-2088")!;
      const bundleB = store.readCurrentSkillBundleFromDatabase("twin-b-2088")!;
      expect(bundleA.files.map((f) => f.path)).toEqual(["SKILL.md"]);
      expect(bundleB.files.map((f) => f.path)).toEqual(["SKILL.md"]);
      // The shared BYTES still dedup to one blob (content-addressed).
      const blobs = await client.query(
        `SELECT count(*)::int AS n FROM "${TEST_SCHEMA}"."skill_bundle_blobs" WHERE content_digest = $1`,
        [sha(Buffer.from(body, "utf8"))],
      );
      expect(blobs.rows[0].n).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("capture NEVER clobbers an AUTHORITY-OWNED head (a lifecycle revision) with disk content", async () => {
    // A custom/personal skill's head is a lifecycle revision — the DB is its
    // content authority and the on-disk copy is a projection a rollback does not
    // rewrite. Capturing disk over it would silently re-upload rolled-back
    // content.
    const AUTH_SKILL = "authority-owned-2088";
    const LIFECYCLE_REV = "rev-authority-owned-2088";
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revisions" (id, skill_id, source) VALUES ($1,$2,'manual')`,
      [LIFECYCLE_REV, AUTH_SKILL],
    );
    const stored = Buffer.from("---\nname: authority\n---\n# stored (authoritative)\n", "utf8");
    const storedDigest = store.writeRevisionBundleToDatabase({
      revisionId: LIFECYCLE_REV,
      skillId: AUTH_SKILL,
      files: [{ path: "SKILL.md", bytes: stored, isRouter: true }],
    });

    const root = mkdtempSync(path.join(tmpdir(), "authority-owned-"));
    const dir = path.join(root, "skill");
    mkdirSync(dir, { recursive: true });
    const routerPath = path.join(dir, "SKILL.md");
    writeFileSync(routerPath, "---\nname: authority\n---\n# DIVERGENT disk copy\n");
    try {
      const cap = await store.captureSkillBundleFromDisk(AUTH_SKILL, routerPath);
      expect(cap.authorityOwnedDivergence).toBe(true);
      expect(cap.changed).toBe(false);
      expect(cap.revisionId).toBe(LIFECYCLE_REV);
      // The head — and therefore what byte-bound sync uploads — is still the
      // STORED revision's bytes, not the disk copy.
      const current = store.readCurrentSkillBundleFromDatabase(AUTH_SKILL)!;
      expect(current.revisionId).toBe(LIFECYCLE_REV);
      expect(current.bundleDigest).toBe(storedDigest);
      expect(current.files[0].bytes.equals(stored)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pre-S1 re-baseline: capture ADOPTS an existing lifecycle head instead of minting a disk-owned one", async () => {
    // The upgrade shape: a custom skill written BEFORE this slice has a
    // lifecycle head (skills.active_revision_id) + a stored SKILL.md blob, but
    // no bundle manifest and no bundle head. Capture must seed the head from
    // that authoritative revision — otherwise a divergent on-disk copy (e.g.
    // left by a rollback that did not rewrite disk) would win.
    const LEGACY_SKILL = "pre-s1-legacy-2088";
    const LEGACY_REV = "rev-pre-s1-legacy-2088";
    const storedBody = "---\nname: legacy\n---\n# stored pre-S1 body\n";
    const storedDigest = sha(Buffer.from(storedBody, "utf8"));
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revision_contents" (content_digest, content, byte_length)
       VALUES ($1, $2, octet_length($2))`,
      [storedDigest, storedBody],
    );
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revisions" (id, skill_id, content_digest, source) VALUES ($1,$2,$3,'manual')`,
      [LEGACY_REV, LEGACY_SKILL, storedDigest],
    );
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skills" (id, payload, active_revision_id) VALUES ($1, '{}', $2)`,
      [LEGACY_SKILL, LEGACY_REV],
    );

    const root = mkdtempSync(path.join(tmpdir(), "pre-s1-legacy-"));
    const dir = path.join(root, "skill");
    mkdirSync(dir, { recursive: true });
    const routerPath = path.join(dir, "SKILL.md");
    writeFileSync(routerPath, "---\nname: legacy\n---\n# DIVERGENT disk body\n");
    try {
      const cap = await store.captureSkillBundleFromDisk(LEGACY_SKILL, routerPath);
      expect(cap.authorityOwnedDivergence).toBe(true);
      expect(cap.revisionId).toBe(LEGACY_REV); // adopted, not `bundle:<...>`
      const current = store.readCurrentSkillBundleFromDatabase(LEGACY_SKILL)!;
      expect(current.revisionId).toBe(LEGACY_REV);
      expect(current.files.map((f) => f.path)).toEqual(["SKILL.md"]);
      expect(current.files[0].bytes.toString("utf8")).toBe(storedBody);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("capture surfaces a DANGLING one-hop router reference as a diagnostic (S1 reports; S2 gates)", async () => {
    const DANGLING_SKILL = "dangling-ext-2088";
    const root = mkdtempSync(path.join(tmpdir(), "dangling-capture-"));
    const dir = path.join(root, "ext-skill");
    mkdirSync(dir, { recursive: true });
    const routerPath = path.join(dir, "SKILL.md");
    writeFileSync(routerPath, "---\nname: dangling\n---\nSee [missing](references/nope.md).\n");
    try {
      const cap = await store.captureSkillBundleFromDisk(DANGLING_SKILL, routerPath);
      expect(cap.lint.ok).toBe(false);
      expect(cap.lint.missing).toEqual(["references/nope.md"]);
      // Non-fatal: the bundle is still captured and resolvable.
      expect(store.readCurrentSkillBundleFromDatabase(DANGLING_SKILL)!.bundleDigest).toBe(cap.bundleDigest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // cinatra#2094 F7-A — the router-only-seed HEAL, on the real authority.
  //
  // The heal unpins an instance the pre-guard bundle-of-ONE seed left with a
  // router-only manifest it could never grow. These cases prove it fires on
  // exactly that head and on nothing else, and that its head replacement is a
  // real compare-and-swap under a genuine two-transaction race.
  // -------------------------------------------------------------------------

  const ROUTER_BODY = "---\nname: heal\n---\n# Router\nSee [a](references/a.md).\n";

  /** Materialize a skill dir; `withReference` adds the one-hop `references/a.md`. */
  function materializeSkill(name: string, withReference: boolean): { root: string; routerPath: string } {
    const root = mkdtempSync(path.join(tmpdir(), `${name}-`));
    const dir = path.join(root, "skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), ROUTER_BODY);
    if (withReference) {
      mkdirSync(path.join(dir, "references"), { recursive: true });
      writeFileSync(path.join(dir, "references", "a.md"), "# a\n");
    }
    return { root, routerPath: path.join(dir, "SKILL.md") };
  }

  /** Seed the PRE-GUARD shape: a lifecycle revision with a durable blob but no
   * manifest and no bundle head — what an instance provisioned before this fix
   * carries. Returns nothing; the caller drives capture to install the head. */
  async function seedPreS1Lifecycle(skillId: string, revisionId: string): Promise<void> {
    const digest = sha(Buffer.from(ROUTER_BODY, "utf8"));
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revision_contents" (content_digest, content, byte_length)
       VALUES ($1,$2,octet_length($2)) ON CONFLICT (content_digest) DO NOTHING`,
      [digest, ROUTER_BODY],
    );
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revisions" (id, skill_id, content_digest, source) VALUES ($1,$2,$3,'manual')`,
      [revisionId, skillId, digest],
    );
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skills" (id, payload, active_revision_id) VALUES ($1,'{}',$2)`,
      [skillId, revisionId],
    );
  }

  const headOf = async (skillId: string) =>
    (
      await client.query(
        `SELECT revision_id, bundle_digest FROM "${TEST_SCHEMA}"."skill_bundle_heads" WHERE skill_id = $1`,
        [skillId],
      )
    ).rows[0] as { revision_id: string; bundle_digest: string } | undefined;

  it("HEALS a head the pre-guard seed minted, once disk ships more than the router", async () => {
    const SKILL = "heal-seeded-2094";
    const REV = "rev-heal-seeded-2094";
    await seedPreS1Lifecycle(SKILL, REV);

    // 1. The pre-guard instance shape, produced by the REAL seed path: capture
    //    with a single-file disk bundle seeds the router-only lifecycle head.
    const single = materializeSkill("heal-seeded-1", false);
    try {
      const first = await store.captureSkillBundleFromDisk(SKILL, single.routerPath);
      expect(first.revisionId).toBe(REV); // adopted the lifecycle head
      expect((await headOf(SKILL))!.revision_id).toBe(REV);
      expect(store.readCurrentSkillBundleFromDatabase(SKILL)!.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    } finally {
      rmSync(single.root, { recursive: true, force: true });
    }

    // 2. The skill's real bundle ships a one-hop reference. BEFORE the fix this
    //    reported authorityOwnedDivergence forever and the manifest could never
    //    grow, so S2's fail-closed lint refused the skill on every sync.
    const multi = materializeSkill("heal-seeded-2", true);
    try {
      const healed = await store.captureSkillBundleFromDisk(SKILL, multi.routerPath);
      expect(healed.changed).toBe(true);
      expect(healed.authorityOwnedDivergence).toBe(false);
      expect(healed.revisionId).toMatch(/^bundle:/);
      expect(healed.lint.ok).toBe(true);
      const current = store.readCurrentSkillBundleFromDatabase(SKILL)!;
      expect([...current.files.map((f) => f.path)].sort()).toEqual(["SKILL.md", "references/a.md"].sort());
      // Idempotent: a re-capture of the healed head changes nothing.
      const again = await store.captureSkillBundleFromDisk(SKILL, multi.routerPath);
      expect(again.changed).toBe(false);
      expect(again.revisionId).toBe(healed.revisionId);
    } finally {
      rmSync(multi.root, { recursive: true, force: true });
    }
  });

  it("does NOT heal a DELIBERATE custom/personal bundle-of-one head (codex blocker 1)", async () => {
    // Identical row SHAPE to the seed head — one manifest row, a multi-file disk
    // directory (the custom write path rewrites only SKILL.md and leaves any
    // sibling in place). What differs is durable provenance: the lifecycle write
    // STAMPED skill_revisions.bundle_digest at INSERT, which the seed cannot.
    const SKILL = "heal-custom-bundle-of-one-2094";
    const REV = "rev-heal-custom-2094";
    const lifecycle = await import("../../skill-lifecycle-store");
    await client.query(`INSERT INTO "${TEST_SCHEMA}"."skills" (id, payload) VALUES ($1,'{}')`, [SKILL]);
    lifecycle.recordSkillRevisionInDatabase({
      skillId: SKILL,
      revisionId: REV,
      contentDigest: sha(Buffer.from(ROUTER_BODY, "utf8")),
      source: "manual",
      basedOnSkillIds: null,
      baseDigests: null,
      authorUserId: "user-1",
      content: ROUTER_BODY,
      bundleFiles: [{ path: "SKILL.md", bytes: Buffer.from(ROUTER_BODY, "utf8"), isRouter: true }],
      initialState: "active",
    });
    const stamped = await client.query(
      `SELECT bundle_digest FROM "${TEST_SCHEMA}"."skill_revisions" WHERE id = $1`,
      [REV],
    );
    expect(stamped.rows[0].bundle_digest).not.toBeNull(); // the discriminator

    const multi = materializeSkill("heal-custom", true);
    try {
      const cap = await store.captureSkillBundleFromDisk(SKILL, multi.routerPath);
      expect(cap.authorityOwnedDivergence).toBe(true);
      expect(cap.changed).toBe(false);
      expect(cap.revisionId).toBe(REV);
      // The authority head — and therefore what byte-bound sync uploads — is
      // untouched: still the stored bundle of one.
      expect((await headOf(SKILL))!.revision_id).toBe(REV);
      expect(store.readCurrentSkillBundleFromDatabase(SKILL)!.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    } finally {
      rmSync(multi.root, { recursive: true, force: true });
    }
  });

  it("does NOT heal a PRE-S1 CUSTOM/PERSONAL skill seeded by the core__0029 lineage", async () => {
    // The exact lineage codex round 3 named. `core__0029` activated pre-S1
    // custom/personal skills and seeded each a `migration:<id>` revision — NULL
    // `bundle_digest`, no manifest — so such a skill reaches the seed with the
    // SAME row shape a derived one does. A single stray sibling in its directory
    // (an old reference, editor residue) makes it look multi-file. For this class
    // the DB is the content authority, so the bundle-of-one head is the seed's
    // CORRECT re-baseline and healing it would be the authority violation.
    const SKILL = "heal-pre-s1-custom-2094";
    const REV = `migration:${SKILL}`;
    const digest = sha(Buffer.from(ROUTER_BODY, "utf8"));
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revision_contents" (content_digest, content, byte_length)
       VALUES ($1,$2,octet_length($2)) ON CONFLICT (content_digest) DO NOTHING`,
      [digest, ROUTER_BODY],
    );
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revisions" (id, skill_id, content_digest, source) VALUES ($1,$2,$3,'migration')`,
      [REV, SKILL, digest],
    );
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skills" (id, payload, lifecycle_state, active_revision_id) VALUES ($1,$2,'active',$3)`,
      [SKILL, JSON.stringify({ packageId: "custom:personal-skills", isPersonal: true }), REV],
    );

    // The FIRST capture already sees the residue — no prior single-file capture
    // to install a head. The multi-file seed SKIP must not apply here, or the
    // skill is left head-less and the capture INSERTs a disk-derived head over
    // its DB-authoritative revision with nothing to guard against.
    const withResidue = materializeSkill("heal-pre-s1-custom-1", true);
    try {
      const cap = await store.captureSkillBundleFromDisk(SKILL, withResidue.routerPath);
      expect(cap.authorityOwnedDivergence).toBe(true);
      expect(cap.changed).toBe(false);
      expect(cap.revisionId).toBe(REV);
      expect((await headOf(SKILL))!.revision_id).toBe(REV);
      expect(store.readCurrentSkillBundleFromDatabase(SKILL)!.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    } finally {
      rmSync(withResidue.root, { recursive: true, force: true });
    }
    // And it stays refused on every later capture.
    const again = materializeSkill("heal-pre-s1-custom-2", true);
    try {
      const cap = await store.captureSkillBundleFromDisk(SKILL, again.routerPath);
      expect(cap.authorityOwnedDivergence).toBe(true);
      expect((await headOf(SKILL))!.revision_id).toBe(REV);
    } finally {
      rmSync(again.root, { recursive: true, force: true });
    }
  });

  it("the CAS refuses the heal when the skill ENTERS the custom class underneath it", async () => {
    // codex round-4: `compileAndRegisterAgentSkillsViaPg` flips a catalog row into
    // the custom class with a bare `ON CONFLICT ... DO UPDATE SET payload` — no
    // revision, no head write — so a head-only CAS would not notice. The ownership
    // CTE locks and re-checks the classified payload in the same statement.
    const SKILL = "heal-payload-cas-2094";
    const SEED_REV = "rev-heal-payload-cas-2094";
    const routerFile = { path: "SKILL.md", bytes: Buffer.from(ROUTER_BODY, "utf8"), isRouter: true };
    const originalPayload = JSON.stringify({ packageId: "@cinatra-ai/chat" });
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revisions" (id, skill_id, source) VALUES ($1,$2,'manual')`,
      [SEED_REV, SKILL],
    );
    await client.query(`INSERT INTO "${TEST_SCHEMA}"."skills" (id, payload) VALUES ($1,$2)`, [
      SKILL,
      originalPayload,
    ]);
    const seedDigest = store.writeRevisionBundleToDatabase({
      revisionId: SEED_REV,
      skillId: SKILL,
      files: [routerFile],
    });

    const diskFiles = [routerFile, { path: "references/a.md", bytes: Buffer.from("# a\n", "utf8") }];
    const derivedRev = store.derivedBundleRevisionId(SKILL, store.bundleDigestForFiles(diskFiles));
    const casHead = store
      .buildRevisionBundleQueries(TEST_SCHEMA, { revisionId: derivedRev, skillId: SKILL, files: diskFiles }, {
        headGuard: { cas: { revisionId: SEED_REV, bundleDigest: seedDigest, skillPayload: originalPayload } },
      })
      .at(-1)!;

    // The raw catalog writer flips the class AFTER the classification was read.
    await client.query(`UPDATE "${TEST_SCHEMA}"."skills" SET payload = $2 WHERE id = $1`, [
      SKILL,
      JSON.stringify({ packageId: "custom:agent-skills", isCustomSkill: true }),
    ]);

    const applied = await client.query(casHead.text, (casHead.values ?? []) as never[]);
    expect(applied.rowCount).toBe(0);
    expect((await headOf(SKILL))!.revision_id).toBe(SEED_REV);
  });

  it("does NOT heal a ROLLBACK head, whose bundle_digest is legitimately NULL", async () => {
    // A rollback restoring a PRE-S1 target copies that target's NULL identity
    // onto the new revision while writing its manifest — so it presents every
    // other signature of the defective seed. `source='rollback'` is what keeps a
    // deliberate authority decision safe from the heal.
    const SKILL = "heal-rollback-2094";
    const TARGET_REV = "rev-heal-rollback-target-2094";
    const ROLLBACK_REV = "rev-heal-rollback-2094";
    const digest = sha(Buffer.from(ROUTER_BODY, "utf8"));
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revision_contents" (content_digest, content, byte_length)
       VALUES ($1,$2,octet_length($2)) ON CONFLICT (content_digest) DO NOTHING`,
      [digest, ROUTER_BODY],
    );
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revisions" (id, skill_id, content_digest, source) VALUES ($1,$2,$3,'manual')`,
      [TARGET_REV, SKILL, digest],
    );
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revisions" (id, skill_id, content_digest, source, restores_revision_id)
       VALUES ($1,$2,$3,'rollback',$4)`,
      [ROLLBACK_REV, SKILL, digest, TARGET_REV],
    );
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skills" (id, payload, active_revision_id) VALUES ($1,'{}',$2)`,
      [SKILL, ROLLBACK_REV],
    );
    // The rollback's own bundle-of-one manifest + head (what the rollback CTE
    // and the pre-S1 arm of applySkillRollbackInDatabase write).
    store.writeRevisionBundleToDatabase({
      revisionId: ROLLBACK_REV,
      skillId: SKILL,
      files: [{ path: "SKILL.md", bytes: Buffer.from(ROUTER_BODY, "utf8"), isRouter: true }],
    });

    const multi = materializeSkill("heal-rollback", true);
    try {
      const cap = await store.captureSkillBundleFromDisk(SKILL, multi.routerPath);
      expect(cap.authorityOwnedDivergence).toBe(true);
      expect((await headOf(SKILL))!.revision_id).toBe(ROLLBACK_REV);
    } finally {
      rmSync(multi.root, { recursive: true, force: true });
    }
  });

  it("does NOT heal a head with ZERO manifest rows (codex blocker 2, second half)", async () => {
    // The retired `NOT EXISTS` predicate meant "carries no NON-ROUTER file", so an
    // empty manifest satisfied it. An empty manifest is an unresolvable head that
    // every read already fails closed on, not a seed to heal.
    const SKILL = "heal-empty-manifest-2094";
    const REV = "rev-heal-empty-2094";
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_revisions" (id, skill_id, source) VALUES ($1,$2,'manual')`,
      [REV, SKILL],
    );
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skills" (id, payload, active_revision_id) VALUES ($1,'{}',$2)`,
      [SKILL, REV],
    );
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."skill_bundle_heads" (skill_id, revision_id, bundle_digest) VALUES ($1,$2,'no-manifest')`,
      [SKILL, REV],
    );

    const multi = materializeSkill("heal-empty", true);
    try {
      const cap = await store.captureSkillBundleFromDisk(SKILL, multi.routerPath);
      expect(cap.authorityOwnedDivergence).toBe(true);
      expect((await headOf(SKILL))!.revision_id).toBe(REV);
    } finally {
      rmSync(multi.root, { recursive: true, force: true });
    }
  });

  it("still heals after a lifecycle PURE STATE RE-RECORD moved the active pointer", async () => {
    // codex round-2 finding: a lifecycle write with no `bundleFiles` moves
    // `skills.active_revision_id` while leaving the bundle head untouched. The
    // classification deliberately does NOT read that pointer — it is mutable, and
    // a head-row CAS cannot protect it — so this interleaving has no stale
    // premise to lose. It is also the right OUTCOME: the new revision recorded no
    // file set at all, so the bundle authority still holds nothing but the seed's
    // router-only manifest, and the head is still exactly the one to heal.
    const SKILL = "heal-after-state-rerecord-2094";
    const REV = "rev-heal-rerecord-2094";
    const LATER_REV = "rev-heal-rerecord-later-2094";
    await seedPreS1Lifecycle(SKILL, REV);
    const single = materializeSkill("heal-rerecord-1", false);
    try {
      await store.captureSkillBundleFromDisk(SKILL, single.routerPath); // installs the seed head
    } finally {
      rmSync(single.root, { recursive: true, force: true });
    }
    // The pure state re-record: a revision with NO file set; the pointer moves,
    // the head does not.
    const lifecycle = await import("../../skill-lifecycle-store");
    lifecycle.recordSkillRevisionInDatabase({
      skillId: SKILL,
      revisionId: LATER_REV,
      contentDigest: null,
      source: "manual",
      basedOnSkillIds: null,
      baseDigests: null,
      authorUserId: null,
      bundleFiles: null,
      initialState: "active",
    });
    expect((await headOf(SKILL))!.revision_id).toBe(REV); // head untouched

    const multi = materializeSkill("heal-rerecord-2", true);
    try {
      const healed = await store.captureSkillBundleFromDisk(SKILL, multi.routerPath);
      expect(healed.changed).toBe(true);
      expect(healed.revisionId).toMatch(/^bundle:/);
      expect([...store.readCurrentSkillBundleFromDatabase(SKILL)!.files.map((f) => f.path)].sort()).toEqual(
        ["SKILL.md", "references/a.md"].sort(),
      );
    } finally {
      rmSync(multi.root, { recursive: true, force: true });
    }
  });

  it("target-row CAS: a CONCURRENT authority head write is never clobbered (real transaction race)", async () => {
    // codex blocker 2, driven as the exact interleaving it describes, on a real
    // server at READ COMMITTED:
    //   T2 (lifecycle) BEGIN → writes a new head + its manifest → NOT yet committed
    //   T1 (capture)   BEGIN → issues its guarded head UPSERT → BLOCKS on the row lock
    //   T2 COMMIT      → T1 wakes and re-evaluates its guard
    // T1's statement snapshot predates T2's commit, so T2's MANIFEST rows are
    // invisible to it — which is precisely why a manifest SUBQUERY guard passes
    // here and clobbers. A CAS over the head row's OWN columns sees the updated
    // row and refuses.
    const SKILL = "race-cas-2094";
    const SEED_REV = "rev-race-seed-2094";
    const LIFECYCLE_REV = "rev-race-lifecycle-2094";
    const routerFile = { path: "SKILL.md", bytes: Buffer.from(ROUTER_BODY, "utf8"), isRouter: true };
    const payload = JSON.stringify({ packageId: "@cinatra-ai/chat" });
    await client.query(`INSERT INTO "${TEST_SCHEMA}"."skills" (id, payload) VALUES ($1,$2)`, [SKILL, payload]);
    const seedDigest = store.writeRevisionBundleToDatabase({
      revisionId: SEED_REV,
      skillId: SKILL,
      files: [routerFile],
    });

    const diskFiles = [routerFile, { path: "references/a.md", bytes: Buffer.from("# a\n", "utf8") }];
    const derivedRev = store.derivedBundleRevisionId(SKILL, store.bundleDigestForFiles(diskFiles));
    const casHead = store
      .buildRevisionBundleQueries(TEST_SCHEMA, { revisionId: derivedRev, skillId: SKILL, files: diskFiles }, {
        headGuard: { cas: { revisionId: SEED_REV, bundleDigest: seedDigest, skillPayload: payload } },
      })
      .at(-1)!;
    // What the concurrent lifecycle write installs — a REAL authority head with a
    // multi-file manifest of its own.
    const lifecycleQueries = store.buildRevisionBundleQueries(
      TEST_SCHEMA,
      {
        revisionId: LIFECYCLE_REV,
        skillId: SKILL,
        files: [routerFile, { path: "references/b.md", bytes: Buffer.from("# b\n", "utf8") }],
      },
      { headGuard: "always" },
    );

    const t1 = new Client({ connectionString: DB_URL });
    const t2 = new Client({ connectionString: DB_URL });
    await t1.connect();
    await t2.connect();
    try {
      await t2.query("BEGIN");
      for (const q of lifecycleQueries) await t2.query(q.text, (q.values ?? []) as never[]);
      await t1.query("BEGIN");
      const blocked = t1.query(casHead.text, (casHead.values ?? []) as never[]);
      await new Promise((r) => setTimeout(r, 250)); // let T1 reach the row lock
      await t2.query("COMMIT");
      const applied = await blocked;
      await t1.query("COMMIT");
      // The CAS matched nothing: zero rows written by the upsert.
      expect(applied.rowCount).toBe(0);
      expect((await headOf(SKILL))!.revision_id).toBe(LIFECYCLE_REV);
    } finally {
      await t1.end().catch(() => {});
      await t2.end().catch(() => {});
    }
  });

  it("the RETIRED manifest-subquery guard clobbers under that same interleaving", async () => {
    // A characterization test for the shape this branch removed. It is what makes
    // the CAS above load-bearing rather than a style preference: the identical
    // interleaving, with the only difference being the guard's shape, loses a
    // freshly committed authority head.
    const SKILL = "race-subquery-2094";
    const SEED_REV = "rev-race-sub-seed-2094";
    const LIFECYCLE_REV = "rev-race-sub-lifecycle-2094";
    const routerFile = { path: "SKILL.md", bytes: Buffer.from(ROUTER_BODY, "utf8"), isRouter: true };
    store.writeRevisionBundleToDatabase({ revisionId: SEED_REV, skillId: SKILL, files: [routerFile] });

    const diskFiles = [routerFile, { path: "references/a.md", bytes: Buffer.from("# a\n", "utf8") }];
    const derivedRev = store.derivedBundleRevisionId(SKILL, store.bundleDigestForFiles(diskFiles));
    const retiredGuardHead = {
      text: `INSERT INTO "${TEST_SCHEMA}"."skill_bundle_heads" (skill_id, revision_id, bundle_digest, updated_at)
        VALUES ($1,$2,$3, now())
        ON CONFLICT (skill_id) DO UPDATE
          SET revision_id = EXCLUDED.revision_id, bundle_digest = EXCLUDED.bundle_digest, updated_at = now()
        WHERE "${TEST_SCHEMA}"."skill_bundle_heads".revision_id LIKE 'bundle:%'
           OR NOT EXISTS (
                SELECT 1 FROM "${TEST_SCHEMA}"."skill_revision_files" f
                 WHERE f.revision_id = "${TEST_SCHEMA}"."skill_bundle_heads".revision_id
                   AND f.skill_id = "${TEST_SCHEMA}"."skill_bundle_heads".skill_id
                   AND f.path <> 'SKILL.md')`,
      values: [SKILL, derivedRev, store.bundleDigestForFiles(diskFiles)],
    };
    const lifecycleQueries = store.buildRevisionBundleQueries(
      TEST_SCHEMA,
      {
        revisionId: LIFECYCLE_REV,
        skillId: SKILL,
        files: [routerFile, { path: "references/b.md", bytes: Buffer.from("# b\n", "utf8") }],
      },
      { headGuard: "always" },
    );

    const t1 = new Client({ connectionString: DB_URL });
    const t2 = new Client({ connectionString: DB_URL });
    await t1.connect();
    await t2.connect();
    try {
      await t2.query("BEGIN");
      for (const q of lifecycleQueries) await t2.query(q.text, (q.values ?? []) as never[]);
      await t1.query("BEGIN");
      const blocked = t1.query(retiredGuardHead.text, retiredGuardHead.values as never[]);
      await new Promise((r) => setTimeout(r, 250));
      await t2.query("COMMIT");
      await blocked;
      await t1.query("COMMIT");
      // The authority head T2 had just committed is GONE.
      expect((await headOf(SKILL))!.revision_id).toBe(derivedRev);
    } finally {
      await t1.end().catch(() => {});
      await t2.end().catch(() => {});
    }
  });
});

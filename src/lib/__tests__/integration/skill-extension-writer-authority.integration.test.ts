/**
 * cinatra#2274 — the EXTENSION-SKILL REGISTRATION WRITER, driven END TO END
 * against a REAL Postgres and a REAL filesystem.
 *
 * `registerColocatedWorkspaceSkills` -> `registerExtensionSkill` -> `upsertSkill`
 * used to record a lifecycle revision whose file set was a BUNDLE OF ONE (the
 * SKILL.md router) with a non-NULL `bundle_digest` and an AUTHORITY-OWNED head
 * over it — even when the package's disk bundle is a router PLUS one-hop
 * `references/*`. Every later `captureSkillBundleFromDisk` then classified the
 * skill as an `authorityOwnedDivergence` and never advanced the head, S2's
 * fail-closed one-hop lint (#2089) refused it as an upload candidate, and
 * cinatra#2254's honesty rule turned that into a FAILED `initial-sync`.
 *
 * Runs the REAL writer (no mock on the store/DB path — `@/lib/database` is
 * un-stubbed below) so the assertions are about the shipped code path, not a
 * reconstruction of it. Guarded by `describe.skipIf(!HAS_REAL_DB)` and by the
 * `*.integration.test.ts` tier, exactly like the sibling suite:
 *
 *   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
 *     pnpm exec vitest run src/lib/__tests__/integration/skill-extension-writer-authority.integration.test.ts
 *
 * What it proves, per acceptance criterion:
 *   AC1  the head manifest's sorted (path, content_digest) SET EQUALS the set
 *        computed from the on-disk bundle — set equality, never a file count;
 *   AC2  the S2 one-hop lint — UNCHANGED and still fail-closed — accepts the
 *        stored bundle, because the bundle is now correct;
 *   AC5  a second registration pass records NO new revision and leaves the head
 *        where it stands;
 *   AC6  a single-file control stays a bundle of one, and a `references/*`
 *        DROPPED upstream leaves the skill undiverged;
 *   AC7  the option taken is (A) writer-owned: the payload class stays
 *        `custom:<slug>` and the head stays AUTHORITY-OWNED — asserted, so a
 *        future reader can tell this fix apart from cinatra#2265's;
 *   AC8  cinatra#2254's heal predicate still identifies exactly what it was
 *        built for: this writer's revision is `bundle_digest`-STAMPED, so it is
 *        outside the predicate, and a disk drift the writer did NOT record is
 *        still refused rather than healed.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

// The ROOT vitest config aliases `@/lib/database` to a STUB. This suite needs
// the REAL module — the whole point is that `upsertSkill`'s catalog+lifecycle
// transaction lands in a real schema. A relative import bypasses the alias.
vi.mock("@/lib/database", async () => await import("../../database"));
// Not an RSC context, and the git-backed skill store is irrelevant here.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../../../packages/skills/src/storage/git-commit", () => ({
  commitSkillChange: vi.fn(async () => undefined),
}));
// Keep a real `extensions/` disk scan from crowding the catalog this suite
// asserts over; every other helper in the module passes through.
vi.mock("../../../../packages/skills/src/skill-packages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/skills/src/skill-packages")>();
  return { ...actual, installedSkillPackages: [] };
});

const TEST_SCHEMA = "cinatra_test_skill_ext_writer_2274";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe.skipIf(!HAS_REAL_DB)("cinatra#2274 extension-writer content authority (real DB + disk)", () => {
  let client: Client;
  let priorSchemaEnv: string | undefined;
  let store: typeof import("../../skill-bundle-store");
  let writer: typeof import("../../../../packages/skills/src/register-extension-skill");
  let tmpRoot: string;

  /** The extensions tree the writer reads FROM. */
  let extensionsRoot: string;

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

    tmpRoot = mkdtempSync(path.join(tmpdir(), "cinatra-2274-int-"));
    extensionsRoot = path.join(tmpRoot, "extensions");
    mkdirSync(extensionsRoot, { recursive: true });

    store = await import("../../skill-bundle-store");
    const skillsStore = await import("../../../../packages/skills/src/skills-store");
    // Pin the skill data + store roots into the TEMP tree before any write, so
    // `upsertSkill` materializes the canonical SKILL.md there and nothing
    // touches the repo's own data/.
    skillsStore.writeSkillsStorageConfig({
      dataPath: path.join(tmpRoot, "data", "skills"),
      storePath: path.join(tmpRoot, "data", "skill-store"),
    });
    writer = await import("../../../../packages/skills/src/register-extension-skill");
  }, 60_000);

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await client?.end().catch(() => {});
    delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
    if (priorSchemaEnv === undefined) delete process.env.SUPABASE_SCHEMA;
    else process.env.SUPABASE_SCHEMA = priorSchemaEnv;
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  }, 60_000);

  /** Materialize `extensions/<vendor>/<pkg>/skills/<slug>/` with `files`. */
  function materializeBundle(pkgDir: string, slug: string, files: Record<string, string>): string {
    const bundleDir = path.join(extensionsRoot, "acme", pkgDir, "skills", slug);
    rmSync(bundleDir, { recursive: true, force: true });
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(bundleDir, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, body, "utf8");
    }
    return path.join(bundleDir, "SKILL.md");
  }

  /** Every regular file under `dir`, POSIX-relative and sorted. */
  function listTree(dir: string): string[] {
    const out: string[] = [];
    (function walk(current: string) {
      for (const e of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, e.name);
        if (e.isDirectory()) walk(full);
        else out.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    })(dir);
    return out.sort();
  }

  /** The `(path, digest)` set the AUTHORITY carries for a skill. */
  function storedManifestSet(skillId: string): Array<[string, string]> {
    const bundle = store.readCurrentSkillBundleFromDatabase(skillId)!;
    return bundle.files.map((f) => [f.path, f.digest] as [string, string]).sort();
  }

  /** The `(path, digest)` set the DISK carries under a skill's canonical dir. */
  async function diskManifestSet(skillMdPath: string): Promise<Array<[string, string]>> {
    const files = await store.readSkillDirectoryAsBundleFiles(skillMdPath);
    return files
      .map((f) => [f.path.split(path.sep).join("/"), sha(f.bytes)] as [string, string])
      .sort();
  }

  async function headOf(skillId: string) {
    const r = await client.query(
      `SELECT revision_id, bundle_digest FROM "${TEST_SCHEMA}"."skill_bundle_heads" WHERE skill_id = $1`,
      [skillId],
    );
    return r.rows[0] as { revision_id: string; bundle_digest: string } | undefined;
  }

  const ROUTER = (extra: string) =>
    `---\nname: Router\ndescription: A router.\n---\n# Router\n${extra}\n`;

  it("AC1/AC2/AC7: a MULTI-FILE bundle registers under an AUTHORITY head whose manifest EQUALS the disk set", async () => {
    const skillId = "@acme/multi-skill:router-skill";
    const skillMd = materializeBundle("multi-skill", "router-skill", {
      "SKILL.md": ROUTER("See [a](references/a.md) and [b](references/b.md)."),
      "references/a.md": "# a\n",
      "references/b.md": "# b\n",
    });

    const { sourcePath } = await writer.registerExtensionSkill({
      skillId,
      packageName: "@acme/multi-skill",
      skillMdPath: skillMd,
    });

    // AC7 — option (A), writer-owned: the CLASS is unchanged (`custom:<slug>`)
    // and the head is AUTHORITY-owned. This is what distinguishes the fix from
    // cinatra#2265's (which established authority for a writer that had none).
    const catalog = await client.query(
      `SELECT payload, active_revision_id FROM "${TEST_SCHEMA}"."skills" WHERE id = $1`,
      [skillId],
    );
    expect(JSON.parse(catalog.rows[0].payload).packageId).toMatch(/^custom:/);
    const revisionId = catalog.rows[0].active_revision_id as string;
    const head = await headOf(skillId);
    expect(head!.revision_id).toBe(revisionId);
    expect(store.isDerivedBundleRevisionId(head!.revision_id)).toBe(false);

    // AC1 — SET EQUALITY over `(path, content_digest)`, not a file count. The
    // measured defect shape (`head_manifest_files=1` for every row) would pass a
    // count-only check as soon as a second file appeared; only the set proves
    // the head describes THIS bundle.
    expect(storedManifestSet(skillId)).toEqual(await diskManifestSet(sourcePath));
    expect(storedManifestSet(skillId).map(([p]) => p)).toEqual([
      "SKILL.md",
      "references/a.md",
      "references/b.md",
    ]);

    // The revision identity is STAMPED at INSERT (append-only), and it is the
    // head's — so nothing downstream has to recompute it to agree.
    const rev = await client.query(
      `SELECT bundle_digest, content_digest FROM "${TEST_SCHEMA}"."skill_revisions" WHERE id = $1 AND skill_id = $2`,
      [revisionId, skillId],
    );
    expect(rev.rows[0].bundle_digest).toBe(head!.bundle_digest);

    // ONE SNAPSHOT: the lifecycle content blob IS the manifest's router bytes.
    const blob = await client.query(
      `SELECT content FROM "${TEST_SCHEMA}"."skill_revision_contents" WHERE content_digest = $1`,
      [rev.rows[0].content_digest],
    );
    const stored = store.readCurrentSkillBundleFromDatabase(skillId)!;
    expect(stored.files.find((f) => f.isRouter)!.bytes.toString("utf8")).toBe(blob.rows[0].content);

    // AC2 — the S2 fail-closed one-hop lint, run over the STORED bytes exactly
    // as `buildSyncCandidatesWithRefusals` does. It is UNCHANGED; it stops
    // refusing because the bundle it lints is now correct.
    const lint = store.lintBundleRouterReferences(
      stored.files.find((f) => f.isRouter)!.bytes.toString("utf8"),
      stored.files.map((f) => f.path),
    );
    expect(lint).toEqual({ ok: true, missing: [] });

    // COMPOSITION with cinatra#2279's capture path: the seed adopts this head,
    // reports no divergence, and names no unresolved lifecycle content.
    const cap = await store.captureSkillBundleFromDisk(skillId, sourcePath);
    expect(cap.changed).toBe(false);
    expect(cap.authorityOwnedDivergence).toBe(false);
    expect(cap.revisionId).toBe(revisionId);
    expect(cap.unresolvedLifecycleContent).toBeNull();
    expect(cap.lint.ok).toBe(true);
    expect((await headOf(skillId))!.revision_id).toBe(revisionId);
  });

  it("AC5: a SECOND registration pass records no new revision and does not move the head", async () => {
    const skillId = "@acme/idem-skill:router-skill";
    const skillMd = materializeBundle("idem-skill", "router-skill", {
      "SKILL.md": ROUTER("See [a](references/a.md)."),
      "references/a.md": "# a\n",
    });
    await writer.registerExtensionSkill({ skillId, packageName: "@acme/idem-skill", skillMdPath: skillMd });
    const first = await headOf(skillId);

    // A boot re-scan / the lazy resolver / the llm-bridge route all land here.
    await writer.registerExtensionSkill({ skillId, packageName: "@acme/idem-skill", skillMdPath: skillMd });
    await writer.registerExtensionSkill({ skillId, packageName: "@acme/idem-skill", skillMdPath: skillMd });

    const revCount = await client.query(
      `SELECT count(*)::int AS n FROM "${TEST_SCHEMA}"."skill_revisions" WHERE skill_id = $1`,
      [skillId],
    );
    expect(revCount.rows[0].n).toBe(1);
    const after = await headOf(skillId);
    expect(after!.revision_id).toBe(first!.revision_id);
    expect(after!.bundle_digest).toBe(first!.bundle_digest);
    // And it never regresses to a bundle of one.
    expect(storedManifestSet(skillId).map(([p]) => p)).toEqual(["SKILL.md", "references/a.md"]);
  });

  it("AC6 control: a SINGLE-FILE bundle stays a bundle of ONE and is still accepted", async () => {
    const skillId = "@acme/solo-skill:router-skill";
    const skillMd = materializeBundle("solo-skill", "router-skill", {
      "SKILL.md": ROUTER("No references here."),
    });
    const { sourcePath } = await writer.registerExtensionSkill({
      skillId,
      packageName: "@acme/solo-skill",
      skillMdPath: skillMd,
    });

    expect(storedManifestSet(skillId).map(([p]) => p)).toEqual(["SKILL.md"]);
    expect(storedManifestSet(skillId)).toEqual(await diskManifestSet(sourcePath));
    const cap = await store.captureSkillBundleFromDisk(skillId, sourcePath);
    expect(cap.authorityOwnedDivergence).toBe(false);
    expect(cap.lint.ok).toBe(true);
  });

  it("AC6 stale case: a reference DROPPED upstream leaves the skill UNDIVERGED", async () => {
    const skillId = "@acme/drop-skill:router-skill";
    materializeBundle("drop-skill", "router-skill", {
      "SKILL.md": ROUTER("See [a](references/a.md) and [b](references/b.md)."),
      "references/a.md": "# a\n",
      "references/b.md": "# b\n",
    });
    let reg = await writer.registerExtensionSkill({
      skillId,
      packageName: "@acme/drop-skill",
      skillMdPath: materializeBundle("drop-skill", "router-skill", {
        "SKILL.md": ROUTER("See [a](references/a.md) and [b](references/b.md)."),
        "references/a.md": "# a\n",
        "references/b.md": "# b\n",
      }),
    });
    expect(listTree(path.dirname(reg.sourcePath))).toEqual([
      "SKILL.md",
      "references/a.md",
      "references/b.md",
    ]);

    // `references/b.md` is deleted upstream and the router stops naming it. The
    // copy-only mirror used to leave the stale leaf in the canonical dir, which
    // — now that the writer records the REAL set — would make capture hash a
    // file set the authority never described and pin the skill diverged.
    reg = await writer.registerExtensionSkill({
      skillId,
      packageName: "@acme/drop-skill",
      skillMdPath: materializeBundle("drop-skill", "router-skill", {
        "SKILL.md": ROUTER("See [a](references/a.md)."),
        "references/a.md": "# a\n",
      }),
    });

    expect(listTree(path.dirname(reg.sourcePath))).toEqual(["SKILL.md", "references/a.md"]);
    expect(storedManifestSet(skillId).map(([p]) => p)).toEqual(["SKILL.md", "references/a.md"]);
    expect(storedManifestSet(skillId)).toEqual(await diskManifestSet(reg.sourcePath));
    const cap = await store.captureSkillBundleFromDisk(skillId, reg.sourcePath);
    expect(cap.authorityOwnedDivergence).toBe(false);
    expect(cap.changed).toBe(false);
    expect(cap.lint.ok).toBe(true);
  });

  it("a CHANGED reference mints a new authority revision and ADVANCES the head", async () => {
    const skillId = "@acme/change-skill:router-skill";
    await writer.registerExtensionSkill({
      skillId,
      packageName: "@acme/change-skill",
      skillMdPath: materializeBundle("change-skill", "router-skill", {
        "SKILL.md": ROUTER("See [a](references/a.md)."),
        "references/a.md": "# a v1\n",
      }),
    });
    const before = await headOf(skillId);

    const reg = await writer.registerExtensionSkill({
      skillId,
      packageName: "@acme/change-skill",
      skillMdPath: materializeBundle("change-skill", "router-skill", {
        "SKILL.md": ROUTER("See [a](references/a.md)."),
        "references/a.md": "# a v2\n",
      }),
    });

    const after = await headOf(skillId);
    expect(after!.revision_id).not.toBe(before!.revision_id);
    expect(after!.bundle_digest).not.toBe(before!.bundle_digest);
    expect(store.isDerivedBundleRevisionId(after!.revision_id)).toBe(false);
    expect(storedManifestSet(skillId)).toEqual(await diskManifestSet(reg.sourcePath));
  });

  it("delivery is AUTHORITY-sourced: a symlink planted in the canonical dir is replaced, not written through", async () => {
    const skillId = "@acme/link-skill:router-skill";
    const reg = await writer.registerExtensionSkill({
      skillId,
      packageName: "@acme/link-skill",
      skillMdPath: materializeBundle("link-skill", "router-skill", {
        "SKILL.md": ROUTER("See [a](references/a.md)."),
        "references/a.md": "# a\n",
      }),
    });
    const skillDir = path.dirname(reg.sourcePath);
    const outside = path.join(tmpRoot, "outside-secret.md");
    writeFileSync(outside, "# outside\n", "utf8");
    rmSync(path.join(skillDir, "references", "a.md"));
    symlinkSync(outside, path.join(skillDir, "references", "a.md"));

    const again = await writer.registerExtensionSkill({
      skillId,
      packageName: "@acme/link-skill",
      skillMdPath: path.join(extensionsRoot, "acme", "link-skill", "skills", "router-skill", "SKILL.md"),
    });

    // The directory was REPLACED from the content-addressed blobs: the link is
    // gone, the real reference is back, and the link's target is untouched.
    expect(listTree(path.dirname(again.sourcePath))).toEqual(["SKILL.md", "references/a.md"]);
    expect(existsSync(outside)).toBe(true);
    expect(storedManifestSet(skillId)).toEqual(await diskManifestSet(again.sourcePath));
    const cap = await store.captureSkillBundleFromDisk(skillId, again.sourcePath);
    expect(cap.authorityOwnedDivergence).toBe(false);
  });

  it("AC8: cinatra#2254's heal is untouched — a drift the WRITER did not record is refused, not healed", async () => {
    const skillId = "@acme/drift-skill:router-skill";
    const reg = await writer.registerExtensionSkill({
      skillId,
      packageName: "@acme/drift-skill",
      skillMdPath: materializeBundle("drift-skill", "router-skill", {
        "SKILL.md": ROUTER("See [a](references/a.md)."),
        "references/a.md": "# a\n",
      }),
    });
    const before = await headOf(skillId);

    // The revision is `bundle_digest`-STAMPED, which is precisely condition 3 of
    // `readLifecycleSeedHeadProvenance` (`bundle_digest IS NULL`) failing — so
    // the pre-guard-seed heal can never mistake this row for its target.
    const rev = await client.query(
      `SELECT bundle_digest FROM "${TEST_SCHEMA}"."skill_revisions" WHERE id = $1 AND skill_id = $2`,
      [before!.revision_id, skillId],
    );
    expect(rev.rows[0].bundle_digest).not.toBeNull();

    // Someone edits the CANONICAL dir directly (not through the writer).
    writeFileSync(path.join(path.dirname(reg.sourcePath), "references", "a.md"), "# a EDITED\n", "utf8");
    const cap = await store.captureSkillBundleFromDisk(skillId, reg.sourcePath);

    // The DB is the authority for this class: the divergence is REPORTED and the
    // head does NOT move to disk bytes. A real content change arrives through
    // the writer, which advances the head transactionally.
    expect(cap.authorityOwnedDivergence).toBe(true);
    expect((await headOf(skillId))!.revision_id).toBe(before!.revision_id);

    // Re-registering — the writer speaking — resolves it, and the stale edit is
    // replaced by the source bytes.
    const again = await writer.registerExtensionSkill({
      skillId,
      packageName: "@acme/drift-skill",
      skillMdPath: path.join(extensionsRoot, "acme", "drift-skill", "skills", "router-skill", "SKILL.md"),
    });
    const settled = await store.captureSkillBundleFromDisk(skillId, again.sourcePath);
    expect(settled.authorityOwnedDivergence).toBe(false);
    expect(existsSync(path.join(path.dirname(again.sourcePath), "references", "a.md"))).toBe(true);
  });
});

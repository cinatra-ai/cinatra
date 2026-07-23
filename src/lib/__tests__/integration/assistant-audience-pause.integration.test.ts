/**
 * cinatra#1880 W5 — REAL-STORE resolver proofs for the /configuration/assistants
 * permission surfaces (the audience editor + the pause control) and the alias +
 * deletion-guard primitives, exercised against REAL Postgres (no stubs).
 *
 * The writers (`addAssistantAudienceGrant`, `pauseAssistant`, `renameAssistantAlias`,
 * …) and the enforcement reader (`readAssistantRegistryForActor`) both bind
 * `betterAuthDb` to `SUPABASE_SCHEMA` at import, so the test provisions a dedicated
 * schema, sets `SUPABASE_SCHEMA`, and DYNAMICALLY imports both AFTER — proving that
 * an edit through the writer takes effect on the very next reader decision (there is
 * ONE audience truth, so this is the same decision every W2 surface makes).
 * Self-skips without a real SUPABASE_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { assistantHandleSchemaQueries } from "@/lib/assistant-thread-schema";
import { assistantRegistrySchemaQueries, assistantPauseSchemaQueries, BUILTIN_ASSISTANT_ALIAS } from "@/lib/assistant-registry-schema";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused") &&
  !dbUrl.includes("build:build@127.0.0.1:5432/build");
const maybe = hasDb ? describe : describe.skip;

type Reader = typeof import("@/lib/assistant-registry-reader");
type Db = typeof import("@/lib/better-auth-db");
type Users = typeof import("@/lib/assistant-users");

maybe("W5 audience + pause + alias + guard (live)", () => {
  const schema = `w5_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin: Client;
  let reader: Reader;
  let db: Db;
  let users: Users;

  function ctx(over: Partial<import("@/lib/assistant-registry-reader").AssistantAudienceContext> = {}) {
    return {
      userId: "actor-1",
      isPlatformAdmin: false,
      orgIds: new Set<string>(),
      teamIds: new Set<string>(),
      projectIds: new Set<string>(),
      ...over,
    };
  }

  /** Seed a fully-installed assistant (template + principal handle + active install
   *  with a stamped declaration). Returns the principal id. */
  async function seedAssistant(opts: {
    pkg: string;
    handle: string;
    origin?: "extension" | "standalone";
    audience?: Array<{ kind: string; id?: string | null }>;
  }): Promise<string> {
    const principal = `p-${randomUUID()}`;
    await admin.query(
      `INSERT INTO "${schema}".agent_templates (id, name, package_name, agent_kind, assistant_config, assistant_user_id, status)
       VALUES ($1,$2,$3,'assistant','{}',$4,'published')`,
      [`tpl-${randomUUID()}`, opts.handle, opts.pkg, principal],
    );
    await admin.query(
      `INSERT INTO "${schema}".assistant_handles (assistant_user_id, handle, origin, package_name)
       VALUES ($1,$2,$3,$4)`,
      [principal, opts.handle, opts.origin ?? "extension", opts.pkg],
    );
    await admin.query(
      `INSERT INTO "${schema}".installed_extension (id, package_name, kind, status, assistant_declaration)
       VALUES ($1,$2,'agent','active',$3)`,
      [`ie-${randomUUID()}`, opts.pkg, JSON.stringify({ formatVersion: 1 })],
    );
    for (const g of opts.audience ?? []) {
      await admin.query(
        `INSERT INTO "${schema}".assistant_audience (package_name, subject_kind, subject_id) VALUES ($1,$2,$3)`,
        [opts.pkg, g.kind, g.id ?? null],
      );
    }
    return principal;
  }

  // Seed the built-in Cinatra assistant in its RULED shape (owner ruling
  // 2026-07-23 (groganz)): ONE tag, the resolving HANDLE `cinatra`, and NO builtin
  // alias (the fresh-install bootstrap no longer seeds one; core__0077 frees it on
  // upgrades). This is exactly what the boot backfill mints once the `cinatra`
  // token is no longer occupied by a builtin alias.
  async function seedBuiltinCinatra(): Promise<string> {
    const principal = `p-cinatra-${randomUUID()}`;
    await admin.query(
      `INSERT INTO "${schema}".agent_templates (id, name, package_name, agent_kind, assistant_config, assistant_user_id, status)
       VALUES ($1,'Cinatra',$2,'assistant','{}',$3,'published')`,
      [`tpl-cinatra-${randomUUID()}`, BUILTIN_ASSISTANT_ALIAS.packageName, principal],
    );
    await admin.query(
      `INSERT INTO "${schema}".assistant_handles (assistant_user_id, handle, origin, package_name)
       VALUES ($1,'cinatra','standalone',$2)`,
      [principal, BUILTIN_ASSISTANT_ALIAS.packageName],
    );
    return principal;
  }

  const handlesOf = async (over = {}) =>
    (await reader.readAssistantRegistryForActor(ctx(over))).map((e) => e.handle);

  beforeAll(async () => {
    admin = new Client({ connectionString: dbUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const q of [
      ...assistantHandleSchemaQueries(schema),
      ...assistantRegistrySchemaQueries(schema),
      ...assistantPauseSchemaQueries(schema),
    ]) {
      if (q.text.trim().toUpperCase().startsWith("INSERT")) continue;
      await admin.query(q.text);
    }
    await admin.query(`CREATE TABLE "${schema}".agent_templates (
      id text PRIMARY KEY, name text, package_name text,
      agent_kind text NOT NULL DEFAULT 'executor', assistant_config text,
      assistant_user_id text, status text
    )`);
    await admin.query(`CREATE TABLE "${schema}".installed_extension (
      id text PRIMARY KEY, package_name text NOT NULL, kind text NOT NULL,
      status text NOT NULL DEFAULT 'active', assistant_declaration jsonb
    )`);

    process.env.SUPABASE_SCHEMA = schema;
    reader = await import("@/lib/assistant-registry-reader");
    db = await import("@/lib/better-auth-db");
    users = await import("@/lib/assistant-users");
  });

  afterAll(async () => {
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await admin.end();
    }
  });

  beforeEach(async () => {
    await admin.query(
      `TRUNCATE "${schema}".assistant_handles, "${schema}".assistant_tag_alias,
       "${schema}".assistant_audience, "${schema}".assistant_pause,
       "${schema}".agent_templates, "${schema}".installed_extension`,
    );
  });

  // ---- Audience editor (AC#2) ---------------------------------------------

  it("audience grant added through the writer becomes visible on the next reader decision; removed → invisible", async () => {
    const pkg = "@x/aud-assistant";
    await seedAssistant({ pkg, handle: "audbot" }); // NO audience → invisible

    expect(await handlesOf()).not.toContain("audbot");
    await db.addAssistantAudienceGrant(pkg, "workspace");
    expect(await handlesOf()).toContain("audbot"); // takes effect immediately
    await db.removeAssistantAudienceGrant(pkg, "workspace");
    expect(await handlesOf()).not.toContain("audbot");
  });

  it("each scoped subject kind is selectable + persisted, gated on the reader", async () => {
    const pkg = "@x/scoped-assistant";
    await seedAssistant({ pkg, handle: "scopedbot" });
    await db.addAssistantAudienceGrant(pkg, "organization", "org-9");
    await db.addAssistantAudienceGrant(pkg, "team", "team-9");

    const grants = await db.listAssistantAudienceGrants(pkg);
    expect(grants).toEqual(
      expect.arrayContaining([
        { subjectKind: "organization", subjectId: "org-9" },
        { subjectKind: "team", subjectId: "team-9" },
      ]),
    );
    // In-org actor sees it; a bare actor does not.
    expect(await handlesOf({ orgIds: new Set(["org-9"]) })).toContain("scopedbot");
    expect(await handlesOf()).not.toContain("scopedbot");
    // Removing the team grant leaves org; removing both hides it.
    await db.removeAssistantAudienceGrant(pkg, "team", "team-9");
    await db.removeAssistantAudienceGrant(pkg, "organization", "org-9");
    expect(await handlesOf({ orgIds: new Set(["org-9"]) })).not.toContain("scopedbot");
  });

  it("fail-closed: an unknown subject kind is refused by the writer (never persisted)", async () => {
    const pkg = "@x/bad-assistant";
    await seedAssistant({ pkg, handle: "badbot" });
    await expect(db.addAssistantAudienceGrant(pkg, "everyone")).rejects.toThrow(/unknown subject kind/i);
    await expect(db.addAssistantAudienceGrant(pkg, "organization")).rejects.toThrow(/requires a subject id/i);
    expect(await db.listAssistantAudienceGrants(pkg)).toEqual([]);
  });

  it("replaceAssistantAudienceGrants atomically sets the grant set; an invalid grant aborts the whole replace", async () => {
    const pkg = "@x/replace-assistant";
    await seedAssistant({ pkg, handle: "replacebot" }); // NO audience → invisible

    // Replace with a scoped set → the org member sees it, a bare actor does not.
    await db.replaceAssistantAudienceGrants(pkg, [
      { subjectKind: "organization", subjectId: "org-1" },
      { subjectKind: "team", subjectId: "team-1" },
    ]);
    expect(await handlesOf({ orgIds: new Set(["org-1"]) })).toContain("replacebot");
    expect(await handlesOf()).not.toContain("replacebot");

    // Replace with the universal workspace grant → visible to everyone (the prior
    // org/team rows are gone, not unioned).
    await db.replaceAssistantAudienceGrants(pkg, [{ subjectKind: "workspace" }]);
    expect(await handlesOf()).toContain("replacebot");
    expect(await db.listAssistantAudienceGrants(pkg)).toEqual([
      { subjectKind: "workspace", subjectId: null },
    ]);

    // A replace containing an INVALID grant is refused ATOMICALLY — the prior
    // (workspace) set is left untouched (nothing deleted, nothing inserted).
    await expect(
      db.replaceAssistantAudienceGrants(pkg, [{ subjectKind: "everyone" }]),
    ).rejects.toThrow(/unknown subject kind/i);
    expect(await handlesOf()).toContain("replacebot"); // still workspace-visible

    // An EMPTY replace clears the audience → visible to no one (fail-closed).
    await db.replaceAssistantAudienceGrants(pkg, []);
    expect(await handlesOf()).not.toContain("replacebot");
    expect(await db.listAssistantAudienceGrants(pkg)).toEqual([]);
  });

  it("concurrent replaces for the SAME package are serialized (last-writer-wins; never a union)", async () => {
    const pkg = "@x/race-assistant";
    await seedAssistant({ pkg, handle: "racebot" });

    const setA = [{ subjectKind: "organization", subjectId: "org-A" }];
    const setB = [{ subjectKind: "team", subjectId: "team-B" }];
    // Two simultaneous set-replaces on the SAME package. The package-scoped advisory
    // xact lock serializes them, so the committed state is EXACTLY one desired set —
    // never a union of both (which a non-serialized delete-all→insert could produce
    // under READ COMMITTED).
    await Promise.all([
      db.replaceAssistantAudienceGrants(pkg, setA),
      db.replaceAssistantAudienceGrants(pkg, setB),
    ]);

    const final = (await db.listAssistantAudienceGrants(pkg))
      .map((g) => `${g.subjectKind}:${g.subjectId ?? ""}`)
      .sort();
    expect([JSON.stringify(["organization:org-A"]), JSON.stringify(["team:team-B"])]).toContain(
      JSON.stringify(final),
    );
  });

  // ---- Pause control (principal-keyed, fail-closed) -----------------------

  it("pausing a principal drops it from the reader; resume restores it", async () => {
    const pkg = "@x/pausable";
    const principal = await seedAssistant({ pkg, handle: "pausebot", audience: [{ kind: "workspace" }] });
    expect(await handlesOf()).toContain("pausebot");

    await db.pauseAssistant(principal, "admin-1");
    expect(await db.listPausedAssistantIds([principal]).then((s) => s.has(principal))).toBe(true);
    expect(await handlesOf()).not.toContain("pausebot"); // fail-closed

    await db.resumeAssistant(principal);
    expect(await handlesOf()).toContain("pausebot");
  });

  it("the builtin Cinatra principal is NEVER dropped for pause (defense in depth)", async () => {
    const builtin = await seedBuiltinCinatra();
    await db.pauseAssistant(builtin); // even if a pause row somehow exists
    const entries = await reader.readAssistantRegistryForActor(ctx());
    expect(entries.find((e) => e.handle === "cinatra")?.isBuiltin).toBe(true);
  });

  // ---- Aliases (AC#1) -----------------------------------------------------

  it("alias claim collides with a HANDLE (inline error names the table)", async () => {
    const pkg = "@x/alias-assistant";
    await seedAssistant({ pkg, handle: "keeper", origin: "standalone", audience: [{ kind: "workspace" }] });
    await expect(db.claimAssistantAlias("keeper", pkg, "admin")).rejects.toMatchObject({
      name: "AssistantNamespaceCollisionError",
      token: "keeper",
      ownedBy: "handle",
    });
  });

  it("alias add + rename round-trips; rename onto a taken alias collides; builtin is immutable", async () => {
    const pkgA = "@x/a-assistant";
    const pkgB = "@x/b-assistant";
    await seedAssistant({ pkg: pkgA, handle: "abot", audience: [{ kind: "workspace" }] });
    await seedAssistant({ pkg: pkgB, handle: "bbot", audience: [{ kind: "workspace" }] });

    await db.claimAssistantAlias("alpha", pkgA, "admin");
    await db.claimAssistantAlias("beta", pkgB, "admin");
    // rename onto a taken alias → collision naming the alias table
    await expect(db.renameAssistantAlias("alpha", "beta", pkgA)).rejects.toMatchObject({
      name: "AssistantNamespaceCollisionError",
      ownedBy: "alias",
    });
    // rename to a free token → success (old gone, new present, pointing at pkgA)
    await db.renameAssistantAlias("alpha", "gamma", pkgA);
    const rows = await admin.query(
      `SELECT alias, package_name FROM "${schema}".assistant_tag_alias ORDER BY alias`,
    );
    const aliases = rows.rows.map((r) => r.alias);
    expect(aliases).toContain("gamma");
    expect(aliases).not.toContain("alpha");

    // A `source='builtin'` alias is IMMUTABLE: renaming FROM it throws and remove
    // is a no-op. No builtin alias is seeded any more (owner ruling 2026-07-23
    // (groganz): the built-in's ONE tag is its resolving handle, not an alias), so
    // this exercises the substrate guard directly by inserting a builtin-source row.
    await admin.query(
      `INSERT INTO "${schema}".assistant_tag_alias (alias, package_name, source) VALUES ('reserved-builtin',$1,'builtin')`,
      [pkgA],
    );
    await expect(db.renameAssistantAlias("reserved-builtin", "x", pkgA)).rejects.toMatchObject({
      name: "AssistantNamespaceCollisionError",
    });
    await db.removeAssistantAlias("reserved-builtin");
    const stillThere = await admin.query(
      `SELECT 1 FROM "${schema}".assistant_tag_alias WHERE alias='reserved-builtin'`,
    );
    expect(stillThere.rowCount).toBe(1);
  });

  it("an admin alias resolves the assistant via the reader (add) and stops resolving it (remove)", async () => {
    const pkg = "@x/resolvable";
    await seedAssistant({ pkg, handle: "resbot", audience: [{ kind: "workspace" }] });
    await db.claimAssistantAlias("nick", pkg, "admin");
    const e = (await reader.readAssistantRegistryForActor(ctx())).find((x) => x.handle === "resbot");
    expect(e?.aliases).toContain("nick");
    await db.removeAssistantAlias("nick");
    const e2 = (await reader.readAssistantRegistryForActor(ctx())).find((x) => x.handle === "resbot");
    expect(e2?.aliases).not.toContain("nick");
  });

  // ---- Single editable tag (the resolving handle) -------------------------
  // Owner ruling 2026-07-23 (groganz): the surface manages ONE mutable tag per
  // assistant — the RESOLVING tag (the handle) — collision-checked against BOTH
  // namespace tables, editable for EVERY assistant incl. the built-in Cinatra one
  // (no immutability on the resolving handle). Proven against the real reader.

  it("renaming the resolving tag re-points the reader; collides with another handle OR an alias", async () => {
    const pkg = "@x/tagbot";
    const principal = await seedAssistant({ pkg, handle: "tagbot", audience: [{ kind: "workspace" }] });
    expect(await handlesOf()).toContain("tagbot");

    // Rename to a FREE token → the reader now resolves the new tag, not the old.
    const next = await db.renameAssistantHandleByPrincipal(principal, "helper");
    expect(next).toBe("helper");
    expect(await handlesOf()).toContain("helper");
    expect(await handlesOf()).not.toContain("tagbot");

    // Collision with ANOTHER assistant's HANDLE → throws (names the handle table);
    // the rename rolls back, so the current tag survives.
    await seedAssistant({ pkg: "@x/other", handle: "keeper", audience: [{ kind: "workspace" }] });
    await expect(db.renameAssistantHandleByPrincipal(principal, "keeper")).rejects.toMatchObject({
      name: "AssistantNamespaceCollisionError",
      ownedBy: "handle",
    });

    // Collision with an ALIAS token → throws (names the alias table).
    await db.claimAssistantAlias("reserved", "@x/other", "admin");
    await expect(db.renameAssistantHandleByPrincipal(principal, "reserved")).rejects.toMatchObject({
      name: "AssistantNamespaceCollisionError",
      ownedBy: "alias",
    });

    // Both collisions rolled back — the earlier successful tag still resolves.
    expect(await handlesOf()).toContain("helper");
  });

  it("the built-in's ONE tag is @cinatra (its handle) and it is editable — no builtin alias, no immutability", async () => {
    const builtin = await seedBuiltinCinatra(); // handle 'cinatra', NO builtin alias
    // The built-in surfaces its resolving handle `cinatra` as its ONE tag (owner
    // ruling 2026-07-23 (groganz)) — @cinatra, never @cinatra-2.
    const seeded = (await reader.readAssistantRegistryForActor(ctx())).find((e) => e.isBuiltin);
    expect(seeded?.handle).toBe("cinatra");
    // And there is NO builtin alias — the token belongs to the handle alone.
    expect(seeded?.aliases ?? []).not.toContain("cinatra");
    // The resolving handle is editable (no immutability on the built-in tag). The
    // rename target here is only a demonstration — the ruled default is `cinatra`.
    const next = await db.renameAssistantHandleByPrincipal(builtin, "cinatra-primary");
    expect(next).toBe("cinatra-primary");
    const entry = (await reader.readAssistantRegistryForActor(ctx())).find((e) => e.isBuiltin);
    expect(entry?.handle).toBe("cinatra-primary");
  });

  // ---- Deletion guard (AC#3) ----------------------------------------------

  it("isExtensionOwnedAssistantPrincipal: origin='extension' guarded, standalone deletable", async () => {
    const ext = await seedAssistant({ pkg: "@x/ext", handle: "extbot", origin: "extension" });
    const std = await seedAssistant({ pkg: "@x/std", handle: "stdbot", origin: "standalone" });
    expect(await users.isExtensionOwnedAssistantPrincipal(ext)).toBe(true);
    expect(await users.isExtensionOwnedAssistantPrincipal(std)).toBe(false);
  });
});

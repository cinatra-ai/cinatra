/**
 * AC#5 (cinatra#1874 Epic #1873 W1) — the registry reader's audience filter,
 * archive-hiding, and bare-name-fallback exclusion proven against REAL Postgres.
 *
 * The reader (`readAssistantRegistryForActor`) resolves against `betterAuthDb`,
 * whose drizzle tables are qualified to `SUPABASE_SCHEMA` (read at import). So the
 * test provisions a dedicated schema, sets `SUPABASE_SCHEMA` to it, and
 * DYNAMICALLY imports the reader AFTER — ES imports hoist above top-level env
 * assignments, so a static import would bind the default schema. Self-skips
 * without a real SUPABASE_DB_URL (same contract as the sibling integration tests).
 *
 * Coverage (each audience subject_kind exercised; in-audience visible /
 * out-of-audience invisible):
 *   - workspace | admin | organization | team | project grants;
 *   - the builtin Cinatra descriptor is ALWAYS visible (no audience row);
 *   - an ARCHIVED install is invisible while its principal (+ dormant template)
 *     survives; an active install with a NULL declaration is invisible;
 *   - bare-name fallback resolves a standalone handle but NOT an origin='extension'
 *     one (no resurrection of an uninstalled package via a stale handle).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { assistantHandleSchemaQueries } from "@/lib/assistant-thread-schema";
import { assistantRegistrySchemaQueries, BUILTIN_ASSISTANT_ALIAS } from "@/lib/assistant-registry-schema";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused") &&
  !dbUrl.includes("build:build@127.0.0.1:5432/build");

const maybe = hasDb ? describe : describe.skip;

type Reader = typeof import("@/lib/assistant-registry-reader");

maybe("AC#5 — registry reader audience filter (live)", () => {
  const schema = `reg_read_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin: Client;
  let reader: Reader;

  // Full-audience actor context (member of every seam) — flip individual sets
  // per assertion by passing a narrower ctx.
  const ORG = "org-A";
  const TEAM = "team-A";
  const PROJ = "proj-A";

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

  beforeAll(async () => {
    admin = new Client({ connectionString: dbUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);

    // Registry tables from the shared bootstrap leaf builders.
    for (const q of [...assistantHandleSchemaQueries(schema), ...assistantRegistrySchemaQueries(schema)]) {
      if (q.text.trim().toUpperCase().startsWith("INSERT")) continue; // control our own seed
      await admin.query(q.text);
    }
    // Minimal agent_templates + installed_extension — exactly the columns the
    // reader reads (faithful subset).
    await admin.query(`CREATE TABLE "${schema}".agent_templates (
      id text PRIMARY KEY,
      name text,
      package_name text,
      agent_kind text NOT NULL DEFAULT 'executor',
      assistant_config text,
      assistant_user_id text,
      status text
    )`);
    await admin.query(`CREATE TABLE "${schema}".installed_extension (
      id text PRIMARY KEY,
      package_name text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      assistant_declaration jsonb
    )`);

    process.env.SUPABASE_SCHEMA = schema;
    reader = await import("@/lib/assistant-registry-reader");
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
       "${schema}".assistant_audience, "${schema}".agent_templates, "${schema}".installed_extension`,
    );
  });

  /** Seed a fully-installed assistant: template + principal handle + installed row
   *  (active, declaration NOT NULL) + optional aliases. Returns the principal id. */
  async function seedAssistant(opts: {
    pkg: string;
    handle: string;
    origin?: "extension" | "standalone";
    status?: "active" | "archived" | "locked";
    declaration?: unknown; // null → not a stamped assistant install
    installed?: boolean; // false → no installed_extension row at all
    aliases?: string[];
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
    if (opts.installed !== false) {
      const decl = opts.declaration === undefined ? { formatVersion: 1 } : opts.declaration;
      await admin.query(
        `INSERT INTO "${schema}".installed_extension (id, package_name, kind, status, assistant_declaration)
         VALUES ($1,$2,'agent',$3,$4)`,
        [`ie-${randomUUID()}`, opts.pkg, opts.status ?? "active", decl === null ? null : JSON.stringify(decl)],
      );
    }
    for (const a of opts.aliases ?? []) {
      await admin.query(
        `INSERT INTO "${schema}".assistant_tag_alias (alias, package_name, source) VALUES ($1,$2,'manifest')`,
        [a, opts.pkg],
      );
    }
    for (const g of opts.audience ?? []) {
      await admin.query(
        `INSERT INTO "${schema}".assistant_audience (package_name, subject_kind, subject_id) VALUES ($1,$2,$3)`,
        [opts.pkg, g.kind, g.id ?? null],
      );
    }
    return principal;
  }

  /** Seed the boot-seeded builtin Cinatra (template + handle, NO installed row). */
  async function seedBuiltinCinatra(): Promise<void> {
    const principal = `p-cinatra-${randomUUID()}`;
    await admin.query(
      `INSERT INTO "${schema}".agent_templates (id, name, package_name, agent_kind, assistant_config, assistant_user_id, status)
       VALUES ($1,'Cinatra',$2,'assistant','{}',$3,'published')`,
      [`tpl-cinatra`, BUILTIN_ASSISTANT_ALIAS.packageName, principal],
    );
    await admin.query(
      `INSERT INTO "${schema}".assistant_handles (assistant_user_id, handle, origin, package_name)
       VALUES ($1,'cinatra','standalone',$2)`,
      [principal, BUILTIN_ASSISTANT_ALIAS.packageName],
    );
    await admin.query(
      `INSERT INTO "${schema}".assistant_tag_alias (alias, package_name, source)
       VALUES ('cinatra',$1,'builtin')`,
      [BUILTIN_ASSISTANT_ALIAS.packageName],
    );
  }

  it.each([
    ["workspace", { kind: "workspace", id: null }, {}],
    ["admin", { kind: "admin", id: null }, { isPlatformAdmin: true }],
    ["organization", { kind: "organization", id: ORG }, { orgIds: new Set([ORG]) }],
    ["team", { kind: "team", id: TEAM }, { teamIds: new Set([TEAM]) }],
    ["project", { kind: "project", id: PROJ }, { projectIds: new Set([PROJ]) }],
  ] as const)(
    "%s grant: in-audience actor sees it, out-of-audience actor sees NO trace",
    async (label, grant, inCtx) => {
      const pkg = `@x/${label}-assistant`;
      const handle = `${label}bot`;
      await seedAssistant({
        pkg,
        handle,
        audience: [{ kind: grant.kind, id: grant.id }],
      });

      // In-audience: visible.
      const seen = await reader.readAssistantRegistryForActor(ctx(inCtx as object));
      expect(seen.map((e) => e.handle)).toContain(handle);

      // Out-of-audience: a bare actor (no memberships, not admin) sees NOTHING.
      const bare = await reader.readAssistantRegistryForActor(ctx());
      if (label === "workspace") {
        // workspace is universal — the bare actor is still IN.
        expect(bare.map((e) => e.handle)).toContain(handle);
      } else {
        expect(bare.map((e) => e.handle)).not.toContain(handle);
      }
    },
  );

  it("builtin Cinatra is ALWAYS visible (no audience row) even to a bare actor", async () => {
    await seedBuiltinCinatra();
    await seedAssistant({ pkg: "@x/team-only", handle: "teambot", audience: [{ kind: "team", id: TEAM }] });

    const entries = await reader.readAssistantRegistryForActor(ctx());
    const cinatra = entries.find((e) => e.handle === "cinatra");
    expect(cinatra).toBeTruthy();
    expect(cinatra?.isBuiltin).toBe(true);
    expect(cinatra?.aliases).toContain("cinatra");
    // the team-gated one is NOT visible to the bare actor
    expect(entries.map((e) => e.handle)).not.toContain("teambot");
  });

  it("ARCHIVED install is invisible, but the principal (+ dormant template) survive", async () => {
    const principal = await seedAssistant({
      pkg: "@x/archived",
      handle: "ghostbot",
      status: "archived",
      audience: [{ kind: "workspace" }],
    });

    const entries = await reader.readAssistantRegistryForActor(ctx());
    expect(entries.map((e) => e.handle)).not.toContain("ghostbot");

    // Principal + template rows are untouched (attribution survives).
    const h = await admin.query(`SELECT 1 FROM "${schema}".assistant_handles WHERE assistant_user_id=$1`, [principal]);
    const t = await admin.query(`SELECT 1 FROM "${schema}".agent_templates WHERE assistant_user_id=$1`, [principal]);
    expect(h.rowCount).toBe(1);
    expect(t.rowCount).toBe(1);
  });

  it("an active install with a NULL declaration is not an assistant entry", async () => {
    await seedAssistant({ pkg: "@x/nodecl", handle: "nodeclbot", declaration: null, audience: [{ kind: "workspace" }] });
    const entries = await reader.readAssistantRegistryForActor(ctx());
    expect(entries.map((e) => e.handle)).not.toContain("nodeclbot");
  });

  it("aliases are attached to the visible entry (sorted, deduped)", async () => {
    await seedAssistant({
      pkg: "@x/aliased",
      handle: "aliasbot",
      aliases: ["zeta", "alpha"],
      audience: [{ kind: "workspace" }],
    });
    const entries = await reader.readAssistantRegistryForActor(ctx());
    const e = entries.find((x) => x.handle === "aliasbot");
    expect(e?.aliases).toEqual(["alpha", "zeta"]);
  });

  it("bare-name fallback resolves a standalone handle but EXCLUDES origin='extension'", async () => {
    const standalone = await seedAssistant({
      pkg: "@x/standalone",
      handle: "keeper",
      origin: "standalone",
      audience: [{ kind: "workspace" }],
    });
    const ext = await seedAssistant({
      pkg: "@x/uninstalled-ext",
      handle: "zombie",
      origin: "extension",
      installed: false, // uninstalled: no installed_extension row, but the handle survives
      audience: [{ kind: "workspace" }],
    });

    expect(await reader.resolveAssistantBareName("keeper")).toBe(standalone);
    // The surviving extension handle must NOT be resurrected by bare name.
    expect(await reader.resolveAssistantBareName("zombie")).toBeNull();
    // sanity: the extension handle row genuinely still exists.
    const row = await admin.query(`SELECT 1 FROM "${schema}".assistant_handles WHERE assistant_user_id=$1`, [ext]);
    expect(row.rowCount).toBe(1);
    // and a name that normalizes to nothing is null.
    expect(await reader.resolveAssistantBareName("   ")).toBeNull();
  });
});

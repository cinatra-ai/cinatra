import { describe, it, expect } from "vitest";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

/**
 * Schema preflight and DDL coverage for project-scoped storage.
 * Verifies chat thread timestamps, workspace CHECK behavior,
 * agent_template_id FK + jsonb CHECK, and partial generated-col indexes.
 */
describe("project-scoped schema migration", () => {
  const texts = buildCreateStoreSchemaQueries("cinatra_test").map((q) => q.text);
  const has = (needle: string) => texts.some((t) => t.includes(needle));
  const idxOf = (needle: string) => texts.findIndex((t) => t.includes(needle));

  // ---- T1: objects.project_id (covers artifacts + objects) ----
  it("T1 objects.project_id column + composite + partial indexes", () => {
    expect(has('ALTER TABLE "cinatra_test"."objects" ADD COLUMN IF NOT EXISTS project_id text')).toBe(true);
    expect(has('objects_owner_project_idx ON "cinatra_test"."objects" (owner_level, owner_id, project_id, created_at DESC)')).toBe(true);
    expect(has('objects_project_idx ON "cinatra_test"."objects" (project_id, created_at DESC) WHERE project_id IS NOT NULL')).toBe(true);
  });

  // ---- T2: agent_runs.project_id ----
  it("T2 agent_runs.project_id column + partial indexes", () => {
    expect(has('ALTER TABLE "cinatra_test"."agent_runs" ADD COLUMN IF NOT EXISTS project_id text')).toBe(true);
    expect(has('agent_runs_project_idx ON "cinatra_test"."agent_runs" (project_id, created_at DESC) WHERE project_id IS NOT NULL')).toBe(true);
    expect(has('agent_runs_project_status_idx ON "cinatra_test"."agent_runs" (project_id, status, created_at DESC) WHERE project_id IS NOT NULL')).toBe(true);
  });

  // ---- T3: chat_threads typed columns ----
  it("T3 chat_threads.project_id + created_at + updated_at + ordered partial index", () => {
    expect(has('ALTER TABLE "cinatra_test"."chat_threads" ADD COLUMN IF NOT EXISTS project_id text')).toBe(true);
    expect(has('ALTER TABLE "cinatra_test"."chat_threads" ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()')).toBe(true);
    expect(has('ALTER TABLE "cinatra_test"."chat_threads" ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()')).toBe(true);
    expect(has('chat_threads_project_created_idx ON "cinatra_test"."chat_threads" (project_id, created_at DESC, id) WHERE project_id IS NOT NULL')).toBe(true);
  });

  // ---- T4: projects.archived_at ----
  it("T4 projects.archived_at column (nullable, no backfill)", () => {
    expect(has('ALTER TABLE "cinatra_test"."projects" ADD COLUMN IF NOT EXISTS archived_at timestamptz')).toBe(true);
  });

  // ---- T5: project_access ----
  it("T5 project_access table: generated cols + CHECKs + FK + workspace CHECK", () => {
    const raw = texts.find((x) => x.includes('CREATE TABLE IF NOT EXISTS "cinatra_test"."project_access"'));
    expect(raw).toBeDefined();
    // DDL aligns columns with variable whitespace — normalize before substring checks.
    const t = raw!.replace(/[ \t]+/g, " ");
    expect(t).toContain("principal_level text NOT NULL CHECK (principal_level IN ('user','team','organization','workspace'))");
    expect(t).toContain("role text NOT NULL CHECK (role IN ('read','write','admin'))");
    expect(t).toContain('REFERENCES "cinatra_test"."projects"(id) ON DELETE CASCADE');
    expect(t).toContain("principal_user_id text GENERATED ALWAYS AS");
    expect(t).toContain("principal_team_id text GENERATED ALWAYS AS");
    expect(t).toContain("principal_org_id text GENERATED ALWAYS AS");
    expect(t).toContain("project_access_workspace_principal_chk");
    expect(t).toContain("PRIMARY KEY (project_id, principal_level, principal_id)");
  });

  it("T5 project_access per-type CASCADE FKs (DO-block) + partial generated-col indexes", () => {
    expect(has('public."user"(id) ON DELETE CASCADE')).toBe(true);
    expect(has('public."team"(id) ON DELETE CASCADE')).toBe(true);
    expect(has('public."organization"(id) ON DELETE CASCADE')).toBe(true);
    expect(has('project_access_user_idx ON "cinatra_test"."project_access" (principal_user_id) WHERE principal_user_id IS NOT NULL')).toBe(true);
    expect(has('project_access_team_idx ON "cinatra_test"."project_access" (principal_team_id) WHERE principal_team_id IS NOT NULL')).toBe(true);
    expect(has('project_access_org_idx ON "cinatra_test"."project_access" (principal_org_id) WHERE principal_org_id IS NOT NULL')).toBe(true);
  });

  it("T5 project_access same-org validation trigger (idempotent + fail-closed)", () => {
    expect(has("CREATE OR REPLACE FUNCTION")).toBe(true);
    expect(has("fn_project_access_same_org")).toBe(true);
    expect(has("DROP TRIGGER IF EXISTS")).toBe(true);
    expect(has("trg_project_access_same_org")).toBe(true);
    const fn = texts.find((x) => x.includes("fn_project_access_same_org"))!;
    // same-org logic references the better-auth membership tables
    expect(fn).toContain("public.member");
    expect(fn).toContain('public."team"');
    // Fail-closed branches must exist:
    // (a) missing project row → reject
    expect(fn).toContain("IF NOT FOUND THEN");
    expect(fn).toContain("project_access: project % does not exist");
    // (b) org-NULL project → only workspace allowed, every other level rejected
    expect(fn).toContain("IF proj_org IS NULL THEN");
    expect(fn).toContain("only workspace grant is allowed for org-null projects");
    // (c) org-bound project → workspace grant rejected
    expect(fn).toContain("workspace grant not allowed on org-bound project");
    // workspace lookup index
    expect(has("project_access_workspace_idx")).toBe(true);
    expect(has("WHERE principal_level = 'workspace' AND principal_id = '__workspace__'")).toBe(true);
  });

  // ---- T6: project_agent_template_bindings ----
  it("T6 project_agent_template_bindings: FK to agent_templates + jsonb CHECK", () => {
    const t = texts.find((x) => x.includes('CREATE TABLE IF NOT EXISTS "cinatra_test"."project_agent_template_bindings"'));
    expect(t).toBeDefined();
    expect(t).toContain('REFERENCES "cinatra_test"."agent_templates"(id) ON DELETE CASCADE');
    expect(t).toContain("visibility text NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','hidden','project-private'))");
    expect(t).toContain("jsonb_typeof(default_context_overrides) = 'object'");
    expect(t).toContain("PRIMARY KEY (project_id, agent_template_id)");
  });

  // ---- T7: resource_project_moves (append-only audit) ----
  it("T7 resource_project_moves audit table", () => {
    const t = texts.find((x) => x.includes('CREATE TABLE IF NOT EXISTS "cinatra_test"."resource_project_moves"'));
    expect(t).toBeDefined();
    for (const col of ["resource_kind text NOT NULL", "resource_id text NOT NULL", "old_project_id text", "new_project_id text", "actor_id text NOT NULL", "source_run_id text", "source_thread_id text"]) {
      expect(t).toContain(col);
    }
  });

  // ---- T8: project_resource_refs (cross-project linked refs) ----
  it("T8 project_resource_refs with double projects FK + uniqueness", () => {
    const t = texts.find((x) => x.includes('CREATE TABLE IF NOT EXISTS "cinatra_test"."project_resource_refs"'));
    expect(t).toBeDefined();
    expect(t).toContain('source_project_id text NOT NULL REFERENCES "cinatra_test"."projects"(id) ON DELETE CASCADE');
    expect(t).toContain('target_project_id text NOT NULL REFERENCES "cinatra_test"."projects"(id) ON DELETE CASCADE');
    expect(t).toContain("UNIQUE (source_project_id, target_project_id, resource_kind, resource_id)");
  });

  // ---- No physical artifacts table ----
  it("does NOT create a physical artifacts table (artifacts are objects rows)", () => {
    expect(has('CREATE TABLE IF NOT EXISTS "cinatra_test"."artifacts" (')).toBe(false);
  });

  // ---- ordering: new tables after project_co_owners; ALTERs after base CREATE ----
  it("ordering: project_access emitted after project_co_owners and after projects CREATE", () => {
    const coOwners = idxOf('CREATE TABLE IF NOT EXISTS "cinatra_test"."project_co_owners"');
    const projects = idxOf('CREATE TABLE IF NOT EXISTS "cinatra_test"."projects"');
    const access = idxOf('CREATE TABLE IF NOT EXISTS "cinatra_test"."project_access"');
    expect(projects).toBeGreaterThan(-1);
    expect(coOwners).toBeGreaterThan(-1);
    expect(access).toBeGreaterThan(coOwners);
    expect(access).toBeGreaterThan(projects);
  });

  it("ordering: each project_id ALTER comes after its base table CREATE", () => {
    for (const tbl of ["objects", "agent_runs", "chat_threads"]) {
      const create = idxOf(`CREATE TABLE IF NOT EXISTS "cinatra_test"."${tbl}"`);
      const alter = idxOf(`ALTER TABLE "cinatra_test"."${tbl}" ADD COLUMN IF NOT EXISTS project_id text`);
      expect(create).toBeGreaterThan(-1);
      expect(alter).toBeGreaterThan(create);
    }
  });
});

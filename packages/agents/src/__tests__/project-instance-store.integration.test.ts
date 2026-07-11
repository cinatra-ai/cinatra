/**
 * Live-Postgres integration tests for the project-instance registry
 * (cinatra#1032 deliverable 3): the sticky INSERT … ON CONFLICT DO NOTHING
 * create (never overwrites an existing binding), the read-back convergence
 * for a lost race, and point reads.
 *
 * These are the load-bearing single-statement semantics the pure unit tests
 * cannot prove: a concurrent second create for the same (org_id, project_ref)
 * returns the WINNER's persisted row (created:false) with the binding
 * unchanged — the provider/seat/template stickiness the drift predicate
 * upstream relies on.
 *
 * DB-gated: skips when SUPABASE_DB_URL is unset (matches
 * project-dispatch-ledger-lease.integration.test.ts).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');

beforeAll(async () => {
  if (!hasDb) return;
  // Defensive: ensure the table exists (mirrors the projectInstancesSchemaQueries
  // bootstrap leaf in src/lib/extension-grant-schema.ts; idempotent — safe on
  // an already-migrated schema).
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(`CREATE TABLE IF NOT EXISTS "${q(SCHEMA)}"."project_instances" (
    org_id text NOT NULL,
    project_ref text NOT NULL,
    project_id text,
    template_package text NOT NULL,
    template_id text NOT NULL,
    template_digest text NOT NULL,
    pm_agent_package text NOT NULL,
    provider_id text NOT NULL,
    provider_mode text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, project_ref),
    CONSTRAINT project_instances_provider_mode_check
      CHECK (provider_mode IN ('configured', 'auto'))
  )`);
  await c.end();
}, 30_000);

const ORG = "org-int-1032-d3";
const freshRef = () => `proj-${randomUUID().slice(0, 8)}`;

const baseInput = (projectRef: string) => ({
  orgId: ORG,
  projectRef,
  projectId: null,
  templatePackage: "@cinatra-ai/release-announcement-agent",
  templateId: "launch-plan",
  templateDigest: "sha512-fixture",
  pmAgentPackage: "@cinatra-ai/project-manager-agent",
  providerId: "plane",
  providerMode: "auto" as const,
});

describe.runIf(hasDb)("project-instance store (live DB)", () => {
  it("creates fresh (created:true) and reads back the persisted binding", async () => {
    const { createProjectInstance, readProjectInstance } = await import(
      "../project-instance-store"
    );
    const projectRef = freshRef();
    const out = await createProjectInstance(baseInput(projectRef));
    expect(out.created).toBe(true);
    expect(out.instance).toMatchObject({
      orgId: ORG,
      projectRef,
      providerId: "plane",
      providerMode: "auto",
      pmAgentPackage: "@cinatra-ai/project-manager-agent",
    });

    const read = await readProjectInstance(ORG, projectRef);
    expect(read).toMatchObject({ providerId: "plane", templateId: "launch-plan" });
  });

  it("a second create for the same key NEVER overwrites — the winner's binding survives (created:false)", async () => {
    const { createProjectInstance } = await import("../project-instance-store");
    const projectRef = freshRef();
    await createProjectInstance(baseInput(projectRef));
    const loser = await createProjectInstance({
      ...baseInput(projectRef),
      providerId: "github",
      providerMode: "configured",
      pmAgentPackage: "@cinatra-ai/rogue-agent",
    });
    expect(loser.created).toBe(false);
    // The persisted row is the WINNER's binding — provider/seat unchanged.
    expect(loser.instance).toMatchObject({
      providerId: "plane",
      providerMode: "auto",
      pmAgentPackage: "@cinatra-ai/project-manager-agent",
    });
  });

  it("returns null for an un-instantiated project", async () => {
    const { readProjectInstance } = await import("../project-instance-store");
    expect(await readProjectInstance(ORG, freshRef())).toBeNull();
  });

  it("the provider_mode CHECK refuses an out-of-vocabulary mode at the DB boundary", async () => {
    const { createProjectInstance } = await import("../project-instance-store");
    await expect(
      createProjectInstance({
        ...baseInput(freshRef()),
        providerMode: "guessed" as never,
      }),
    ).rejects.toThrow();
  });
});

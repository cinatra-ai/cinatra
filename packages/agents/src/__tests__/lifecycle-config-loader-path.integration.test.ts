/**
 * cinatra#2044 GAP 2, end to end against a REAL Postgres — the manifest's
 * `cinatra.lifecycle` declaration must survive the git-file/ZIP LOADER install
 * path, so a reviewer's `changes_requested` on that producer's output routes
 * `producer_repair` instead of `human_escalation`.
 *
 * THE NEGATIVE PROOF THIS SUITE CLOSES (wave124, posted on cinatra#2044
 * 2026-07-31): driven live on a lane stack, an install of the REAL lock-pinned
 * `@cinatra-ai/wordpress-agent@0.1.6` — whose manifest DOES declare
 * `cinatra.lifecycle.repairCapable: true` — left the column NULL:
 *
 *     template @cinatra-ai/wordpress-agent -> lifecycle_config = <NULL>
 *     routeKind = "human_escalation"   repair.status = "escalated"
 *     successor_gate_id = null
 *
 * Only after HAND-SEEDING `lifecycle_config` did the round trip complete. Two
 * hops dropped it, and both are fixed by the change under proof:
 *   1. `ensureAgentPackageFromGitFile` synthesized the install ZIP's
 *      `package.json` without the `cinatra.lifecycle` block;
 *   2. `importAgentTemplateCore` never set `lifecycleConfig` at all.
 *
 * The sibling UNIT suites pin each hop in isolation with the collaborators
 * mocked (`ensure-agent-package-lifecycle-carry.test.ts`,
 * `import-agent-core-lifecycle-config.test.ts`). THIS suite is the one that
 * proves the composite: no mock of the loader, the importer, the OAS compiler,
 * the license gate, the store, or the router — a real fixture on disk, the real
 * `ensureAgentPackageFromGitFile` the dev-boot scan and the hot-reload watcher
 * call, a real `agent_templates` row read back with SQL, and the real
 * `recordReviewSurfaceChangesRequested` entry point the review surface calls.
 * `installAgentFromPackage` (the registry path that always worked) is NOT
 * exercised here — the point is the OTHER path reaching parity with it.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";

import {
  producedEventId,
  type ArtifactProducedEvent,
} from "@/lib/lifecycle/lifecycle-produced-event";
import { autoReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";

import { agentLifecycleDeclarationSchema } from "../verdaccio/package-contract";

const TEST_SCHEMA = "cinatra_test_2044_gap2_loader_path";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2044-gap2-loader";
const MEMBER_USER = "user-2044-gap2-loader-member";
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

/** The producing package under proof — the REAL extension identity wave124
 * drove, not a synthetic stand-in. */
const WORDPRESS_AGENT_PACKAGE = "@cinatra-ai/wordpress-agent";
/** The lock-pinned release whose manifest declares the capability. */
const WORDPRESS_AGENT_VERSION = "0.1.6";
/** The pinned clone-back tree the dev-boot scan loads from. Present in a dev
 * checkout and in the conformance jobs; absent in the DB-tier CI job, which is
 * why the fixture below falls back to a synthesized tree carrying the same
 * declaration. */
const PINNED_AGENT_DIR = join(REPO_ROOT, "extensions", "cinatra-ai", "wordpress-agent");
const PINNED_OAS_PATH = join(PINNED_AGENT_DIR, "cinatra", "oas.json");
const PINNED_MANIFEST_PATH = join(PINNED_AGENT_DIR, "package.json");

/**
 * The lifecycle declaration `@cinatra-ai/wordpress-agent@0.1.6` ships in its
 * `package.json#cinatra.lifecycle`. Kept as a literal so the DB-tier CI job can
 * still run the whole proof without the clone-back tree, but NEVER a
 * free-floating stub — the same two guards the merged
 * `lifecycle-repair-cms-roundtrip.integration.test.ts` applies:
 *   - it must PARSE through the real manifest contract
 *     (`agentLifecycleDeclarationSchema`), and
 *   - whenever the pinned tree IS on disk it is cross-checked against the REAL
 *     manifest, so a pin that drops or changes the block fails this suite.
 */
const WORDPRESS_AGENT_LIFECYCLE = { repairCapable: true } as const;
/** The exact column TEXT the compiled declaration serializes to (stable key
 * order — `serializeLifecycleConfig`). Asserted as bytes, not as a parse, so a
 * silently-reshaped column cannot pass. */
const EXPECTED_LIFECYCLE_CONFIG = JSON.stringify(WORDPRESS_AGENT_LIFECYCLE);

/** A produced CMS-snapshot event's emitter + object type. `document` is
 * deliberately NOT a core-repairable role, so `producer_repair` here can ONLY
 * come from the manifest declaration reaching the column — never from core's
 * own `CORE_REPAIRABLE_PRODUCED_ROLES` fallback. */
const CMS_SNAPSHOT_EMITTER = "object_cms_snapshot_capture";
const NON_CORE_REPAIRABLE_OBJECT_TYPE = "document";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
let loader: typeof import("../ensure-agent-package");
let dbMod: typeof import("../db");

let tmpRoot: string | null = null;

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

// ---------------------------------------------------------------------------
// Fixtures — a real git-file agent tree on disk
// ---------------------------------------------------------------------------

/** The minimal REAL OAS Flow the compiler accepts (Start → End). Shape mirrored
 * from the compiler's own suites; nothing about GAP 2 depends on the flow body,
 * only on the sibling manifest riding the synthesis. */
function minimalOas(packageName: string): string {
  return JSON.stringify(
    {
      agentspec_version: "26.1.0",
      component_type: "Flow",
      id: "loader-path-fixture-flow",
      name: "Loader Path Fixture",
      description: "git-file loader fixture for cinatra#2044 GAP 2",
      metadata: { cinatra: { type: "leaf", packageName } },
      inputs: [{ title: "instructions", type: "string" }],
      outputs: [],
      start_node: { $component_ref: "startNode" },
      nodes: [{ $component_ref: "startNode" }, { $component_ref: "endNode" }],
      control_flow_connections: [
        {
          component_type: "ControlFlowEdge",
          name: "start-to-end",
          from_node: { $component_ref: "startNode" },
          to_node: { $component_ref: "endNode" },
        },
      ],
      $referenced_components: {
        startNode: {
          component_type: "StartNode",
          id: "startNode",
          name: "Start",
          inputs: [{ title: "instructions", type: "string" }],
        },
        endNode: {
          component_type: "EndNode",
          id: "endNode",
          name: "End",
          outputs: [],
        },
      },
    },
    null,
    2,
  );
}

/** Materialize an `agents/<slug>/{package.json,cinatra/oas.json}` tree in a temp
 * dir — the exact on-disk layout `ensureAgentPackageFromGitFile` reads, sibling
 * manifest and all. Returns the oas.json path the loader is called with. */
async function writeGitFileFixture(input: {
  slug: string;
  packageName: string;
  version: string;
  /** Omit to model a manifest that declares NO lifecycle block. */
  lifecycle?: Record<string, unknown>;
}): Promise<string> {
  const dir = join(tmpRoot!, input.slug);
  await mkdir(join(dir, "cinatra"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: input.packageName,
        version: input.version,
        license: "Apache-2.0",
        description: "git-file loader fixture for cinatra#2044 GAP 2",
        cinatra: {
          apiVersion: "cinatra.ai/v1",
          kind: "agent",
          packageType: "agent",
          manifestVersion: 1,
          type: "leaf",
          ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  // The SPDX header matters for the vanished-manifest case below: with no
  // package.json the license can only resolve from this file (detection source 2),
  // and without it the import would fail on the LICENSE gate BEFORE reaching the
  // lifecycle_config write — making that proof vacuous. Every other case resolves
  // from package.json#license (source 1), which wins, so this changes nothing for
  // them.
  await writeFile(
    join(dir, "LICENSE"),
    "SPDX-License-Identifier: Apache-2.0\n\nApache License\nVersion 2.0, January 2004\n",
    "utf8",
  );
  const oasPath = join(dir, "cinatra", "oas.json");
  await writeFile(oasPath, minimalOas(input.packageName), "utf8");
  return oasPath;
}

/**
 * The wordpress-agent source the loader install is driven from: the REAL pinned
 * clone-back tree when it is on disk (the literal wave124 repro — the same path
 * `dev-boot` hands the loader), else a synthesized tree carrying the same
 * declaration so the DB-tier CI job still proves the composite.
 *
 * Either way the manifest's lifecycle block is validated against the real
 * manifest contract, and against the pinned manifest when that is readable.
 */
function resolveWordPressFixture(): Promise<{ oasPath: string; fromPinnedTree: boolean }> {
  expect(agentLifecycleDeclarationSchema.safeParse(WORDPRESS_AGENT_LIFECYCLE).success).toBe(true);

  if (existsSync(PINNED_OAS_PATH) && existsSync(PINNED_MANIFEST_PATH)) {
    const pinned = JSON.parse(readFileSync(PINNED_MANIFEST_PATH, "utf8")) as {
      version?: string;
      cinatra?: { lifecycle?: unknown };
    };
    // Pin drift guard: the literal above must still BE what the pinned release
    // declares, or every CI-only run of this suite would prove the wrong thing.
    expect(pinned.cinatra?.lifecycle).toEqual(WORDPRESS_AGENT_LIFECYCLE);
    expect(pinned.version).toBe(WORDPRESS_AGENT_VERSION);
    return Promise.resolve({ oasPath: PINNED_OAS_PATH, fromPinnedTree: true });
  }

  return writeGitFileFixture({
    slug: "wordpress-agent",
    packageName: WORDPRESS_AGENT_PACKAGE,
    version: WORDPRESS_AGENT_VERSION,
    lifecycle: { ...WORDPRESS_AGENT_LIFECYCLE },
  }).then((oasPath) => ({ oasPath, fromPinnedTree: false }));
}

// ---------------------------------------------------------------------------
// Drive helpers — the review surface's own entry points, never a test stub
// ---------------------------------------------------------------------------

async function readLifecycleConfig(packageName: string): Promise<string | null | undefined> {
  const r = await pool(
    `SELECT lifecycle_config FROM "${q(TEST_SCHEMA)}"."agent_templates" WHERE package_name = $1`,
    [packageName],
  );
  if (r.rows.length === 0) return undefined;
  return (r.rows[0] as { lifecycle_config: string | null }).lifecycle_config;
}

async function seedRun(templateId: string): Promise<string> {
  const runId = `run-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, run_by, input_params)
     VALUES ($1,$2,$3,$4,'{}')`,
    [runId, templateId, ORG, MEMBER_USER],
  );
  return runId;
}

async function produce(producerRunId: string): Promise<ArtifactProducedEvent> {
  const artifactId = `art-${randomUUID()}`;
  const representationRevisionId = `rev-${randomUUID()}`;
  const ev: ArtifactProducedEvent = {
    eventId: producedEventId(artifactId, representationRevisionId),
    orgId: ORG,
    artifactId,
    representationRevisionId,
    eventKind: "artifact_produced",
    emitter: CMS_SNAPSHOT_EMITTER,
    producerRunId,
    producerAgentId: null,
    originKind: "agent_produced",
    destinationClass: "external_publish",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
  };
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id)
     VALUES ($1, $2, '{}'::jsonb, $3) ON CONFLICT (id) DO NOTHING`,
    [artifactId, NON_CORE_REPAIRABLE_OBJECT_TYPE, ORG],
  );
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

/**
 * A reviewer's typed `changes_requested` on the auto gate a loader-installed
 * template's production raised — the exact call the review surface's port makes
 * (`src/app/artifacts/[id]/review-gate-ports.ts`). Returns the resolved route.
 */
async function routeChangesRequestedFor(templateId: string): Promise<string> {
  const producerRunId = await seedRun(templateId);
  const base = await produce(producerRunId);

  await orch.sweepReviewOrchestration({ limit: 50 });
  const taskId = autoReviewTaskId(base.eventId);
  const gate = await gateStore.readReviewGate(producerRunId, taskId);
  expect(gate).not.toBeNull();

  const cr = await crStore.recordReviewSurfaceChangesRequested({
    runId: producerRunId,
    reviewTaskId: taskId,
    baseTarget: {
      artifactId: base.artifactId,
      representationRevisionId: base.representationRevisionId,
    },
    currentBaseRevisionId: base.representationRevisionId,
    feedback: "tighten the headline and fix the excerpt",
  });
  expect(cr.ok).toBe(true);
  if (!cr.ok) throw new Error(`changes-request failed: ${cr.error}`);
  return cr.route.kind;
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  const authAdmin = new Client({ connectionString: DB_URL });
  await authAdmin.connect();
  await authAdmin.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1,$2,$3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
  await authAdmin.query(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1,$2,$3,false, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [MEMBER_USER, MEMBER_USER, `${MEMBER_USER}@2044-gap2.test`],
  );
  await authAdmin.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1,$2,$3,'member', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-2044-gap2-${ORG}`, ORG, MEMBER_USER],
  );
  await authAdmin.end();

  tmpRoot = join(tmpdir(), `cinatra-2044-gap2-${randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });

  outboxStore = await import("../lifecycle-produced-outbox-store");
  gateStore = await import("../artifact-review-gate-store");
  orch = await import("../lifecycle-review-orchestration-store");
  crStore = await import("../lifecycle-review-changes-requested-store");
  loader = await import("../ensure-agent-package");
  dbMod = await import("../db");
}, 120_000);

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  if (!HAS_DB) return;
  delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  const authAdmin = new Client({ connectionString: DB_URL });
  await authAdmin.connect();
  await authAdmin
    .query(`DELETE FROM public."member" WHERE "userId" = $1`, [MEMBER_USER])
    .catch(() => {});
  await authAdmin.query(`DELETE FROM public."user" WHERE id = $1`, [MEMBER_USER]).catch(() => {});
  await authAdmin.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]).catch(() => {});
  await authAdmin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)(
  "cinatra#2044 GAP 2 — the manifest lifecycle declaration survives the loader/ZIP install path",
  () => {
    /** Installed once (agent_templates.package_name is UNIQUE, and the loader's
     * own version-skip guard makes a second identical install a no-op). */
    let wordpressTemplateId: string | null = null;

    it("the git-file loader install of a repair-capable producer POPULATES lifecycle_config", async () => {
      const { oasPath, fromPinnedTree } = await resolveWordPressFixture();
      // The column is NULL before the install — the wave124 starting state.
      expect(await readLifecycleConfig(WORDPRESS_AGENT_PACKAGE)).toBeUndefined();

      const result = await loader.ensureAgentPackageFromGitFile({
        oasSourcePath: oasPath,
        // Exactly what dev-boot / the hot-reload watcher pass.
        licenseAcknowledged: true,
      });
      expect(result.skipped).toBe(false);
      expect(result.templateId).toBeTruthy();
      wordpressTemplateId = result.templateId;

      // THE FIX, read back with SQL from the real row the loader wrote: the
      // declaration the manifest carries is now on the column that
      // `resolveRepairCapable` reads. Before the change under proof this was
      // NULL for every loader/ZIP install (wave124).
      expect(await readLifecycleConfig(WORDPRESS_AGENT_PACKAGE)).toBe(EXPECTED_LIFECYCLE_CONFIG);
      // Recorded so a failure says WHICH source the drive used.
      expect(typeof fromPinnedTree).toBe("boolean");
    }, 120_000);

    it("wave124 repro: that installed template's changes_requested routes producer_repair, not human_escalation", async () => {
      expect(wordpressTemplateId).toBeTruthy();
      // No hand-seeding of lifecycle_config anywhere in this suite — the value
      // the router reads is the one the loader install just wrote.
      expect(await readLifecycleConfig(WORDPRESS_AGENT_PACKAGE)).toBe(EXPECTED_LIFECYCLE_CONFIG);

      const routeKind = await routeChangesRequestedFor(wordpressTemplateId!);
      expect(routeKind).toBe("producer_repair");
    }, 120_000);

    it("UPGRADE: an ALREADY-INSTALLED row at the SAME version whose lifecycle_config is NULL is repaired on the next loader run", async () => {
      // The state wave124 actually found in the wild, and the one a fix that
      // only projects on a FRESH install would never reach: 0.1.6 is already
      // installed, so the loader's version-skip guard short-circuits every boot
      // and the NULL column survives forever. Reproduced exactly — take the row
      // the first case installed and put the column back to its pre-fix value.
      expect(wordpressTemplateId).toBeTruthy();
      await pool(
        `UPDATE "${q(TEST_SCHEMA)}"."agent_templates" SET lifecycle_config = NULL WHERE id = $1`,
        [wordpressTemplateId],
      );
      expect(await readLifecycleConfig(WORDPRESS_AGENT_PACKAGE)).toBeNull();

      const { oasPath } = await resolveWordPressFixture();
      const rerun = await loader.ensureAgentPackageFromGitFile({
        oasSourcePath: oasPath,
        licenseAcknowledged: true,
      });
      // NOT skipped: the version matches but the derived projection drifted.
      expect(rerun.skipped).toBe(false);
      expect(rerun.templateId).toBe(wordpressTemplateId);
      expect(await readLifecycleConfig(WORDPRESS_AGENT_PACKAGE)).toBe(EXPECTED_LIFECYCLE_CONFIG);
      expect(await routeChangesRequestedFor(wordpressTemplateId!)).toBe("producer_repair");

      // …and the repair CONVERGES: with the row now current, the next identical
      // run takes the version-skip early return again (no re-import loop).
      const settled = await loader.ensureAgentPackageFromGitFile({
        oasSourcePath: oasPath,
        licenseAcknowledged: true,
      });
      expect(settled.skipped).toBe(true);
      expect(await readLifecycleConfig(WORDPRESS_AGENT_PACKAGE)).toBe(EXPECTED_LIFECYCLE_CONFIG);
    }, 120_000);

    it("CONTROL: a manifest with NO lifecycle block leaves the column NULL and still escalates to a human", async () => {
      // Proves the two assertions above are not vacuous — the same loader, the
      // same router, the same non-core-repairable artifact type; only the
      // manifest declaration differs. Also pins back-compat for every published
      // package that declares nothing.
      const packageName = "@cinatra-ai/loader-path-control-agent";
      const oasPath = await writeGitFileFixture({
        slug: "loader-path-control-agent",
        packageName,
        version: "0.1.0",
      });
      const result = await loader.ensureAgentPackageFromGitFile({ oasSourcePath: oasPath });
      expect(result.skipped).toBe(false);

      expect(await readLifecycleConfig(packageName)).toBeNull();
      expect(await routeChangesRequestedFor(result.templateId)).toBe("human_escalation");
    }, 120_000);

    it("NON-DESTRUCTIVE: a VANISHED sibling manifest must not clear a populated lifecycle_config", async () => {
      // codex round 1 — the destructive direction the fix must not open. The
      // loader always SYNTHESIZES the ZIP's package.json, so once the importer
      // began compiling that synthesis onto the column, an agent tree whose
      // sibling manifest is missing (a partial clone-back, a transient ENOENT
      // mid-write, an OAS-only tree) would hand the importer a hollow "declares
      // nothing" and WIPE a correct declaration off the installed row — turning a
      // repair-capable producer back into human_escalation, i.e. re-creating the
      // exact wave124 symptom this issue exists to remove.
      const packageName = "@cinatra-ai/loader-path-vanishing-manifest-agent";
      const slug = "loader-path-vanishing-manifest-agent";
      const oasPath = await writeGitFileFixture({
        slug,
        packageName,
        version: "0.2.0",
        lifecycle: { repairCapable: true },
      });
      const installed = await loader.ensureAgentPackageFromGitFile({ oasSourcePath: oasPath });
      expect(installed.skipped).toBe(false);
      expect(await readLifecycleConfig(packageName)).toBe(EXPECTED_LIFECYCLE_CONFIG);
      expect(await routeChangesRequestedFor(installed.templateId)).toBe("producer_repair");

      // The manifest disappears; the OAS (which carries the packageName) stays,
      // so the loader still has an identity and proceeds past its name guard.
      await rm(join(tmpRoot!, slug, "package.json"));

      // The re-import genuinely RUNS (with the manifest gone the derived version
      // is undefined, so the version-skip guard is not even entered — pre-existing
      // behaviour, unchanged here). It reaches the same upsert that writes every
      // other manifest-derived column, which is exactly why the column had to be
      // protected at the importer rather than by hoping the write never happens.
      const rerun = await loader.ensureAgentPackageFromGitFile({ oasSourcePath: oasPath });
      expect(rerun.templateId).toBe(installed.templateId);

      // THE ASSERTION: the declaration SURVIVED the re-import, and the router
      // still routes a changes-request to the producer instead of a human.
      expect(await readLifecycleConfig(packageName)).toBe(EXPECTED_LIFECYCLE_CONFIG);
      expect(await routeChangesRequestedFor(installed.templateId)).toBe("producer_repair");

      // Stable, not a one-run fluke: a second identical scan (every boot does one)
      // leaves it alone too.
      await loader.ensureAgentPackageFromGitFile({ oasSourcePath: oasPath });
      expect(await readLifecycleConfig(packageName)).toBe(EXPECTED_LIFECYCLE_CONFIG);
    }, 120_000);
  },
);

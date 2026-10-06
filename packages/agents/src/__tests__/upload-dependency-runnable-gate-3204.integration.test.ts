/**
 * AN UPLOADED AGENT WHOSE DECLARED DEPENDENCY ARRIVED THROUGH EITHER ROAD IS
 * RUNNABLE AND LISTED (cinatra#3204 criterion 25) — against a REAL Postgres.
 *
 * The criterion, in its own words: "`assertAgentPackageRunnable` admits an
 * agent whose declared dependency was installed through either road, and the
 * agent is returned by MCP `agent_list`. This is an integration assertion over
 * the new road, not a change to the gate."
 *
 * The two roads are the two ways a declared PACK dependency reaches the
 * instance through the upload screen after the maintainer's decision on
 * criterion 24 (the connected registry, never a closure bundled in the upload):
 *
 *   - FROM THE REGISTRY: the agent is uploaded while its dependency is absent,
 *     and the upload road's own registry step installs the dependency through
 *     the store's dependency saga before the agent (arms A and B, the file road
 *     and the repository road);
 *   - IN AN UPLOAD: the dependency is uploaded as its own package first, and
 *     the agent's upload then installs nothing from the registry (arm C).
 *
 * Arm R is the refusal that proves the admissions are not vacuous: the same
 * agent, its own row active, its dependency no longer live — the gate refuses
 * naming the dependency and discovery drops the agent.
 *
 * THE FIXTURE IS A PACKAGE THE GENERATED CATALOG GOVERNS AT THE INSTALLED
 * VERSION. The gate reads an agent's dependency edges only from the generated
 * catalog, and only when the catalog record describes the version in question;
 * an ungoverned or differently-versioned agent is runnable whatever its
 * dependencies. So the fixture is the catalog's own opt-in agent and its own
 * required edge, and the first case asserts that premise.
 *
 * REAL: the upload actions, the scope resolution and its authorization, the
 * manifest parser and the registry-step planner, the store's saga with its
 * planner and its durable ledger, the canonical store, the access write, the
 * template store, the generated catalog, the gate with its DEFAULT readers
 * (no injected `readStatus`, `readCatalog` or `isBlockingEdge`), and the
 * `agent_list` filter over the rows the handler reads.
 *
 * SUBSTITUTED, each at its own module boundary:
 *   - the signed-in admin session (`@/lib/auth-session`);
 *   - the archive and repository preparation that produce the prepared
 *     snapshot, and the dispatch that consumes those staged bytes — replaced by
 *     a REAL canonical insert through the lifecycle primitive plus the template
 *     row through the store's own writer (`@/lib/supplied-package-install`);
 *   - the registry reads — the packument and summary resolution
 *     (`@cinatra-ai/registries`), the registry read config
 *     (`@/lib/verdaccio-config`) and the gatekept authorize
 *     (`@/lib/gatekept-install`);
 *   - inside the REAL saga, only the tarball fetch and dispatch of a member
 *     (a REAL canonical insert per member instead) and the agent-runtime reload.
 *
 * Run: CINATRA_TEST_DB_URL=<db> pnpm exec vitest run --config
 * vitest.integration.config.ts <this file>
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import * as semver from "semver";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import { runAllCleanups } from "./__fixtures__/integration-fixture-helpers";

const DB_URL = process.env.SUPABASE_DB_URL;
const HAS_DB = typeof DB_URL === "string" && DB_URL.length > 0 && !isPlaceholderDbUrl(DB_URL);

const TEST_SCHEMA = `cinatra_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const q = (s: string) => s.replaceAll('"', '""');

// THE FIXTURE — the generated catalog's own opt-in agent and its one required
// pack dependency. Both are public packages of the organisation.
const AGENT = "@cinatra-ai/email-test-delivery-agent";
const AGENT_VERSION = "0.1.2";
const DEP = "@cinatra-ai/email-delivery-agent";
const DEP_LABEL = "Email Delivery Agent (@cinatra-ai/email-delivery-agent)";

// Suite-unique Better Auth rows: `public` is shared by every suite in the DB.
const ORG = `org-upload-gate-${randomUUID().slice(0, 8)}`;
const USER = `user-upload-gate-${randomUUID().slice(0, 8)}`;
const TARGET = { level: "organization", id: ORG } as const;

type CatalogDependency = {
  packageName: string;
  kind?: string;
  edgeType?: string;
  requirement?: string;
  versionConstraint?: { kind: string; range?: string };
};
type CatalogRecord = {
  packageName: string;
  kind: string;
  version: string;
  resolution?: string;
  displayName?: string | null;
  dependencies?: CatalogDependency[];
};

const seams = vi.hoisted(() => ({
  session: {
    user: { id: "", role: "admin" },
    session: { activeOrganizationId: "" },
  },
  /** The connected registry: package name -> its one published manifest. */
  registry: new Map<string, { version: string; kind: string; manifest: Record<string, unknown> }>(),
  /** Every package the dispatch seam and the member seam wrote, in order. */
  written: [] as string[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => seams.session),
  buildCanDoOptsFromSession: vi.fn(async () => ({ orgRole: "org_owner" })),
}));

vi.mock("@/lib/gatekept-install", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gatekept-install")>()),
  isGatekeptInstallEnabled: () => false,
}));

vi.mock("@/lib/verdaccio-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/verdaccio-config")>()),
  loadVerdaccioConfigForReads: vi.fn(async () => ({})),
}));

vi.mock("@cinatra-ai/registries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cinatra-ai/registries")>()),
  getPublishedExtensionSummary: vi.fn(
    async (input: { packageName: string; packageVersion?: string }) => {
      const published = seams.registry.get(input.packageName);
      if (!published || (input.packageVersion && input.packageVersion !== published.version)) {
        throw new Error(`${input.packageName}@${input.packageVersion ?? "latest"} not found in the registry`);
      }
      return { kind: published.kind, resolvedVersion: published.version, manifest: published.manifest };
    },
  ),
  resolveMaxSatisfyingVersion: vi.fn(async (input: { packageName: string; range: string }) => {
    const published = seams.registry.get(input.packageName);
    return published ? semver.maxSatisfying([published.version], input.range) : null;
  }),
}));

// The archive and repository preparation, and the dispatch of the staged bytes.
vi.mock("@/lib/supplied-package-install", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supplied-package-install")>();
  const digest = (text: string) => (Buffer.from(text).toString("hex") + "0".repeat(64)).slice(0, 64);
  return {
    ...actual,
    // The "archive" the test uploads is its manifest text; the preparation
    // reads the package identity back from those bytes.
    prepareSuppliedArchiveSnapshot: vi.fn(async (input: { archive: Uint8Array }) => {
      const packageJson = Buffer.from(input.archive).toString("utf8");
      const manifest = JSON.parse(packageJson) as { name: string; version: string; cinatra: { kind: string } };
      const provenance = {
        type: "local",
        path: `${manifest.name.split("/")[1]}.zip`,
        resolvedCommitOrTreeHash: digest(manifest.name),
        contentDigest: digest(manifest.name),
      };
      return {
        package: {
          kind: manifest.cinatra.kind,
          packageName: manifest.name,
          version: manifest.version,
          contentDigest: digest(manifest.name),
          packageJson,
          provenance,
        },
        tarball: new Uint8Array([1]),
        provenance,
        validatorRan: true,
      };
    }),
    prepareSuppliedRepositoryArchiveSnapshot: vi.fn(
      async (input: { owner: string; repo: string; ref: string | null; pin: { resolvedSha: string; contentDigest: string } }) => {
        const packageName = `@${input.owner}/${input.repo}`;
        const published = seams.registry.get(`upload:${packageName}`);
        if (!published) throw new Error(`no fixture repository for ${packageName}`);
        return {
          kind: published.kind,
          packageName,
          version: published.version,
          provenance: {
            type: "github",
            repo: `${input.owner}/${input.repo}`,
            ref: input.ref ?? "main",
            resolvedSha: input.pin.resolvedSha,
            contentDigest: input.pin.contentDigest,
          },
          validatorRan: true,
          packageJson: JSON.stringify(published.manifest),
        };
      },
    ),
    // The dispatch of the staged bytes: the canonical row through the REAL
    // lifecycle primitive at the anchor the road hands it, and — for an agent —
    // the template through the store's own writer at the native anchor.
    installSuppliedCandidate: vi.fn(
      async (input: {
        candidate: { kind: string; packageName: string; version: string; provenance: Record<string, unknown> };
        actor: { userId?: string; orgId?: string | null };
        rowOwnership: { ownerLevel: string; ownerId: string | null; organizationId: string | null };
      }) => {
        const { installExtensionManifest } = await import("@cinatra-ai/extensions/lifecycle-primitive");
        const { resolveNativeInstallOwnership } = await import("@cinatra-ai/extensions/canonical-types");
        const { createAgentTemplate } = await import("../store");
        const { candidate, rowOwnership } = input;
        await installExtensionManifest(
          {
            id: `iext_${randomUUID()}`,
            packageName: candidate.packageName,
            kind: candidate.kind,
            ownerLevel: rowOwnership.ownerLevel,
            ownerId: rowOwnership.ownerId,
            organizationId: rowOwnership.organizationId,
            requiredInProd: false,
            manifestHash: null,
            dependencies: [],
            version: candidate.version,
            source: candidate.provenance,
          } as never,
          { actor: { source: "ui", orgId: input.actor.orgId ?? undefined, userId: input.actor.userId }, reason: "supplied install fixture" },
        );
        if (candidate.kind === "agent") {
          const native = resolveNativeInstallOwnership(input.actor.orgId ?? null, rowOwnership as never);
          await createAgentTemplate({
            id: `t_${randomUUID()}`,
            name: candidate.packageName.split("/")[1] ?? candidate.packageName,
            sourceNl: "x",
            compiledPlan: [],
            inputSchema: {},
            approvalPolicy: { steps: [] },
            packageName: candidate.packageName,
            packageVersion: candidate.version,
            status: "active",
            ...(native.anchorOrgId ? { orgId: native.anchorOrgId } : {}),
            ...(native.ownerLevel ? { ownerLevel: native.ownerLevel } : {}),
            ...(native.ownerId ? { ownerId: native.ownerId } : {}),
          } as never);
        }
        seams.written.push(candidate.packageName);
      },
    ),
  };
});

// THE STORE'S OWN SAGA, run for real with its default dependencies: only the
// member's tarball fetch + dispatch (a REAL canonical insert per member) and
// the agent-runtime reload are substituted. The spy is what arm C reads.
vi.mock("@/lib/extension-install-batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/extension-install-batch")>();
  return {
    ...actual,
    installExtensionWithDependencies: vi.fn(
      async (input: Parameters<typeof actual.installExtensionWithDependencies>[0]) => {
        const real = await actual.makeDefaultInstallBatchSagaDeps();
        return actual.installExtensionWithDependencies(input, {
          ...real,
          isGatekeptInstallEnabled: () => false,
          triggerAgentRuntimeReload: async () => ({ ok: true as const }),
          installMember: async (member, actor) => {
            const { installExtensionManifest } = await import("@cinatra-ai/extensions/lifecycle-primitive");
            const organizationId = member.rowOwnership?.organizationId ?? actor.orgId ?? null;
            await installExtensionManifest(
              {
                id: `iext_${randomUUID()}`,
                packageName: member.packageName,
                kind: member.typeId,
                ownerLevel: member.rowOwnership?.ownerLevel ?? (organizationId ? "organization" : "platform"),
                ownerId: member.rowOwnership?.ownerId ?? organizationId,
                organizationId,
                requiredInProd: false,
                manifestHash: null,
                dependencies: [],
                source: {
                  type: "verdaccio",
                  registryUrl: "connected-registry-fixture",
                  packageName: member.packageName,
                  version: member.version,
                  integrity: `sha512-${"b".repeat(86)}`,
                  resolvedAt: new Date().toISOString(),
                },
              } as never,
              { actor: { source: "worker" }, reason: "registry member fixture" },
            );
            seams.written.push(member.packageName);
          },
        });
      },
    ),
  };
});

type Catalog = Record<string, CatalogRecord>;
let catalog: Catalog;
let admin: Client;
let actions: typeof import("../supplied-install-actions");
let gate: typeof import("../runtime-install-gate");
let agentStore: typeof import("../store");
let canonical: typeof import("@cinatra-ai/extensions/canonical-store");
let primitive: typeof import("@cinatra-ai/extensions/lifecycle-primitive");
let batch: typeof import("@/lib/extension-install-batch");
let batchOps: typeof import("@/lib/extension-install-batch-ops");

/** The package's own manifest text, built from its catalog record. */
function manifestOf(packageName: string, version?: string): Record<string, unknown> {
  const record = catalog[packageName];
  if (!record) throw new Error(`fixture: ${packageName} is not in the generated catalog`);
  return {
    name: packageName,
    version: version ?? record.version,
    cinatra: { kind: record.kind, dependencies: record.dependencies ?? [] },
  };
}

/** The dependency's closure, as the connected registry publishes it. */
function publishClosure(root: string): string[] {
  const seen: string[] = [];
  const walk = (name: string) => {
    if (seen.includes(name)) return;
    const record = catalog[name];
    if (!record) throw new Error(`fixture: ${name} is not in the generated catalog`);
    seen.push(name);
    seams.registry.set(name, { version: record.version, kind: record.kind, manifest: manifestOf(name) });
    for (const dep of record.dependencies ?? []) walk(dep.packageName);
  };
  walk(root);
  return seen;
}

function uploadFile(packageName: string, version?: string) {
  const text = JSON.stringify(manifestOf(packageName, version));
  return actions.installSuppliedArchiveAction({
    zipBase64: Buffer.from(text).toString("base64"),
    accessTarget: TARGET,
  });
}

function uploadRepository(packageName: string, version?: string) {
  const record = catalog[packageName]!;
  seams.registry.set(`upload:${packageName}`, {
    version: version ?? record.version,
    kind: record.kind,
    manifest: manifestOf(packageName, version),
  });
  return actions.installSuppliedRepositoryAction({
    repoUrl: packageName.slice(1),
    ref: "main",
    pin: { resolvedSha: "e".repeat(40), contentDigest: "a".repeat(64) },
    accessTarget: TARGET,
  });
}

/** The canonical rows of `names`, by named columns. */
async function canonicalRows(names: string[]) {
  const { rows } = await admin.query<{
    package_name: string;
    kind: string;
    status: string;
    owner_level: string;
    organization_id: string | null;
    source_type: string;
  }>(
    `SELECT package_name, kind, status, owner_level, organization_id, source->>'type' AS source_type
       FROM "${q(TEST_SCHEMA)}"."installed_extension"
      WHERE package_name = ANY($1)
      ORDER BY created_at, package_name`,
    [names],
  );
  return rows;
}

/** What `agent_list` answers for the operator's organization: the handler's
 *  own reader, filtered by the handler's own gate. */
async function agentList(): Promise<string[]> {
  const page = await agentStore.readAgentTemplates({ packageName: AGENT, organizationId: ORG });
  const shown = await gate.partitionRunnableAgentPackages(page.items);
  return shown.map((t) => t.packageName ?? "");
}

async function templateId(): Promise<string> {
  const template = await agentStore.readAgentTemplateByPackageName(AGENT);
  if (!template) throw new Error("fixture: the uploaded agent has no template row");
  return template.id;
}

async function expectAdmittedAndListed(): Promise<void> {
  const id = await templateId();
  const template = await agentStore.readAgentTemplateByPackageName(AGENT);
  expect(template?.packageVersion).toBe(AGENT_VERSION);
  expect(
    await gate.assertAgentPackageRunnable(AGENT, id, { packageVersion: template?.packageVersion ?? null }),
  ).toBeNull();
  expect(await agentList()).toEqual([AGENT]);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  // MUST precede every store import: each store binds its pgSchema at load.
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
  await replayStoreSchema(admin, buildCreateStoreSchemaQueries(TEST_SCHEMA));
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
  await admin.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG],
  );
  await admin.query(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $1, $2, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [USER, `${USER}@upload-gate.test`],
  );
  seams.session.user.id = USER;
  seams.session.session.activeOrganizationId = ORG;

  catalog = (await import("@/lib/generated/extensions.server")).STATIC_EXTENSION_MANIFEST as unknown as Catalog;
  actions = await import("../supplied-install-actions");
  gate = await import("../runtime-install-gate");
  agentStore = await import("../store");
  canonical = await import("@cinatra-ai/extensions/canonical-store");
  primitive = await import("@cinatra-ai/extensions/lifecycle-primitive");
  batch = await import("@/lib/extension-install-batch");
  batchOps = await import("@/lib/extension-install-batch-ops");
}, 240_000);

afterEach(async () => {
  if (!HAS_DB) return;
  vi.clearAllMocks();
  seams.registry.clear();
  seams.written.length = 0;
  const names = Object.keys(catalog);
  const s = `"${q(TEST_SCHEMA)}"`;
  await runAllCleanups([
    () =>
      admin.query(
        `DELETE FROM ${s}."extension_access_policy" WHERE resource_id IN (SELECT id FROM ${s}."agent_templates" WHERE package_name = ANY($1))`,
        [names],
      ),
    () =>
      admin.query(
        `DELETE FROM ${s}."agent_versions" WHERE template_id IN (SELECT id FROM ${s}."agent_templates" WHERE package_name = ANY($1))`,
        [names],
      ),
    () => admin.query(`DELETE FROM ${s}."agent_templates" WHERE package_name = ANY($1)`, [names]),
    () => admin.query(`DELETE FROM ${s}."extension_install_batches" WHERE root_package = ANY($1)`, [names]),
    // The canonical rows leave through the lifecycle primitive, never raw SQL:
    // the canonical-gate-reach guard confines these writes to the store.
    async () => {
      for (const rows of (await canonical.readInstalledExtensionsByPackageNames(names)).values()) {
        for (const row of rows) {
          await primitive.transitionExtensionLifecycle(row.id, "force_delete", {
            actor: { source: "worker" },
            reason: "integration fixture reset",
          });
        }
      }
    },
  ]);
});

afterAll(async () => {
  if (!HAS_DB) return;
  vi.restoreAllMocks();
  vi.resetModules();
  try {
    await runAllCleanups([
      () => admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`),
      () => admin.query(`DELETE FROM public."user" WHERE id = $1`, [USER]),
      () => admin.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]),
    ]);
  } finally {
    // A failed cleanup still closes the connection and clears the flag.
    await admin.end();
    delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
  }
});

describe.skipIf(!HAS_DB)("cinatra#3204 criterion 25 — an uploaded agent with its dependency is runnable and listed (real Postgres)", () => {
  it("premise: the generated catalog governs the fixture agent at the installed version with one required edge to its dependency", () => {
    const record = catalog[AGENT];
    expect(record?.version).toBe(AGENT_VERSION);
    expect(record?.resolution).toBe("guardedOptional");
    const required = (record?.dependencies ?? []).filter(
      (d) => d.requirement === "required" && d.edgeType !== "peer",
    );
    expect(required.map((d) => d.packageName)).toEqual([DEP]);
    expect(catalog[DEP]?.displayName).toBe("Email Delivery Agent");
  });

  it("ARM A — from the registry, on the file road: the dependency is installed first and the gate admits the agent, which agent_list returns", async () => {
    const closure = publishClosure(DEP);
    expect(await canonicalRows([AGENT, ...closure])).toEqual([]);

    const result = await uploadFile(AGENT, AGENT_VERSION);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, packageName: AGENT, version: AGENT_VERSION });

    // The REAL saga ran once, for the dependency, before the agent's dispatch.
    const saga = vi.mocked(batch.installExtensionWithDependencies);
    expect(saga).toHaveBeenCalledTimes(1);
    expect(saga.mock.calls[0]![0]).toMatchObject({ packageName: DEP, version: catalog[DEP]!.version });
    expect(seams.written.indexOf(DEP)).toBeLessThan(seams.written.indexOf(AGENT));

    // The dependency's row, read back through the canonical store at the scope.
    const depRow = await canonical.readInstalledExtensionByIdentity({
      organizationId: ORG,
      ownerLevel: "organization",
      ownerId: ORG,
      packageName: DEP,
    } as never);
    expect(depRow?.status).toBe("active");
    const rows = await canonicalRows([AGENT, DEP]);
    expect(rows).toEqual([
      expect.objectContaining({ package_name: DEP, status: "active", organization_id: ORG, source_type: "verdaccio" }),
      expect.objectContaining({ package_name: AGENT, status: "active", organization_id: ORG, source_type: "local" }),
    ]);
    // The saga's durable ledger closed its batch.
    const ledger = await batchOps.listRecentInstallBatches({ limit: 10, orgId: ORG });
    expect(ledger.find((b) => b.rootPackage === DEP)?.phase).toBe("finalized");

    await expectAdmittedAndListed();
  }, 120_000);

  it("ARM B — from the registry, on the repository road: the dependency is installed first and the gate admits the agent, which agent_list returns", async () => {
    publishClosure(DEP);

    const result = await uploadRepository(AGENT, AGENT_VERSION);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, packageName: AGENT, version: AGENT_VERSION });

    const saga = vi.mocked(batch.installExtensionWithDependencies);
    expect(saga).toHaveBeenCalledTimes(1);
    expect(saga.mock.calls[0]![0]).toMatchObject({ packageName: DEP });
    expect(seams.written.indexOf(DEP)).toBeLessThan(seams.written.indexOf(AGENT));
    expect(await canonicalRows([AGENT, DEP])).toEqual([
      expect.objectContaining({ package_name: DEP, status: "active", organization_id: ORG, source_type: "verdaccio" }),
      expect.objectContaining({ package_name: AGENT, status: "active", organization_id: ORG, source_type: "github" }),
    ]);

    await expectAdmittedAndListed();
  }, 120_000);

  it("ARM C — in an upload: the dependency uploaded as its own package first, the agent's upload calls no saga, and the gate admits the agent, which agent_list returns", async () => {
    // The dependency's OWN declared closure still comes from the registry.
    publishClosure(DEP);
    seams.registry.delete(DEP);

    const depResult = await uploadFile(DEP);
    expect(depResult, JSON.stringify(depResult)).toMatchObject({ ok: true, packageName: DEP });
    expect(await canonicalRows([DEP])).toEqual([
      expect.objectContaining({ package_name: DEP, status: "active", organization_id: ORG, source_type: "local" }),
    ]);

    vi.mocked(batch.installExtensionWithDependencies).mockClear();
    const result = await uploadFile(AGENT, AGENT_VERSION);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, packageName: AGENT, version: AGENT_VERSION });

    // Nothing from the registry: the dependency was already installed.
    expect(batch.installExtensionWithDependencies).not.toHaveBeenCalled();
    expect(await canonicalRows([AGENT, DEP])).toEqual([
      expect.objectContaining({ package_name: DEP, status: "active", source_type: "local" }),
      expect.objectContaining({ package_name: AGENT, status: "active", source_type: "local" }),
    ]);

    await expectAdmittedAndListed();
  }, 120_000);

  it("ARM R — the refusal: the agent's row active, its dependency archived through the lifecycle road — the gate names the dependency and agent_list drops the agent", async () => {
    publishClosure(DEP);
    const result = await uploadFile(AGENT, AGENT_VERSION);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });

    const depRow = await canonical.readInstalledExtensionByIdentity({
      organizationId: ORG,
      ownerLevel: "organization",
      ownerId: ORG,
      packageName: DEP,
    } as never);
    expect(depRow).not.toBeNull();
    await primitive.transitionExtensionLifecycle(depRow!.id, "archive", {
      actor: { source: "ui", orgId: ORG, userId: USER },
      reason: "criterion 25 refusal arm",
    });
    expect(await canonicalRows([AGENT, DEP])).toEqual([
      expect.objectContaining({ package_name: DEP, status: "archived" }),
      expect.objectContaining({ package_name: AGENT, status: "active" }),
    ]);

    const id = await templateId();
    const refusal = await gate.assertAgentPackageRunnable(AGENT, id, { packageVersion: AGENT_VERSION });
    expect(refusal?.error).toContain(DEP_LABEL);
    expect(refusal?.error).toContain("not installed");
    expect(await agentList()).toEqual([]);
  }, 120_000);
});

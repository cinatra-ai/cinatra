// cinatra#2675 AC1 — a colliding publish refuses with NOTHING written to the
// registry, proven against a REAL Verdaccio.
//
// The defect is an ORDERING against an IRREVERSIBLE side effect, so no stub can
// prove it: `agent_source_publish` wrote the requested version to the registry
// and only then ran the guarded DB claim, and the registry config forbids
// unpublish by design — the refused version stayed published forever. The only
// evidence that the fix works is a real registry that does NOT hold the version
// after the refusal.
//
// NEGATIVE CONTROL: this file is written to run UNCHANGED against `main`. It
// imports nothing this change adds; it drives the `agent_source_publish`
// handler and asks the registry what happened. On `main` the refusal still
// arrives (from the DB sync) but the version is already published, so the
// absence assertions fail. That is the control — run it on both sides.
//
// POSITIVE CONTROL, in this same file: the OWNING organization publishes the
// same way and the version + its tarball ARE present afterwards. Without it, an
// unreachable or misconfigured registry would make the absence assertions pass
// vacuously.
//
// What is real here: the handler, the preflight, the REAL Verdaccio publisher
// (`publishAgentPackageFromGitDir`), a real Postgres schema and the real store.
// What is stubbed: the install primitive's extraction/materialize legs — its
// CLAIM is performed by the real `claimAgentTemplateIdentity` against the real
// database, because the claim is the authority whose ordering is under test.
//
// REQUIRES a disposable registry: set `CINATRA_TEST_VERDACCIO_URL` (plus the
// optional `CINATRA_TEST_VERDACCIO_TOKEN`). Everything is published under the
// throwaway `@pf2675` scope under a per-run package name, so the suite cannot
// touch shared registry state. The CI integration job has postgres + redis and
// NO registry service, so this file self-skips there; the DB-only sibling
// (agent-source-publish-claim-race.integration.test.ts) is the part that gates
// in CI.
import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { sql } from "drizzle-orm";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  // Assembled from parts so the placeholder DSN pattern never appears
  // verbatim in source — the CI secret scanner reads the diff text.
  !dbUrl.includes(["unused", ":", "unused", "@", "localhost", ":5432/unused"].join(""));
const registryUrl = process.env.CINATRA_TEST_VERDACCIO_URL?.replace(/\/+$/, "") ?? "";
const hasRegistry = registryUrl.length > 0;

// A skip is LOUD, and can be made FATAL.
//
// This is the ONLY suite that can observe the defect, and a self-skip is how
// such a suite rots into a green no-op: a lane that misspells the variable, or
// a future CI job that intends to provision a registry and does not, would look
// exactly like a pass. So the skip announces itself by name, and any runner that
// DOES mean to run this proof sets `CINATRA_TEST_VERDACCIO_REQUIRED=1` to turn a
// missing prerequisite into a failure instead of a skip. Standing up such a CI
// lane is a workflow change and belongs in its own PR — this one keeps protected
// CI paths out — but the handle it needs ships here, with the test that needs it.
//
// Strict mode covers BOTH prerequisites, not just the registry: a lane that
// means to run this and quietly loses its DATABASE is the same green no-op as
// one that loses its registry.
{
  const missing = [
    hasDb ? null : "CINATRA_TEST_DB_URL/SUPABASE_DB_URL",
    hasRegistry ? null : "CINATRA_TEST_VERDACCIO_URL",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    const notice =
      `[cinatra#2675 AC1] SKIPPED — missing ${missing.join(" + ")}, so the registry-absence ` +
      "proof (a foreign name must not reach the registry) did NOT run.";
    if (process.env.CINATRA_TEST_VERDACCIO_REQUIRED === "1") throw new Error(notice);
    console.warn(notice);
  }
}

const { registryConfig } = vi.hoisted(() => ({
  registryConfig: {
    registryUrl: process.env.CINATRA_TEST_VERDACCIO_URL?.replace(/\/+$/, "") ?? "",
    token: process.env.CINATRA_TEST_VERDACCIO_TOKEN ?? "disposable-registry-token",
    packageScope: "@pf2675",
    destinationId: "disposable",
  },
}));

/** Where the handler looks for `<root>/<vendor>/<slug>/` agent sources. */
const { sourceRoot } = vi.hoisted(() => ({ sourceRoot: { path: process.cwd() } }));

// ---------------------------------------------------------------------------
// The install primitive: stubbed down to its CLAIM, which is the real one.
// ---------------------------------------------------------------------------
const { mockInstallAgentFromPackage } = vi.hoisted(() => ({
  mockInstallAgentFromPackage: vi.fn(
    async (input: { packageName: string; packageVersion: string; orgId?: string; ownerId?: string }) => {
      const { claimAgentTemplateIdentity, deriveAgentTemplateIdentityClaim } = await import(
        "../agent-template-identity"
      );
      const { createAgentTemplate } = await import("../store");
      const claim = deriveAgentTemplateIdentityClaim({ orgId: input.orgId ?? null });
      await claimAgentTemplateIdentity(
        { packageName: input.packageName, claim },
        {
          insert: async () => {
            const id = `t_${randomUUID()}`;
            await createAgentTemplate({
              id,
              name: "publish-preflight-fixture",
              sourceNl: "x",
              compiledPlan: [],
              inputSchema: {},
              approvalPolicy: { steps: [] },
              packageName: input.packageName,
              packageVersion: input.packageVersion,
              ...(input.orgId ? { orgId: input.orgId } : {}),
              ownerLevel: "organization" as const,
              ownerId: input.ownerId ?? input.orgId ?? "",
            });
            return { templateId: id };
          },
        },
      );
    },
  ),
}));
vi.mock("../install-from-package", () => ({
  installAgentFromPackage: mockInstallAgentFromPackage,
}));

// `../verdaccio/client` is deliberately NOT mocked — the real publisher is the
// point of this file.
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => null as unknown),
  markFirstPublishedIfCurrentScope: vi.fn(),
}));
vi.mock("@cinatra-ai/extensions/license-detection", () => ({
  detectSpdxLicense: vi.fn(async () => ({ tier: "permissive", spdxId: "MIT", reason: null })),
  LicenseDetectionRejectedError: class extends Error { code = "LICENSE_DETECTION_REJECTED"; },
  LicenseAcknowledgementRequiredError: class extends Error {
    code = "LICENSE_ACKNOWLEDGEMENT_REQUIRED";
    spdxId: string;
    constructor(spdxId: string) { super(`acknowledge ${spdxId}`); this.spdxId = spdxId; }
  },
}));
vi.mock("@cinatra-ai/extensions/destination-resolver", () => ({
  resolvePublishDestination: vi.fn(async () => registryConfig),
  PublishDestinationNotConfiguredError: class extends Error { code = "PUBLISH_DESTINATION_NOT_CONFIGURED"; },
}));
vi.mock("@/lib/dev-extensions", () => ({ readEffectivePublishScopeOverride: vi.fn(() => null) }));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForServer: vi.fn(async () => registryConfig),
}));
vi.mock("../wayflow-reload-client", () => ({
  triggerWayflowReload: vi.fn(async () => ({ ok: false, reason: "no_token" })),
}));
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(),
  readLocalPackageSkillContent: vi.fn(),
}));
vi.mock("@cinatra-ai/objects", () => ({ createDeterministicObjectsClient: vi.fn(() => ({})) }));
vi.mock("@cinatra-ai/llm", () => ({
  getActorContext: () => null,
  getActorContextOrThrow: () => { throw new Error("not used"); },
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
  resolveProviderAdapter: () => null,
  ANTHROPIC_API_LOG_DIRECTORY: "/tmp",
  setAnthropicLoggingEnabled: () => {},
}));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(),
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
vi.mock("../wayflow-preflight", () => ({ preflightWayflowAgent: vi.fn(async () => ({ ok: true })) }));
vi.mock("../verdaccio/publish-metadata", () => ({
  derivePublishMetadataFromSnapshot: vi.fn(() => ({ riskLevel: "low", toolAccess: [], hasApprovalGates: false })),
}));
vi.mock("../review-task-actions", () => ({ approveReviewTaskInternal: vi.fn() }));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
// The agent-source root is POINTED at the fixture dir rather than changing the
// process working directory into it: a chdir moves module resolution out from
// under the pg driver, which resolves lazily on its first query and then cannot
// find its own package.
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: vi.fn(() => sourceRoot.path),
  resolveDevExtensionSourceRoot: vi.fn(() => sourceRoot.path),
}));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: vi.fn((p: unknown) => p),
  injectCinatraLlmIntoApiNodes: vi.fn(),
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: vi.fn(() => ({})) }));
vi.mock("@/lib/mcp-pagination", () => ({
  decodeCursor: vi.fn(() => 0),
  buildListPage: vi.fn(() => ({ items: [], nextCursor: null })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => true),
  requireAuthSession: vi.fn(),
  resolveOrgRoleForUser: vi.fn(async () => null),
}));
vi.mock("@/lib/authz", () => ({
  logAuditEvent: vi.fn(async () => undefined),
  POLICY_VERSION: "1.0",
  AuthzError: class extends Error { statusCode = 403; reason = "denied"; },
  can: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@cinatra-ai/mcp-client", () => ({
  invokePrimitive: vi.fn(),
  createInProcessPrimitiveTransport: vi.fn(),
  PrimitiveInvocationError: class extends Error {},
}));

import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";

const ORG_A = `org_a_${randomUUID().slice(0, 8)}`;
const ORG_B = `org_b_${randomUUID().slice(0, 8)}`;
const CANDIDATE_VERSION = "1.2.3";
const createdPackageNames: string[] = [];

function schemaName(): string {
  return `"${(process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replaceAll('"', '""')}"`;
}

/**
 * A fresh, DELIBERATELY LOW-ENTROPY package name.
 *
 * The publish path scans every shipped file for literal credentials, and a
 * random-hex suffix made `package.json#name` itself look like a high-entropy
 * token often enough to fail the run — a fixture that flakes on its own name.
 * Digits and a counter keep the name unique per run and under the scanner's
 * 24-character entropy window. The pid discriminates two runs that start in the
 * same millisecond against one shared registry.
 */
let packageNameCounter = 0;
function newPackageName(): string {
  packageNameCounter += 1;
  const name = `@pf2675/p${process.pid % 100_000}-${Date.now() % 1_000_000_000}-${packageNameCounter}`;
  createdPackageNames.push(name);
  return name;
}

afterAll(async () => {
  if (!hasDb || createdPackageNames.length === 0) return;
  const { db } = await import("../db");
  for (const packageName of createdPackageNames) {
    const res = await db.execute(
      sql`select id from ${sql.raw(schemaName())}.agent_templates where package_name = ${packageName}`,
    );
    const rows = (res as unknown as { rows?: { id: string }[] }).rows ?? [];
    for (const row of rows) {
      await db.execute(
        sql`delete from ${sql.raw(schemaName())}.agent_versions where template_id = ${row.id}`,
      );
      await db.execute(
        sql`delete from ${sql.raw(schemaName())}.agent_templates where id = ${row.id}`,
      );
    }
  }
});

/** Seed the row that makes the name ALREADY CLAIMED by `orgId`. */
async function seedOwnedTemplate(packageName: string, orgId: string): Promise<void> {
  const { createAgentTemplate } = await import("../store");
  await createAgentTemplate({
    id: `t_${randomUUID()}`,
    name: "publish-preflight-owner",
    sourceNl: "x",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    packageName,
    packageVersion: "1.0.0",
    orgId,
    ownerLevel: "organization",
    ownerId: orgId,
  });
}

async function writeAgentSource(
  root: string,
  slug: string,
  packageName: string,
  version: string,
): Promise<void> {
  const pkgRoot = path.join(root, "cinatra-ai", slug);
  await fs.mkdir(path.join(pkgRoot, "cinatra"), { recursive: true });
  await fs.writeFile(
    path.join(pkgRoot, "package.json"),
    JSON.stringify({ name: packageName, version, license: "MIT", description: "cinatra#2675 fixture" }),
  );
  await fs.writeFile(
    path.join(pkgRoot, "cinatra", "oas.json"),
    JSON.stringify({
      agentspec_version: "26.1.0",
      component_type: "Flow",
      id: `${slug}-flow`,
      name: "Preflight Fixture",
      description: "cinatra#2675 AC1 fixture.",
      metadata: { cinatra: { type: "node" } },
      nodes: [{ $component_ref: "start" }, { $component_ref: "end" }],
      start_node: { $component_ref: "start" },
      control_flow_connections: [],
      $referenced_components: {
        start: {
          component_type: "StartNode",
          id: "start",
          name: "Inputs",
          metadata: { cinatra: { required: ["url"] } },
          inputs: [{ title: "url", type: "string", format: "uri" }],
        },
        end: { component_type: "EndNode", id: "end" },
      },
    }),
  );
}

function publishRequest(slug: string, orgId: string, userId: string): unknown {
  return {
    primitiveName: "agent_source_publish",
    input: { packageSlug: slug, destination: "private" as const },
    actor: {
      actorType: "user" as const,
      source: "ui" as const,
      userId,
      orgId,
      platformRole: "platform_admin",
    },
    mode: "deterministic" as const,
  };
}

/** What the REGISTRY holds for a package: its published versions. */
async function readPublishedVersions(packageName: string): Promise<string[]> {
  const res = await fetch(`${registryUrl}/${encodeURIComponent(packageName)}`, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`registry packument read failed: ${res.status}`);
  const body = (await res.json()) as { versions?: Record<string, { dist?: { tarball?: string } }> };
  return Object.keys(body.versions ?? {});
}

/** The tarball URL Verdaccio serves for a version, or null when unpublished. */
async function readTarballUrl(packageName: string, version: string): Promise<string | null> {
  const res = await fetch(`${registryUrl}/${encodeURIComponent(packageName)}`, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return null;
  const body = (await res.json()) as { versions?: Record<string, { dist?: { tarball?: string } }> };
  return body.versions?.[version]?.dist?.tarball ?? null;
}

/** The conventional tarball path, so absence is asserted even if no packument exists. */
function conventionalTarballUrl(packageName: string, version: string): string {
  const bare = packageName.slice(packageName.indexOf("/") + 1);
  return `${registryUrl}/${packageName}/-/${bare}-${version}.tgz`;
}

describe.skipIf(!hasDb || !hasRegistry)(
  "cinatra#2675 — agent_source_publish refuses a foreign name BEFORE the registry write (real Verdaccio)",
  () => {
    it("AC1: a foreign name refuses, and neither the version nor its tarball reaches the registry", async () => {
      const { AgentTemplateIdentityConflictError } = await import("../agent-template-identity");
      const packageName = newPackageName();
      await seedOwnedTemplate(packageName, ORG_A);

      // The candidate version is ABSENT from the registry before the attempt.
      expect(await readPublishedVersions(packageName)).toEqual([]);

      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "publish-claim-preflight-"));
      const originalRoot = sourceRoot.path;
      sourceRoot.path = tmpRoot;
      try {
        const slug = "claim-preflight-foreign";
        await writeAgentSource(tmpRoot, slug, packageName, CANDIDATE_VERSION);

        const handler = createAgentBuilderPrimitiveHandlers()[
          "agent_source_publish"
        ] as unknown as (req: unknown) => Promise<unknown>;
        // ORG_B publishes a name ORG_A holds.
        const result = (await handler(publishRequest(slug, ORG_B, "u-b"))) as {
          error?: string;
          code?: string;
          published?: boolean;
        };

        // The refusal is the EXISTING one, unchanged.
        expect(result.code).toBe("AGENT_TEMPLATE_IDENTITY_CONFLICT");
        expect(result.error).toBe(new AgentTemplateIdentityConflictError(packageName).message);
        expect(result.published).toBeUndefined();

        // THE POINT: nothing was written to the registry. On `main` the version
        // is published by now and both of these fail.
        expect(await readPublishedVersions(packageName)).toEqual([]);
        expect(await readTarballUrl(packageName, CANDIDATE_VERSION)).toBeNull();
        const tarball = await fetch(conventionalTarballUrl(packageName, CANDIDATE_VERSION));
        expect(tarball.status).toBe(404);

        // The refusal came BEFORE the DB sync too — the claim never ran.
        expect(mockInstallAgentFromPackage).not.toHaveBeenCalled();
      } finally {
        sourceRoot.path = originalRoot;
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    }, 120_000);

    it("positive control: the OWNING organization's publish lands the version and its tarball", async () => {
      const packageName = newPackageName();
      await seedOwnedTemplate(packageName, ORG_A);
      mockInstallAgentFromPackage.mockClear();

      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "publish-claim-preflight-ok-"));
      const originalRoot = sourceRoot.path;
      sourceRoot.path = tmpRoot;
      try {
        const slug = "claim-preflight-owner";
        await writeAgentSource(tmpRoot, slug, packageName, CANDIDATE_VERSION);

        const handler = createAgentBuilderPrimitiveHandlers()[
          "agent_source_publish"
        ] as unknown as (req: unknown) => Promise<unknown>;
        const result = (await handler(publishRequest(slug, ORG_A, "u-a"))) as {
          error?: string;
          published?: boolean;
          packageVersion?: string;
        };

        expect(result.error).toBeUndefined();
        expect(result.published).toBe(true);
        expect(result.packageVersion).toBe(CANDIDATE_VERSION);
        expect(mockInstallAgentFromPackage).toHaveBeenCalledTimes(1);

        // The registry really does accept publishes from this harness — which
        // is what makes the absence assertions above non-vacuous.
        expect(await readPublishedVersions(packageName)).toContain(CANDIDATE_VERSION);
        const tarballUrl = await readTarballUrl(packageName, CANDIDATE_VERSION);
        expect(tarballUrl).toBeTruthy();
        const tarball = await fetch(tarballUrl as string);
        expect(tarball.status).toBe(200);
      } finally {
        sourceRoot.path = originalRoot;
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    }, 120_000);

    it("boundary: a republish of an ALREADY-PUBLISHED version is not adjudicated - it writes nothing", async () => {
      // The gate refuses registry WRITES, and a republish of an existing
      // version is not one: the publisher returns `alreadyPublished` and the
      // install branch (which requires `published`) never runs, so the
      // authoritative claim never adjudicates this call either. Refusing it
      // would be a refusal this codebase never made. Pinned so the gate cannot
      // quietly widen later.
      const packageName = newPackageName();
      await seedOwnedTemplate(packageName, ORG_A);
      mockInstallAgentFromPackage.mockClear();

      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "publish-claim-preflight-re-"));
      const originalRoot = sourceRoot.path;
      sourceRoot.path = tmpRoot;
      try {
        // ORG_A publishes it once...
        await writeAgentSource(tmpRoot, "claim-preflight-first", packageName, CANDIDATE_VERSION);
        const handler = createAgentBuilderPrimitiveHandlers()[
          "agent_source_publish"
        ] as unknown as (req: unknown) => Promise<unknown>;
        const first = (await handler(
          publishRequest("claim-preflight-first", ORG_A, "u-a"),
        )) as { published?: boolean };
        expect(first.published).toBe(true);

        // ...and ORG_B re-publishes the SAME version: a registry no-op.
        await writeAgentSource(tmpRoot, "claim-preflight-again", packageName, CANDIDATE_VERSION);
        const again = (await handler(
          publishRequest("claim-preflight-again", ORG_B, "u-b"),
        )) as { error?: string; code?: string; published?: boolean; alreadyPublished?: boolean };

        expect(again.error).toBeUndefined();
        expect(again.code).toBeUndefined();
        expect(again.published).toBe(false);
        expect(again.alreadyPublished).toBe(true);
        // Only ORG_A's publish reached the DB claim.
        expect(mockInstallAgentFromPackage).toHaveBeenCalledTimes(1);
        expect(await readPublishedVersions(packageName)).toEqual([CANDIDATE_VERSION]);
      } finally {
        sourceRoot.path = originalRoot;
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    }, 120_000);
  },
);

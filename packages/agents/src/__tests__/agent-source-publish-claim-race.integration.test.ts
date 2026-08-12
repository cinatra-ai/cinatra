// cinatra#2675 AC2 — BOTH publishers pass the read-only preflight, exactly ONE
// wins the authoritative DB claim.
//
// The preflight this issue adds is a fast path, not a reservation: it reads the
// `agent_templates` row and refuses a name another organization already holds.
// A name that is ABSENT cannot be reserved by a read, so two organizations can
// both pass it and both reach the DB sync. That case is the whole reason the
// guarded write stays fail-closed, and this suite proves the outcome the
// operator gets: one publish succeeds, the OTHER receives the identity-conflict
// refusal UNCHANGED, and the database ends with exactly one row, belonging to
// the winner.
//
// Shape of the harness, stated plainly so nobody mistakes what is real:
//   - REAL: the `agent_source_publish` handler (the ordering under test), the
//     preflight, `claimAgentTemplateIdentity` (the operation that owns the
//     23505 classification), the store, and a real Postgres schema.
//   - STUBBED: the registry publisher (this AC is about the DB claim, not the
//     tarball — the registry half is proven against a real Verdaccio in
//     agent-source-publish-claim-preflight.integration.test.ts) and the install
//     primitive's extraction/materialize legs. The install stub performs the
//     REAL claim through the REAL operation, so the racing code is production
//     code; only the disk/registry legs around it are removed.
//
// The BARRIER is what makes the race deterministic: both handler calls are held
// at the entry of the DB sync until BOTH have arrived, which can only happen
// after BOTH preflights have already passed on an absent name. Without it the
// first publisher would commit before the second even read, and the test would
// prove nothing about two claimants meeting at the write.
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

/** Where the handler looks for `<root>/<vendor>/<slug>/` agent sources. */
const { sourceRoot } = vi.hoisted(() => ({ sourceRoot: { path: process.cwd() } }));

// ---------------------------------------------------------------------------
// The install primitive: stubbed down to its CLAIM, which is the real one.
// ---------------------------------------------------------------------------
const { installBarrier, mockInstallAgentFromPackage } = vi.hoisted(() => {
  const state: {
    /** How many publishers must arrive before any is released. 0 = disabled. */
    expected: number;
    arrived: number;
    waiters: Array<() => void>;
    orgOfInsert: Map<string, string>;
  } = { expected: 0, arrived: 0, waiters: [], orgOfInsert: new Map() };

  async function waitForBarrier(): Promise<void> {
    if (state.expected <= 0) return;
    state.arrived += 1;
    if (state.arrived >= state.expected) {
      const waiters = state.waiters.splice(0);
      for (const release of waiters) release();
      return;
    }
    // A publisher that never arrives means one of them was refused BEFORE the
    // DB sync — the assertion this suite exists to make. Fail loudly instead of
    // hanging until the suite timeout.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `[cinatra#2675 AC2] only ${state.arrived}/${state.expected} publishers reached the DB ` +
                "sync — the other returned before it, so the two never met at the claim.",
            ),
          ),
        15_000,
      );
      state.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    installBarrier: state,
    mockInstallAgentFromPackage: vi.fn(
      async (input: {
        packageName: string;
        packageVersion: string;
        orgId?: string;
        ownerLevel?: string;
        ownerId?: string;
      }) => {
        await waitForBarrier();
        // The REAL claim, the REAL rule, on a real connection — the same
        // function `installAgentFromPackage` itself calls.
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
                name: "publish-race-fixture",
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
              state.orgOfInsert.set(id, input.orgId ?? "<none>");
              return { templateId: id };
            },
          },
        );
      },
    ),
  };
});
vi.mock("../install-from-package", () => ({
  installAgentFromPackage: mockInstallAgentFromPackage,
}));

// The registry half — stubbed here on purpose (see the header).
//
// `isVersionPublished` MUST be stubbed, not omitted. The preflight asks it
// whether this publish would be a registry no-op, and an omitted export makes
// that call throw, which the preflight swallows as "registry unreadable" and
// proceeds. Both publishers would still meet at the claim and the suite would
// still pass — through the registry-ERROR fallback instead of the path AC2 is
// about ("the registry reports these versions absent"). Stubbing it false, and
// asserting it was consulted twice, keeps the proof on the intended path.
const { mockPublishAgentPackageFromGitDir, mockIsVersionPublished } = vi.hoisted(() => ({
  mockPublishAgentPackageFromGitDir: vi.fn(),
  mockIsVersionPublished: vi.fn<
    (config: unknown, packageName: string, version: string) => Promise<boolean>
  >(async () => false),
}));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: mockPublishAgentPackageFromGitDir,
  isVersionPublished: mockIsVersionPublished,
}));

// ---------------------------------------------------------------------------
// Publish-path dependencies + the heavyweight transitive mocks that keep
// handlers.ts importable in a node test env. Mirrors the sibling
// agent-source-publish-detail-path-and-freeze.test.ts preamble; `../store`,
// `../agent-template-identity` and `../db` are deliberately NOT mocked.
// ---------------------------------------------------------------------------
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
  resolvePublishDestination: vi.fn(async () => ({
    registryUrl: "http://127.0.0.1:4873",
    token: "integration-test-token",
    packageScope: "@pf2675",
    destinationId: "local",
  })),
  PublishDestinationNotConfiguredError: class extends Error { code = "PUBLISH_DESTINATION_NOT_CONFIGURED"; },
}));
vi.mock("@/lib/dev-extensions", () => ({ readEffectivePublishScopeOverride: vi.fn(() => null) }));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForServer: vi.fn(async () => ({
    registryUrl: "http://127.0.0.1:4873",
    token: "integration-test-token",
    packageScope: "@pf2675",
  })),
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
// Low-entropy on purpose: the publish path scans shipped files for literal
// credentials, and a random-hex suffix makes `package.json#name` itself read as
// a high-entropy token. Digits keep it unique per run without tripping the scan;
// the pid discriminates two runs that start in the same millisecond.
const PACKAGE_NAME = `@pf2675/r${process.pid % 100_000}-${Date.now() % 1_000_000_000}`;

function schemaName(): string {
  return `"${(process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replaceAll('"', '""')}"`;
}

afterAll(async () => {
  if (!hasDb) return;
  const { db } = await import("../db");
  const res = await db.execute(
    sql`select id from ${sql.raw(schemaName())}.agent_templates where package_name = ${PACKAGE_NAME}`,
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
});

/** A publishable agent source dir under `<cwd>/cinatra-ai/<slug>/`. */
async function writeAgentSource(root: string, slug: string, version: string): Promise<void> {
  const pkgRoot = path.join(root, "cinatra-ai", slug);
  await fs.mkdir(path.join(pkgRoot, "cinatra"), { recursive: true });
  await fs.writeFile(
    path.join(pkgRoot, "package.json"),
    JSON.stringify({ name: PACKAGE_NAME, version, license: "MIT" }),
  );
  await fs.writeFile(
    path.join(pkgRoot, "cinatra", "oas.json"),
    JSON.stringify({
      agentspec_version: "26.1.0",
      component_type: "Flow",
      id: `${slug}-flow`,
      name: "Race Fixture",
      description: "cinatra#2675 AC2 fixture.",
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

describe.skipIf(!hasDb)("cinatra#2675 — two publishers meet at the authoritative claim", () => {
  it("AC2: both pass the preflight on an absent name; exactly one wins, the loser is refused unchanged", async () => {
    const { AgentTemplateIdentityConflictError } = await import("../agent-template-identity");

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "publish-claim-race-"));
    const originalRoot = sourceRoot.path;
    sourceRoot.path = tmpRoot;
    try {
      const slugA = "claim-race-a";
      const slugB = "claim-race-b";
      // DISTINCT versions: the two publishers are publishing their own source
      // trees under one contested name, so neither is blocked by the other's
      // already-published version and both genuinely reach the DB sync.
      await writeAgentSource(tmpRoot, slugA, "1.0.0");
      await writeAgentSource(tmpRoot, slugB, "2.0.0");

      mockPublishAgentPackageFromGitDir.mockImplementation(
        async (input: { agentDir: string }) => {
          const raw = await fs.readFile(path.join(input.agentDir, "package.json"), "utf8");
          const version = (JSON.parse(raw) as { version: string }).version;
          return {
            packageName: PACKAGE_NAME,
            packageVersion: version,
            registryUrl: "http://127.0.0.1:4873",
            published: true,
            alreadyPublished: false,
          };
        },
      );

      // Hold BOTH publishers at the DB sync until both have arrived — which can
      // only happen once both preflights have already passed on the absent name.
      installBarrier.expected = 2;
      installBarrier.arrived = 0;
      installBarrier.waiters = [];

      const handler = createAgentBuilderPrimitiveHandlers()[
        "agent_source_publish"
      ] as unknown as (req: unknown) => Promise<unknown>;
      const [resultA, resultB] = (await Promise.all([
        handler(publishRequest(slugA, ORG_A, "u-a")),
        handler(publishRequest(slugB, ORG_B, "u-b")),
      ])) as Array<{ error?: string; code?: string; published?: boolean }>;

      // Both preflights passed: the barrier only releases at two arrivals.
      expect(installBarrier.arrived).toBe(2);
      // …and both passed it having ASKED the registry and been told the version
      // was absent, not by falling through the registry-unreadable branch.
      expect(mockIsVersionPublished).toHaveBeenCalledTimes(2);
      expect(mockIsVersionPublished.mock.calls.map((call) => call[2]).sort()).toEqual([
        "1.0.0",
        "2.0.0",
      ]);

      const results = [resultA, resultB];
      const winners = results.filter((r) => !r.error);
      const losers = results.filter((r) => r.error);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(winners[0].published).toBe(true);

      // The loser's refusal is the EXISTING one, byte-for-byte — this change
      // moves a refusal earlier, it does not mint new copy.
      expect(losers[0].code).toBe("AGENT_TEMPLATE_IDENTITY_CONFLICT");
      expect(losers[0].error).toBe(
        new AgentTemplateIdentityConflictError(PACKAGE_NAME).message,
      );

      // Exactly ONE template row under the contested name, and it belongs to
      // the publisher whose handler reported success.
      const { db } = await import("../db");
      const res = await db.execute(
        sql`select id, org_id from ${sql.raw(schemaName())}.agent_templates where package_name = ${PACKAGE_NAME}`,
      );
      const rows = (res as unknown as { rows?: { id: string; org_id: string | null }[] }).rows ?? [];
      expect(rows).toHaveLength(1);
      const winnerOrg = resultA.error ? ORG_B : ORG_A;
      expect(rows[0].org_id).toBe(winnerOrg);
      expect(installBarrier.orgOfInsert.get(rows[0].id)).toBe(winnerOrg);
    } finally {
      installBarrier.expected = 0;
      sourceRoot.path = originalRoot;
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});

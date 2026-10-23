/**
 * cinatra#3745 MF2 — AN EXISTING APPROVED REVIEW-DECISION ROAD STILL COMPLETES,
 * ON A REAL DATABASE.
 *
 * A person approves a WayFlow gate (`approveReviewTaskInternal`, the `wayflow-`
 * path: the real claim from `pending_approval` to `running`). The resumed leg
 * calls back through the real deterministic passthrough with the runtime's
 * signed, source-bound step pair, and the real run guard admits it:
 *
 *   (a) a non-outward extension tool from a load with no loaded identity, which
 *       files review targets, is served once and its targets ride out;
 *   (b) a digest-pinned tool that declares outward, with its own fixture
 *       `artifact-action-check/v1` provider and the person's approved
 *       artifact-review gate over a pinned revision, is served exactly once; a
 *       second call is refused with `action_gate_already_consumed`.
 *
 * Real: the run store and its status transitions, the step-tool policy binding,
 * the passthrough route, the run binding and source verification, the guard
 * (`withGuardedRunActionInvocation` -> `withArtifactReviewAction`), the gate and
 * consumption tables, the pinned revision rows and the local-disk blob read.
 * Doubles: the WayFlow client (its `sendTask` makes the callback), the leg's
 * post-send state handler (so "completed" is read as the handler being reached
 * from `running`), the run-token mint, the bridge-token check, the actor
 * builder, the audit writer, the classification reader for the invented tool
 * name, and the extension-scoped dispatcher's package lookup (it hands the call
 * to the real `dispatchExtensionTool` or to the real guarded leaf).
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
 *     pnpm exec vitest run src/lib/__tests__/review-decision-roads-3745.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";

import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_review_roads_3745";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3745-roads";
const USER = "user-3745-roads";
const AUTHORITY = { orgId: ORG, can: () => true };
const STEP = "call_llm_bridge";
const ATTEST_KEY = "step-attest-key-3745-roads";
const RAW_SOURCE = readFileSync(
  join(process.cwd(), "packages/agents/src/__tests__/fixtures/synthetic-gemini-agent.json"), "utf-8");
const OUTWARD_TOOL = "example_reviewed_publish";
const PACK = "@example-org/reviewed-publish-pack";
const FIXTURE_ROOT = join(process.cwd(), "src/lib/__tests__/fixtures/extension-tool-pack");
const PINNED = JSON.stringify({ recipient: "approved" });
const PUBLIC_FLOOR: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS public."user" (id text PRIMARY KEY, username text, name text NOT NULL, email text NOT NULL, "emailVerified" boolean NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS public."organization" (id text PRIMARY KEY, slug text NOT NULL, name text NOT NULL, "createdAt" timestamptz NOT NULL, "archivedAt" timestamptz, "archiveEpoch" int)`,
  `CREATE TABLE IF NOT EXISTS public."member" (id text PRIMARY KEY, "organizationId" text, "userId" text, "createdAt" timestamptz, role text)`,
];

// The host's own schema name is read once, when its config module first loads,
// so it is set before any import here.
vi.hoisted(() => {
  if (process.env.SUPABASE_DB_URL) process.env.SUPABASE_SCHEMA = "cinatra_test_review_roads_3745";
});
const h = vi.hoisted(() => ({
  runId: "",
  contextId: "",
  taskId: "",
  handled: [] as Array<{ fromStatus: string }>,
  onSend: null as null | (() => Promise<unknown>),
  callbacks: [] as unknown[],
  moduleEffects: [] as unknown[],
  leafEffects: [] as unknown[],
  leaf: null as null | ((input: unknown) => Promise<unknown>),
}));

vi.mock("server-only", () => ({}));
// The root test alias stubs "@/lib/database" with a fixed schema name; the guard
// reads the pinned revision rows through it, so it takes the real config here.
// Every other name keeps the stub's answer (undefined where the stub has none).
vi.mock("@/lib/database", async (importOriginal) => {
  const stub = await importOriginal<Record<string, unknown>>();
  const cfg = await import("@/lib/postgres-config");
  return new Proxy({ ...stub, getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema }, { has: () => true });
});
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({
    sendTask: vi.fn(async () => {
      if (h.onSend) h.callbacks.push(await h.onSend());
      return { id: `task-next-${randomUUID()}`, contextId: h.contextId, status: { state: "completed" } };
    }),
  })),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async () => h.taskId),
  expireRunStream: vi.fn(async () => undefined),
}));
vi.mock("../../../packages/agents/src/execution", () => ({
  handleWayflowTaskState: vi.fn(async (input: { fromStatus: string }) => {
    h.handled.push({ fromStatus: input.fromStatus });
  }),
}));
vi.mock("../../../packages/agents/src/wayflow-run-token-carrier", () => ({
  mintResumeRunTokenMetadata: vi.fn(async () => ({ cinatra_run_token: "token" })),
}));
vi.mock("../../../packages/agents/src/wayflow-url", async (orig) => ({
  ...(await orig<typeof import("../../../packages/agents/src/wayflow-url")>()),
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  createWayflowFetch: vi.fn(() => globalThis.fetch),
}));
vi.mock("../../../packages/agents/src/agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../../../packages/agents/src/agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../../../packages/agents/src/store", async (orig) => {
  const actual = await orig<typeof import("../../../packages/agents/src/store")>();
  return {
    ...actual,
    readAgentRunById: (id: string) => actual.readAgentRunById(id),
    readAgentTemplateById: vi.fn(async () => ({
      id: "tpl-3745-roads", name: "Review roads template", packageName: "@cinatra-ai/review-roads-agent",
      sourceType: "internal", status: "published", type: "leaf", agentAuthPolicy: null,
    })),
    readRunCoOwners: vi.fn(async () => []),
    writeHitlPrompt: vi.fn(async () => undefined),
  };
});
vi.mock("@/lib/org-write/agent-run-authority-mint", () => ({
  mintAgentRunExecutionAuthority: () => ({ orgId: ORG, can: () => true }),
}));
vi.mock("@/lib/org-write/run-authority-mint", () => ({
  mintRunWriteAuthorityForMcp: vi.fn(async () => ({ orgId: ORG, can: () => true })),
}));
vi.mock("@/lib/org-write/authority", async (orig) => ({
  ...(await orig<typeof import("@/lib/org-write/authority")>()),
  sessionAuthorityFromResolvedRole: () => ({ orgId: ORG, can: () => true }),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({
    user: { id: USER, role: "user" },
    session: { id: "s", userId: USER, activeOrganizationId: ORG },
  })),
  requireAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(() => false),
  resolveOrgRoleForUser: vi.fn(async () => "owner"),
}));
vi.mock("../../../packages/agents/src/auth-policy", () => ({ enforceRunAccess: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({ publishAgUiEvent: vi.fn(async () => undefined) }));
vi.mock("@cinatra-ai/mcp-server", async () => {
  const actual = await vi.importActual<typeof import("@cinatra-ai/mcp-server/request-context")>(
    "@cinatra-ai/mcp-server/request-context");
  return { mcpRequestContextStorage: actual.mcpRequestContextStorage };
});
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => true }));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser", principalId: USER, organizationId: ORG, platformRole: "member",
  })),
}));
vi.mock("@/lib/run-folder-tools", () => ({ RUN_FOLDER_TOOLS: new Set<string>() }));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: async () => ({}) }));
// The extension-scoped road's package lookup. The call itself reaches the real
// dispatcher (a), or the real guarded leaf the host bound for the pack (b).
vi.mock("@/lib/extension-scoped-tools", () => ({
  EXTENSION_SCOPED_TOOLS: new Set<string>(["extension_tool", "example_reviewed_publish"]),
  dispatchExtensionScopedTool: async (call: { tool: string; input: Record<string, unknown>; run: { orgId: string } }) => {
    if (call.tool === "example_reviewed_publish") return { ok: true, result: await h.leaf!(call.input) };
    const { dispatchExtensionTool } = await import("@/lib/extension-tool-dispatch");
    const namespace = {
      extensionTool: async ({ input, ports }: { input: unknown; ports: { review: { file: (t: unknown) => void } } }) => {
        h.moduleEffects.push(input);
        ports.review.file([{ artifactId: "post-roads", representationRevisionId: "rev-roads" }]);
        return { drafted: true };
      },
    };
    const ports = { data: { select: vi.fn(), insertIfAbsent: vi.fn(), updateWhere: vi.fn() },
      artifacts: { list: vi.fn(), contentRead: vi.fn() }, objects: { read: vi.fn(), save: vi.fn() },
      clock: { now: () => new Date(0) } };
    return { ok: true, result: await dispatchExtensionTool({
      packageName: "@fixture-scope/fixture-tool-pack", packageVersion: "1.2.3", orgId: call.run.orgId,
      cinatra: { tools: [{ name: "fixture_tool", module: "./cinatra/tools/fixture-tool.mjs" }] },
      request: call.input,
      ports: ports as never,
      deps: { resolvePackageRoot: async () => FIXTURE_ROOT, importModule: async () => namespace },
    } as never) };
  },
}));

let serde: typeof import("../../../packages/agents/src/agent-run-serde");
let transitions: typeof import("../../../packages/agents/src/run-transition");
let dbMod: typeof import("../../../packages/agents/src/db");
let dataRoot = "";

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}
async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}

function policy() {
  return serde.createRunStepToolPolicy({ contextId: h.contextId, rawSource: RAW_SOURCE });
}
/** The source-bound pair the runtime signs over the executing flow source. */
function sourceHeaders() {
  const p = policy();
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", ATTEST_KEY)
    .update(`s2\n${h.contextId}\n${STEP}\n${p.sourceSha256}\n${p.executedSourceSha256}\n${p.declarationSourceSha256}\n${expiry}`)
    .digest("hex");
  return {
    "x-cinatra-step-node": STEP,
    "x-cinatra-step-attestation": `s2:${expiry}:${sig}`,
    "x-cinatra-raw-source": p.sourceSha256,
    "x-cinatra-executed-source": p.executedSourceSha256,
    "x-cinatra-declaration-source": p.declarationSourceSha256,
  };
}
/** The resumed leg's callback through the real passthrough. */
async function passthrough(tool: string, input: Record<string, unknown>) {
  const { POST } = await import("@/app/api/agents/passthrough/route");
  const res = await POST(new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": h.contextId, ...sourceHeaders() },
    body: JSON.stringify({ tool, input, agent_run_id: h.runId }),
  }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A run that dispatched for real, bound to its attempt, now at the person's gate. */
async function seedRunAtGate() {
  h.runId = `run-${randomUUID()}`;
  h.contextId = `ctx-${randomUUID()}`;
  h.taskId = `task-${randomUUID()}`;
  const attempt = randomUUID();
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
       (id, template_id, org_id, status, input_params, run_by, execution_attempt_id, a2a_context_id, a2a_task_id)
     VALUES ($1, 'tpl-3745-roads', $2, 'running', '{}', $3, $4, $5, $6)`,
    [h.runId, ORG, USER, attempt, h.contextId, h.taskId],
  );
  await serde.bindRunStepToolPolicy({ orgId: ORG, runId: h.runId, executionAttemptId: attempt,
    policy: policy(), authority: AUTHORITY as never });
  await transitions.transitionRunStatus(h.runId, "running", "pending_approval", undefined, AUTHORITY as never);
  return attempt;
}

/** The person's approved artifact-review gate over one pinned revision with real bytes. */
async function seedApprovedGate() {
  const s = q(TEST_SCHEMA);
  const artifactId = `artifact-${randomUUID()}`;
  const revisionId = `rev-${randomUUID()}`;
  const resourceId = `res-${randomUUID()}`;
  const bytes = Buffer.from(PINNED, "utf8");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const storageKey = `orgs/${ORG}/blobs/sha256/${sha.slice(0, 2)}/${sha}.bin`;
  mkdirSync(join(dataRoot, storageKey, ".."), { recursive: true });
  writeFileSync(join(dataRoot, storageKey), bytes);
  await pool(
    `INSERT INTO "${s}"."objects" (id, type, data, org_id, created_by, created_at, updated_at, owner_level, visibility, source)
     VALUES ($1,'document',$2::jsonb,$3,$4,now(),now(),'organization','organization','test')`,
    [artifactId, JSON.stringify({ title: "reviewed", latestRepresentationRevisionId: revisionId }), ORG, USER],
  );
  await pool(
    `INSERT INTO "${s}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, metadata, created_by)
     VALUES ($1,$2,'blob',$3,'application/json',$4,$5::jsonb,$6)`,
    [resourceId, ORG, `blob:${sha}`, bytes.length, JSON.stringify({ storageKey }), USER],
  );
  await pool(
    `INSERT INTO "${s}"."representation" (id, org_id, artifact_id, resource_id, revision, form, created_by)
     VALUES ($1,$2,$3,$4,1,'file',$5)`,
    [revisionId, ORG, artifactId, resourceId, USER],
  );
  await pool(
    `INSERT INTO "${s}"."artifact_review_gates"
       (id, run_id, org_id, review_task_id, status, pinned_targets, disposition, fingerprint, resolved_by, resolved_at)
     VALUES ($1,$2,$3,$4,'resolved',$5::jsonb,'approve',$6,$7,now())`,
    [`gate-${randomUUID()}`, h.runId, ORG, `wayflow-${h.taskId}`,
      JSON.stringify([{ artifactId, representationRevisionId: revisionId }]), `person:${randomUUID()}`, USER],
  );
}

async function approve() {
  const { approveReviewTaskInternal } = await import("../../../packages/agents/src/review-task-actions");
  await approveReviewTaskInternal(`wayflow-${h.taskId}`, USER, { approved: true });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
  dataRoot = mkdtempSync(join(tmpdir(), "review-roads-3745-"));
  process.env.CINATRA_ARTIFACT_DATA_ROOT = dataRoot;
  await admin(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
    await c.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
    for (const stmt of PUBLIC_FLOOR) await c.query(stmt);
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      const head = qy.text.trim().slice(0, 6).toUpperCase();
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S" && head !== "DO $$ ") continue;
      if (qy.text.includes("user_slug_move_trg")) continue;
      try {
        await c.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
      }
    }
    await c.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`,
      [ORG]);
    await c.query(
      `INSERT INTO public."user" (id, username, name, email, "emailVerified") VALUES ($1,$1,$1,$2,false) ON CONFLICT (id) DO NOTHING`,
      [USER, `${USER}@example.test`]);
  });
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
  serde = await import("../../../packages/agents/src/agent-run-serde");
  transitions = await import("../../../packages/agents/src/run-transition");
  dbMod = await import("../../../packages/agents/src/db");
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await admin((c) => c.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`));
  await dbMod?.agentBuilderPool?.end?.().catch(() => {});
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

beforeEach(() => {
  h.handled = [];
  h.callbacks = [];
  h.moduleEffects = [];
  h.leafEffects = [];
  h.onSend = null;
  h.leaf = null;
});

describe.skipIf(!HAS_DB)("an approved review-decision road still completes (cinatra#3745 MF2)", () => {
  it("(a) a non-outward extension tool with no loaded identity files its review targets on the resumed leg", async () => {
    await seedRunAtGate();
    h.onSend = () => passthrough("extension_tool", { name: "fixture_tool", input: { draft: "x" } });
    await approve();
    expect(h.callbacks).toHaveLength(1);
    const cb = h.callbacks[0] as { status: number; body: Record<string, unknown> };
    expect(cb.status).toBe(200);
    expect(JSON.stringify(cb.body)).toContain("rev-roads");
    expect(h.moduleEffects).toEqual([{ draft: "x" }]);
    expect(h.handled).toEqual([{ fromStatus: "running" }]);
  });

  it("(b) a digest-pinned outward tool with its own provider is served once on the person's approved gate, then refused", async () => {
    const audit = await import("@/lib/authz/audit");
    const augment = await import("@/lib/authz/inventory-augment");
    const registry = await import("@/lib/extension-capabilities-registry");
    const { bindArtifactGuardedMcpHandler } = await import("@/lib/extension-host-context");
    const realLookup = augment.lookupPrimitiveClassification;
    const spies: { mockRestore(): void }[] = [
      vi.spyOn(audit, "logAuditEvent").mockResolvedValue(undefined),
      vi.spyOn(augment, "lookupPrimitiveClassification").mockImplementation((name: string) =>
        name === OUTWARD_TOOL ? { resourceType: "agent_run", action: "execute", status: "enforced" } : realLookup(name)),
    ];
    try {
      const identity = registry.recordLoadedExtensionIdentity({
        packageName: PACK, version: "1.0.0", installId: `roads-install-${randomUUID()}`, digest: "9".repeat(64),
      });
      const provider = registry.bindLoadedCapabilityProvider({ packageName: PACK, impl: {
        classify: () => ({ kind: "outward" }),
        check: (input: { arguments: unknown; revisions: { representationRevisionId: string; content: unknown }[] }) => ({
          kind: "checked", usedRevisionIds: input.revisions.map((r) => r.representationRevisionId),
          actual: input.arguments, pinned: input.revisions[0]!.content,
        }),
      } }, identity, "artifact-action-check/v1");
      spies.push(vi.spyOn(registry, "resolveCapabilityProviders").mockReturnValue([provider] as never));
      h.leaf = bindArtifactGuardedMcpHandler(OUTWARD_TOOL, async (input: unknown) => {
        h.leafEffects.push(input);
        return { published: true };
      }, identity, { name: OUTWARD_TOOL, outward: {} });

      await seedRunAtGate();
      await seedApprovedGate();
      h.onSend = async () => [
        await passthrough(OUTWARD_TOOL, { recipient: "approved" }),
        await passthrough(OUTWARD_TOOL, { recipient: "approved" }),
      ];
      await approve();
      expect(h.callbacks).toHaveLength(1);
      const [first, second] = h.callbacks[0] as Array<{ status: number; body: Record<string, unknown> }>;
      expect(first).toMatchObject({ status: 200, body: { published: true } });
      expect(second).toMatchObject({ status: 500, body: { error: "action_gate_already_consumed" } });
      expect(h.leafEffects).toEqual([{ recipient: "approved" }]);
      const burns = await pool(
        `SELECT gate_id FROM "${q(TEST_SCHEMA)}"."artifact_review_action_consumptions" WHERE run_id = $1`, [h.runId]);
      expect(burns.rows).toHaveLength(1);
      expect(h.handled).toEqual([{ fromStatus: "running" }]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

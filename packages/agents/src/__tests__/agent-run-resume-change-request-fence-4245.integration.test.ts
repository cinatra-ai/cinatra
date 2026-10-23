/**
 * cinatra#4245 — the DIRECT resume (`agent_run_resume`) never sends a paused run
 * past a pause whose review took a change request, even when the change request
 * commits while the resume is already under way. REAL store for the run, the
 * gates, the change request and the drain's stop; only identity, transport and
 * the run credential are replaced.
 *
 * The resume and a change request serialize on the run's row
 * (the direct resume's claim in mcp/handlers.ts): the resume claims the pause (`pending_approval ->
 * running`) before its first write, and a change request needs the run still
 * `pending_approval` at that pause under the same row lock. Barriers: BEFORE
 * THE CLAIM (after the early check), and AT THE MINT (after the claim, right
 * before the send). The drain is held between its last read and its stop.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { producedEventId } from "@/lib/lifecycle/lifecycle-produced-event";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const ctl = vi.hoisted(() => ({
  run: null as null | Record<string, unknown>,
  hold: false,
  reached: null as null | (() => void),
  release: null as null | Promise<void>,
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));
vi.mock("../auth-policy", async (orig) => ({
  ...(await orig<typeof import("../auth-policy")>()),
  enforceRunAccess: vi.fn(async () => undefined),
}));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../store", async (orig) => ({
  ...(await orig<typeof import("../store")>()),
  // The handler's own access-filtered read: the seeded run as it was when the
  // resume began. Everything the fence reads comes from the real store.
  readAgentRunById: vi.fn(async () => ctl.run),
  readRunCoOwners: vi.fn(async () => []),
  readAgentTemplateById: vi.fn(async () => ({
    id: "tmpl-fence",
    packageName: "@cinatra-ai/fence-agent",
    sourceType: "internal",
    agentAuthPolicy: null,
  })),
  writeHitlPrompt: vi.fn(async () => undefined),
  // BEFORE THE CLAIM: the direct resume's claim is its `pending_approval ->
  // running` compare-and-set; held here, right before it runs.
  transitionRunStatus: async (...args: Parameters<typeof import("../store").transitionRunStatus>) => {
    const actual = await orig<typeof import("../store")>();
    if (ctl2.holdClaim && args[1] === "pending_approval" && args[2] === "running") {
      ctl2.holdClaim = false;
      ctl2.claimReached?.();
      await ctl2.claimRelease;
    }
    return actual.transitionRunStatus(...args);
  },
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  createWayflowFetch: vi.fn(() => globalThis.fetch),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
const mint = vi.hoisted(() => vi.fn(async () => {
  if (ctl.hold) {
    ctl.hold = false;
    ctl.reached?.();
    await ctl.release;
  }
  return {};
}));
vi.mock("../wayflow-run-token-carrier", () => ({ mintResumeRunTokenMetadata: mint }));

// BEFORE THE CLAIM: hold the resume after its early check, right before it
// claims the pause. AT THE STOP: hold the drain after its last read, right
// before its compare-and-set. GATE READ FAILURE: the next gate-list read throws.
const ctl2 = vi.hoisted(() => ({
  holdClaim: false,
  claimReached: null as null | (() => void),
  claimRelease: null as null | Promise<void>,
  holdStop: false,
  stopReached: null as null | (() => void),
  stopRelease: null as null | Promise<void>,
  failGateRead: false,
  failClear: false,
}));
vi.mock("../artifact-review-gate-store", async (orig) => {
  const actual = (await orig()) as typeof import("../artifact-review-gate-store");
  return {
    ...actual,
    listReviewGatesForRun: async (...args: Parameters<typeof actual.listReviewGatesForRun>) => {
      if (ctl2.failGateRead) {
        ctl2.failGateRead = false;
        throw new Error("injected gate-list read failure");
      }
      return actual.listReviewGatesForRun(...args);
    },
  };
});
vi.mock("../lifecycle-coordinator", async (orig) => {
  const actual = (await orig()) as typeof import("../lifecycle-coordinator");
  return {
    ...actual,
    advanceAgentRun: async (...args: Parameters<typeof actual.advanceAgentRun>) => {
      if (ctl2.holdStop) {
        ctl2.holdStop = false;
        ctl2.stopReached?.();
        await ctl2.stopRelease;
      }
      return actual.advanceAgentRun(...args);
    },
    clearRunLifecycleMoment: async (...args: Parameters<typeof actual.clearRunLifecycleMoment>) => {
      if (ctl2.failClear) {
        ctl2.failClear = false;
        throw new Error("injected lifecycle-moment clear failure");
      }
      return actual.clearRunLifecycleMoment(...args);
    },
  };
});
const sendTask = vi.hoisted(() => vi.fn(async () => ({ id: "t", status: { state: "input-required" } }) as unknown));
vi.mock("../../../a2a/src/external-client", () => ({
  createExternalA2AClient: vi.fn(async () => ({ sendTask })),
}));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));
vi.mock("../verdaccio/publish-metadata", () => ({ derivePublishMetadataFromSnapshot: vi.fn() }));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({
  isSafePathSegment: (s: unknown): boolean =>
    typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s),
  assertSafePathSegment: (): void => undefined,
  listAgentPackages: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(() => ({ attributes: {}, body: "" })),
}));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectGrantsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  listAccessibleOrgIdsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));

const TEST_SCHEMA = "cinatra_test_resume_fence_4245";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-4245-fence";

let gateStore: typeof import("../artifact-review-gate-store");
let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
let dispatchStore: typeof import("../lifecycle-repair-dispatch-store");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
  await replayStoreSchema(admin, buildCreateStoreSchemaQueries(TEST_SCHEMA));
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
  gateStore = await import("../artifact-review-gate-store");
  outboxStore = await import("../lifecycle-produced-outbox-store");
  crStore = await import("../lifecycle-review-changes-requested-store");
  dispatchStore = await import("../lifecycle-repair-dispatch-store");
  dbMod = await import("../db");
  await pool(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG],
  );
}, 90_000);

beforeEach(() => {
  vi.clearAllMocks();
  ctl.run = null;
  ctl.hold = false;
  ctl.reached = null;
  ctl.release = null;
  ctl2.holdClaim = false;
  ctl2.claimReached = null;
  ctl2.claimRelease = null;
  ctl2.holdStop = false;
  ctl2.stopReached = null;
  ctl2.stopRelease = null;
  ctl2.failGateRead = false;
  ctl2.failClear = false;
});

afterAll(async () => {
  if (!HAS_DB) return;
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

/** A repair-capable run paused at a declared review step whose gate names its
 * produced event. */
async function seedPausedAtDeclaredGate() {
  const runId = `run-fence-${randomUUID()}`;
  const task = randomUUID();
  const templateId = `tmpl-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,$4)`,
    [templateId, ORG, `@cinatra-ai/seed-${templateId}`, JSON.stringify({ repairCapable: true })],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, input_params, status, a2a_task_id, a2a_context_id, run_by)
     VALUES ($1,$2,$3,'{}','pending_approval',$4,$5,'user-a')`,
    [runId, templateId, ORG, task, `ctx-${task}`],
  );
  const artifactId = `art-${randomUUID()}`;
  const rev = `rev-${randomUUID()}`;
  const reviewTaskId = `wayflow-${task}`;
  const gate = await gateStore.emitArtifactReviewGate({
    runId, orgId: ORG, reviewTaskId, targets: [{ artifactId, representationRevisionId: rev }], expiresAt: null,
  });
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, 'document', '{}'::jsonb, $2)`,
    [artifactId, ORG],
  );
  await outboxStore.emitArtifactProduced({
    eventId: producedEventId(artifactId, rev), orgId: ORG, artifactId, representationRevisionId: rev,
    eventKind: "artifact_produced", emitter: "createSemanticArtifact", producerRunId: runId, producerAgentId: null,
    originKind: "agent_produced", destinationClass: "none", continuationMode: "async_effects_gated",
    continuationAddress: gate.gateId as string,
  }, dbMod.db);
  ctl.run = {
    id: runId, templateId, status: "pending_approval", a2aTaskId: task, a2aContextId: `ctx-${task}`,
    orgId: ORG, runBy: "user-a", authPolicy: null, packageVersion: "1.0.0", inputParams: {},
    createdAt: new Date("2026-01-01"), sourceType: "internal",
  };
  return { runId, task, reviewTaskId, gateId: gate.gateId as string, artifactId, rev };
}

async function comment(s: { runId: string; reviewTaskId: string; artifactId: string; rev: string }) {
  return crStore.recordReviewSurfaceChangesRequested({
    runId: s.runId,
    reviewTaskId: s.reviewTaskId,
    baseTarget: { artifactId: s.artifactId, representationRevisionId: s.rev },
    currentBaseRevisionId: s.rev,
    feedback: "Shorten the second paragraph.",
  });
}

async function resume(runId: string): Promise<unknown> {
  const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
  return createAgentBuilderPrimitiveHandlers().agent_run_resume({
    primitiveName: "agent_run_resume",
    input: { runId },
    actor: { actorType: "human" as const, source: "ui" as const, userId: "user-a" },
    mode: "deterministic",
  } as never);
}

/** Start a resume and hold it right before its send (at the credential mint). */
async function resumeHeldBeforeSend(runId: string) {
  let reached!: () => void;
  const atMint = new Promise<void>((r) => { reached = r; });
  let release!: () => void;
  ctl.release = new Promise<void>((r) => { release = r; });
  ctl.reached = reached;
  ctl.hold = true;
  const pending = resume(runId).catch((e: unknown) => ({ thrown: String(e) }));
  await atMint;
  return { release, pending };
}

/** Start a resume and hold it after its early check, right before its claim. */
async function resumeHeldBeforeClaim(runId: string) {
  let reached!: () => void;
  const atClaim = new Promise<void>((r) => { reached = r; });
  let release!: () => void;
  ctl2.claimRelease = new Promise<void>((r) => { release = r; });
  ctl2.claimReached = reached;
  ctl2.holdClaim = true;
  const pending = resume(runId).catch((e: unknown) => ({ thrown: String(e) }));
  await atClaim;
  return { release, pending };
}

/** Start the drain's stop and hold it after its last read, right before its CAS. */
async function stopHeldBeforeCas(gateId: string) {
  let reached!: () => void;
  const atStop = new Promise<void>((r) => { reached = r; });
  let release!: () => void;
  ctl2.stopRelease = new Promise<void>((r) => { release = r; });
  ctl2.stopReached = reached;
  ctl2.holdStop = true;
  const pending = dispatchStore.stopRunPausedAtDeclaredGate({ gateId, orgId: ORG });
  await atStop;
  return { release, pending };
}

async function runRow(runId: string) {
  const r = await pool(`SELECT status, a2a_task_id FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`, [runId]);
  return r.rows[0] as { status: string; a2a_task_id: string | null } | undefined;
}

async function gateRow(gateId: string) {
  const r = await pool(`SELECT status, disposition FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id=$1`, [gateId]);
  return r.rows[0] as { status: string; disposition: string | null };
}

async function repairCount(gateId: string): Promise<number> {
  const r = await pool(`SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE gate_id=$1`, [gateId]);
  return (r.rows[0] as { n: number }).n;
}

describe.skipIf(!HAS_DB)("cinatra#4245 — the direct resume and a change request (real store)", () => {
  it("control: with no change request the held resume sends once", async () => {
    const s = await seedPausedAtDeclaredGate();
    const r = await resumeHeldBeforeSend(s.runId);
    r.release();
    await r.pending;
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("WINDOW 1: a change request that commits after the early check and before the claim ends the resume: no prompt write, no credential, no send; the run stays at its pause", async () => {
    const s = await seedPausedAtDeclaredGate();
    const r = await resumeHeldBeforeClaim(s.runId);
    const cr = await comment(s);
    expect(cr.ok).toBe(true);
    r.release();
    const out = await r.pending;
    const store = await import("../store");
    expect(out).toMatchObject({ error: expect.stringContaining("can no longer be resumed") });
    expect(store.writeHitlPrompt).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
    // The claim was given back: the drain still finds the run at its pause.
    expect(await runRow(s.runId)).toEqual({ status: "pending_approval", a2a_task_id: s.task });
    expect(await dispatchStore.stopRunPausedAtDeclaredGate({ gateId: s.gateId, orgId: ORG })).toBe("stopped");
  });

  it("WINDOWS 2 AND 3: once the claim committed, a change request is refused (stays a note) and the held resume sends once", async () => {
    const s = await seedPausedAtDeclaredGate();
    const r = await resumeHeldBeforeSend(s.runId);
    expect((await runRow(s.runId))?.status).toBe("running");
    const cr = await comment(s);
    expect(cr.ok).toBe(false);
    if (!cr.ok) expect(cr.code).toBe(crStore.DECLARED_GATE_NOT_ELIGIBLE);
    expect(await gateRow(s.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairCount(s.gateId)).toBe(0);
    r.release();
    await r.pending;
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("a claim taken after a committed change request makes the drain wait (claim-pending), and the drain stops the run once the claim is given back", async () => {
    const s = await seedPausedAtDeclaredGate();
    expect((await comment(s)).ok).toBe(true);
    // A claim in flight at this pause (status-only, as the claim's CAS writes it).
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='running' WHERE id=$1`, [s.runId]);
    expect(await dispatchStore.stopRunPausedAtDeclaredGate({ gateId: s.gateId, orgId: ORG })).toBe("claim-pending");
    expect((await runRow(s.runId))?.status).toBe("running");
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='pending_approval' WHERE id=$1`, [s.runId]);
    expect(await dispatchStore.stopRunPausedAtDeclaredGate({ gateId: s.gateId, orgId: ORG })).toBe("stopped");
  });

  it("with the drain held between its last read and its stop, a direct resume cannot move the run to a later pause; the stop lands at this pause", async () => {
    const s = await seedPausedAtDeclaredGate();
    expect((await comment(s)).ok).toBe(true);
    const d = await stopHeldBeforeCas(s.gateId);
    const out = await resume(s.runId);
    expect(out).toMatchObject({ error: expect.stringContaining("can no longer be resumed") });
    expect(sendTask).not.toHaveBeenCalled();
    expect(await runRow(s.runId)).toEqual({ status: "pending_approval", a2a_task_id: s.task });
    d.release();
    expect(await d.pending).toBe("stopped");
    expect((await runRow(s.runId))?.status).toBe("stopped");
  });

  it("the drain's lost compare-and-set reads back: stopped converges, another status escalates, a claim at the pause waits", async () => {
    for (const [status, expected] of [
      ["stopped", "stopped"],
      ["failed", "not-paused"],
      ["running", "claim-pending"],
    ] as const) {
      const s = await seedPausedAtDeclaredGate();
      expect((await comment(s)).ok).toBe(true);
      const d = await stopHeldBeforeCas(s.gateId);
      await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status=$2 WHERE id=$1`, [s.runId, status]);
      d.release();
      expect(await d.pending).toBe(expected);
    }
  });

  it("the drain's branches: a gate that is not there or not declared, an absent run, a run that waits at a later declared pause", async () => {
    expect(await dispatchStore.stopRunPausedAtDeclaredGate({ gateId: `gate-absent-${randomUUID()}`, orgId: ORG })).toBe("not-declared");

    // A declared gate whose run is not there (gates carry no foreign key to runs).
    const orphan = await gateStore.emitArtifactReviewGate({
      runId: `run-absent-${randomUUID()}`, orgId: ORG, reviewTaskId: `wayflow-${randomUUID()}`,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }], expiresAt: null,
    });
    expect(await dispatchStore.stopRunPausedAtDeclaredGate({ gateId: orphan.gateId as string, orgId: ORG })).toBe("not-paused");

    const t = await seedPausedAtDeclaredGate();
    expect((await comment(t)).ok).toBe(true);
    // The run opened a declared gate of ANOTHER pause after this one.
    await gateStore.emitArtifactReviewGate({
      runId: t.runId, orgId: ORG, reviewTaskId: `wayflow-${randomUUID()}`,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }], expiresAt: null,
    });
    expect(await dispatchStore.stopRunPausedAtDeclaredGate({ gateId: t.gateId, orgId: ORG })).toBe("not-paused");
    expect((await runRow(t.runId))?.status).toBe("pending_approval");
  });

  it("a lifecycle-moment clear that fails after the stop throws, and the next drain converges (stopped, cleared)", async () => {
    const s = await seedPausedAtDeclaredGate();
    expect((await comment(s)).ok).toBe(true);
    ctl2.failClear = true;
    await expect(dispatchStore.stopRunPausedAtDeclaredGate({ gateId: s.gateId, orgId: ORG })).rejects.toThrow(/clear failure/);
    expect((await runRow(s.runId))?.status).toBe("stopped");
    expect(await dispatchStore.stopRunPausedAtDeclaredGate({ gateId: s.gateId, orgId: ORG })).toBe("stopped");
  });

  it("a gate read that fails right after the claim gives the claim back and sends nothing", async () => {
    const s = await seedPausedAtDeclaredGate();
    const r = await resumeHeldBeforeClaim(s.runId);
    ctl2.failGateRead = true;
    r.release();
    const out = await r.pending;
    expect(JSON.stringify(out)).toMatch(/injected gate-list read failure|error/);
    expect(sendTask).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(await runRow(s.runId)).toEqual({ status: "pending_approval", a2a_task_id: s.task });
  });

  it("two direct resumes of one pause past their early check: exactly one claims and sends, the other is refused (not-pending)", async () => {
    const s = await seedPausedAtDeclaredGate();
    const first = await resumeHeldBeforeClaim(s.runId);
    const second = await resumeHeldBeforeSend(s.runId); // the second claimed; it holds the pause.
    first.release();
    expect(await first.pending).toMatchObject({ error: expect.stringContaining("not pending approval") });
    second.release();
    await second.pending;
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("a failure before the send (the credential mint) gives the claim back: the run waits at its pause again", async () => {
    const s = await seedPausedAtDeclaredGate();
    mint.mockRejectedValueOnce(new Error("injected mint failure"));
    const out = await resume(s.runId).catch((e: unknown) => ({ thrown: String(e) }));
    expect(JSON.stringify(out)).toMatch(/injected mint failure|error/);
    expect(sendTask).not.toHaveBeenCalled();
    expect(await runRow(s.runId)).toEqual({ status: "pending_approval", a2a_task_id: s.task });
    // And a change request is accepted again on the given-back pause.
    expect((await comment(s)).ok).toBe(true);
  });

  it("a run that waits at another task when the claim lands gives the claim back and sends nothing", async () => {
    const s = await seedPausedAtDeclaredGate();
    const r = await resumeHeldBeforeClaim(s.runId);
    const other = `hitl-${randomUUID()}`;
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET a2a_task_id=$2 WHERE id=$1`, [s.runId, other]);
    r.release();
    const out = await r.pending;
    expect(out).toMatchObject({ error: expect.any(String) });
    expect(sendTask).not.toHaveBeenCalled();
    expect(await runRow(s.runId)).toEqual({ status: "pending_approval", a2a_task_id: other });
  });

  it("CONTINUE (UI answer): a change request committed before the Continue claim ends the answer — the claim is given back, nothing is sent", async () => {
    const s = await seedPausedAtDeclaredGate();
    expect((await comment(s)).ok).toBe(true);
    const { approveReviewTaskInternal } = await import("../review-task-actions");
    await expect(approveReviewTaskInternal(s.reviewTaskId, "user-a", undefined)).rejects.toThrow(
      /changes were requested on its review/,
    );
    expect(mint).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
    expect(await runRow(s.runId)).toEqual({ status: "pending_approval", a2a_task_id: s.task });
    // The drain still finds the run at its pause and stops it there.
    expect(await dispatchStore.stopRunPausedAtDeclaredGate({ gateId: s.gateId, orgId: ORG })).toBe("stopped");
  });

  it("CONTINUE (UI answer): once the Continue claim committed, a change request is refused (stays a note) and the answer sends once", async () => {
    const s = await seedPausedAtDeclaredGate();
    let reached!: () => void;
    const atMint = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    ctl.release = new Promise<void>((r) => { release = r; });
    ctl.reached = reached;
    ctl.hold = true;
    const { approveReviewTaskInternal } = await import("../review-task-actions");
    const pending = approveReviewTaskInternal(s.reviewTaskId, "user-a", undefined).catch((e: unknown) => ({ thrown: String(e) }));
    await atMint;
    expect((await runRow(s.runId))?.status).toBe("running");
    const cr = await comment(s);
    expect(cr.ok).toBe(false);
    expect(await gateRow(s.gateId)).toEqual({ status: "pending", disposition: null });
    expect(await repairCount(s.gateId)).toBe(0);
    release();
    await pending;
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("a change request committed before the resume begins: no write and no send", async () => {
    const s = await seedPausedAtDeclaredGate();
    expect((await comment(s)).ok).toBe(true);
    const store = await import("../store");
    await resume(s.runId);
    expect(store.writeHitlPrompt).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("a later ordinary HITL pause (no review gate) still resumes, and the earlier change request's stop leaves it alone", async () => {
    const s = await seedPausedAtDeclaredGate();
    expect((await comment(s)).ok).toBe(true);
    // The run had gone on before the change request committed and now waits at
    // an ordinary HITL step: same status, another task.
    const later = `hitl-${randomUUID()}`;
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET a2a_task_id=$2 WHERE id=$1`, [s.runId, later]);
    ctl.run = { ...ctl.run, a2aTaskId: later };
    expect(await dispatchStore.stopRunPausedAtDeclaredGate({ gateId: s.gateId, orgId: ORG })).toBe("not-paused");
    await resume(s.runId).catch(() => undefined);
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("the fence's rule: the bare pause passes; an absent run, another organization, another task, another status or a change request refuses", async () => {
    const { resumeStillAllowed } = await import("../lifecycle-declared-review-gate");
    const s = await seedPausedAtDeclaredGate();
    const at = { id: s.runId, orgId: ORG, expectedTaskId: s.task };
    expect(await resumeStillAllowed(at)).toBe(true);
    expect(await resumeStillAllowed({ ...at, id: `run-absent-${randomUUID()}` })).toBe(false);
    expect(await resumeStillAllowed({ ...at, orgId: "org-4245-other" })).toBe(false);
    expect(await resumeStillAllowed({ ...at, expectedTaskId: randomUUID() })).toBe(false);
    expect(await resumeStillAllowed({ ...at, expectedTaskId: "" })).toBe(false);

    const t = await seedPausedAtDeclaredGate();
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='running' WHERE id=$1`, [t.runId]);
    expect(await resumeStillAllowed({ id: t.runId, orgId: ORG, expectedTaskId: t.task })).toBe(false);

    expect((await comment(s)).ok).toBe(true);
    expect(await resumeStillAllowed(at)).toBe(false);
  });
});

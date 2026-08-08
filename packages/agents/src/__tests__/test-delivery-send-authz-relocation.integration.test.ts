/**
 * Test-delivery send-authz under renderer relocation (#1958) — REAL store + REAL
 * seam, NO boundary stub.
 *
 * This is the regression the walk prescribed. The #1958 lane relocated the
 * test-delivery input renderer out of core into @cinatra-ai/email-artifacts,
 * flipping the generated binding's physical `declaredBy` from the agent to the
 * artifacts pack while leaving the binding ID — the gate identity —
 * `@cinatra-ai/email-test-delivery-agent:input`. The send-authz gate
 * (test-delivery-handlers.ts) had keyed on `declaredBy`, so every send by the
 * relocated agent was refused ("not authorized"). The fix keys on the binding-ID
 * OWNER prefix (the agent that HOSTS the gate), invariant under the relocation.
 *
 * Why this test and not the handler unit test: the unit suite mocks
 * `field-renderer-bindings.server` — the exact boundary that hid the regression.
 * Here we resolve the REAL generated bindings (the relocated `declaredBy`) against
 * the REAL agent_run_test_sends ledger in Postgres, inside the run-bound
 * mcpRequestContextStorage frame /api/agents/passthrough establishes, and assert an
 * actual `sent` ledger row. The ONLY stub is the transport `TestDeliverySendPort`
 * (the real Gmail/Resend egress boundary — the same injectable seam the primitive's
 * own unit test uses); the authz decision under test runs entirely unmocked.
 *
 *   FAILS on 400809452 (declaredBy-keyed authz → not_authorized → a `failed`
 *   pre-claim row, never `sent`); PASSES with the binding-ID-owner fix.
 *
 * DB-gated: skips when SUPABASE_DB_URL is unset (mirrors the HITL prims test).
 *   pnpm --filter @cinatra-ai/agents test:integration \
 *     -- src/__tests__/test-delivery-send-authz-relocation.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getOrCreateByUniqueKey } from "./__fixtures__/integration-fixture-helpers";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import {
  setTestDeliverySendPort,
  type TestDeliverySendPort,
} from "../test-delivery-send-port";
import { GENERATED_FIELD_RENDERER_BINDINGS } from "@/lib/generated/agent-bindings";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");

// The ORM (packages/agents/src/schema.ts) qualifies every table under the schema
// named by SUPABASE_SCHEMA (default "cinatra") — the same schema the fixture
// anchor re-assert below writes to.
const SCHEMA = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
// The gate-owning agent package below is a GLOBALLY UNIQUE `agent_templates.
// package_name`, and the sibling suite
// `test-delivery-resume-idempotency.integration.test.ts` needs a template
// under that SAME name (the send-authz gate keys on the binding-ID owner
// package, so neither suite can substitute its own). One row therefore serves
// both suites — so both anchor it to the SAME fixture org. cinatra#2485 C makes
// a template's install scope its run authority, and a template that two orgs
// took turns claiming would refuse whichever suite ran second. Sharing the org
// is the honest model for a shared row; it is NOT a fixture that reassigns
// ownership (the store deliberately LOCKS owner_level/owner_id once
// `first_run_at` is set — see `updateAgentTemplate`).
const SHARED_TEST_DELIVERY_ORG = "org-test-delivery-fixture";
const ORG = SHARED_TEST_DELIVERY_ORG;
// cinatra#1939 wave 2 / #1940 P3: createAgentRun now runs under guardOrgMutation
// and REQUIRES a host-minted authority; the guard also reads the org's
// lifecycle from `public."organization"` — this DB-gated suite needs an
// ACTIVE org row for ORG for the guarded writes to pass at runtime (seeded in
// beforeAll / cleaned up in afterAll below).
const AUTH = { orgId: ORG, can: () => true };

// The gate identity (binding ID) whose OWNER prefix must authorize the send, and
// the relocated renderer's physical shipper (`declaredBy`), which must NOT.
const GATE_OWNER_PKG = "@cinatra-ai/email-test-delivery-agent";
const RENDERER_SHIPPER_PKG = "@cinatra-ai/email-artifacts";

type Store = typeof import("../store");
type Ledger = typeof import("../agent-run-test-sends");
type Handlers = Record<string, (req: Record<string, unknown>) => Promise<unknown>>;

let store: Store;
let ledger: Ledger;
let handlers: Handlers;
let pg: Client;

// A fake transport port — ok on both phases. This is the ONE legitimate stub: the
// real outbound-email boundary (parity with the primitive's unit test). Everything
// gating the send (binding resolution + authz + the ledger) stays real.
const okPort: TestDeliverySendPort = {
  prepareSend: async (p) => ({ ok: true, recipientEmail: p.recipientEmail, selectedDraftIds: ["draft-1"] }),
  performSend: async (p) => ({
    ok: true,
    sentTo: p.recipientEmail,
    sentCount: p.selectedDraftIds.length,
    deliveredDraftIds: p.selectedDraftIds,
    message: `Test email sent to ${p.recipientEmail}.`,
  }),
  reconcile: async () => "unknown",
};

beforeAll(async () => {
  if (!hasDb) return;
  store = await import("../store");
  ledger = await import("../agent-run-test-sends");
  const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
  handlers = createAgentBuilderPrimitiveHandlers() as Handlers;
  setTestDeliverySendPort(okPort);
  pg = new Client({ connectionString: dbUrl });
  await pg.connect();
  await pg.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
});

afterAll(async () => {
  if (!hasDb) return;
  setTestDeliverySendPort(null);
  await pg.query(`DELETE FROM public."member" WHERE "userId" = ANY($1)`, [seededUsers]).catch(() => {});
  await pg.query(`DELETE FROM public."user" WHERE id = ANY($1)`, [seededUsers]).catch(() => {});
  // The SHARED fixture org is deliberately NOT deleted: the sibling suite anchors
  // the same shared template to it, and tearing it down would leave that template
  // pointing at a vanished org. Same permanently-seeded convention as the
  // `org-test` fixture in store-org-required.integration.test.ts ("the row is
  // never deleted so no suite can pull it out from under another"). The
  // per-test users above ARE suite-owned, so those are cleaned up.
  await pg.end();
});

// `agent_templates.package_name` is UNIQUE and the target agent is already
// registered in the shared DB (boot), so reuse-or-create by package name —
// idempotent across re-runs and faithful (the ADMIT case runs against the REAL
// registered template). The run rows are always fresh (random ids).
async function getOrCreateTemplate(packageName: string): Promise<string> {
  // `package_name` is UNIQUE and BOTH test-delivery suites resolve this same
  // row, so a bare read-then-create is a race: run concurrently against one
  // schema, both miss the read and the loser's INSERT dies on the constraint
  // during fixture setup. The constraint is the arbiter — a unique violation
  // means someone else created the shared fixture, so adopt theirs.
  const row = await getOrCreateByUniqueKey<{ id: string }>({
    read: () => store.readAgentTemplateByPackageName(packageName),
    create: () =>
      store.createAgentTemplate({
        id: `t_${randomUUID()}`,
        name: `td-authz-${randomUUID().slice(0, 8)}`,
        sourceNl: "test",
        compiledPlan: [],
        inputSchema: {},
        approvalPolicy: { steps: [] },
        packageName,
        // cinatra#2485 C — the template's INSTALL SCOPE is what authorizes a run.
        orgId: ORG,
      }),
  });
  const templateId = row.id;
  // REPAIR-ONLY, and ONLY for a row that is scope-less on ALL THREE columns —
  // the exact shape `withDeterminateInstallScope` stamps at write time. A
  // per-column COALESCE would be WRONG: it would silently adopt a PARTIAL tuple
  // (`owner_level='team'` with a null org, or `owner_id=''`) into a valid-looking
  // org anchor and could admit an actor the real scope never authorized. It also
  // never moves an already-anchored template — reassigning ownership is exactly
  // what the store forbids after first run, and a fixture must not model
  // something production refuses. The read-back below turns every other shape
  // (partial, or anchored to a foreign org) into a LOUD fixture failure.
  await pg.query(
    `UPDATE "${SCHEMA}".agent_templates
        SET org_id = $2, owner_level = 'organization', owner_id = $2
      WHERE id = $1
        AND org_id IS NULL AND owner_level IS NULL AND owner_id IS NULL`,
    [templateId, ORG],
  );
  const { rows: anchorRows } = await pg.query<{
    org_id: string | null; owner_level: string | null; owner_id: string | null;
  }>(
    `SELECT org_id, owner_level, owner_id FROM "${SCHEMA}".agent_templates WHERE id = $1`,
    [templateId],
  );
  const anchor = anchorRows[0];
  if (
    !anchor || anchor.org_id !== ORG
    || anchor.owner_level !== "organization" || anchor.owner_id !== ORG
  ) {
    throw new Error(
      `fixture: the shared template for ${packageName} carries a foreign or partial `
      + `install scope ${JSON.stringify(anchor)} — expected org-scoped to ${ORG}. `
      + `Refusing to reassign an owned template; clear the row or use a clean schema.`,
    );
  }
  return templateId;
}

// cinatra#2485 C — the run-scope gate re-resolves a run's `run_by` LIVE against
// better-auth (`resolveOrgRoleForUser`), so a synthetic run owner with no
// membership row is refused as cross-org. Every run below carries a fresh random
// human, so each one is seeded as a REAL member of ORG first (the pattern
// `lifecycle-repair-dispatch.integration.test.ts` documents: "the dispatch-time
// principal gate needs a live-resolvable org role"). `public."user"` /
// `public."member"` are better-auth tables and live UNQUALIFIED in `public`.
const seededUsers: string[] = [];

async function seedMember(userId: string): Promise<void> {
  await pg.query(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $1, $2, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@1958-authz.test`],
  );
  await pg.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-1958-${userId}`, ORG, userId],
  );
  seededUsers.push(userId);
}

async function makeRun(packageName: string, runBy: string): Promise<{ runId: string; campaignId: string }> {
  const templateId = await getOrCreateTemplate(packageName);
  await seedMember(runBy);
  const campaignId = `camp_${randomUUID()}`;
  const run = await store.createAgentRun({
    id: `r_${randomUUID()}`,
    templateId,
    inputParams: { campaignId },
    orgId: ORG,
    runBy,
  }, AUTH);
  return { runId: run.id, campaignId };
}

function callSend(runId: string, submissionId: string, userId: string): Promise<Record<string, unknown>> {
  // Exactly the frame /api/agents/passthrough establishes for the run-scoped send
  // primitive: the VERIFIED run scope + submission id (never the forgeable ambient
  // runId). The actor is the run owner, so enforceRunAccess's owner short-circuit
  // admits read + execute without extra org wiring.
  return mcpRequestContextStorage.run(
    {
      runId: "run-HEADER-FORGED",
      verifiedRunScopeId: runId,
      verifiedSubmissionId: submissionId,
      userId,
      orgId: ORG,
    },
    () =>
      handlers["email_test_delivery_run_send"]({
        primitiveName: "email_test_delivery_run_send",
        input: { recipientEmail: "qa@example.test", selectionMode: "random_initial" },
        actor: { userId, actorType: "model", source: "agent" },
        mode: "agentic",
      }),
  ) as Promise<Record<string, unknown>>;
}

describe.skipIf(!hasDb)("test-delivery send-authz — the generated binding is the relocated shape (#1958)", () => {
  it("the real generated binding keeps the agent gate id but ships from the artifacts pack", () => {
    const binding = GENERATED_FIELD_RENDERER_BINDINGS.find((b) => b.kind === "test-delivery-input");
    expect(binding).toBeDefined();
    // Gate identity unchanged; renderer physically relocated. This is the exact
    // divergence the send-authz axis must survive.
    expect(binding?.id).toBe(`${GATE_OWNER_PKG}:input`);
    expect(binding?.declaredBy).toBe(RENDERER_SHIPPER_PKG);
  });
});

describe.skipIf(!hasDb)("test-delivery send-authz — real seam, relocated renderer (#1958)", () => {
  it("ADMITS the gate-owning agent and writes a `sent` ledger row (FAILS on 400809452)", async () => {
    const userId = `u_${randomUUID()}`;
    const { runId } = await makeRun(GATE_OWNER_PKG, userId);
    const submissionId = `sub_${randomUUID()}`;

    const result = await callSend(runId, submissionId, userId);

    // Authorized → the two-phase send ran → a real terminal `sent` row exists.
    expect(result).toMatchObject({ ok: true, sentTo: "qa@example.test" });
    const row = await ledger.readTestSendBySubmission(runId, submissionId);
    expect(row?.status).toBe("sent");
  });

  it("DENIES a run whose package is the renderer SHIPPER (declaredBy) — no `sent` row", async () => {
    // The pack that ships the renderer is NOT the gate owner. On the pre-fix
    // declaredBy-keyed gate this run would have been (wrongly) admitted; keyed on
    // the binding-ID owner it is refused. There is no runnable agent under the
    // artifacts pack in production — this pins the axis, not a real dispatch path.
    const userId = `u_${randomUUID()}`;
    const { runId } = await makeRun(RENDERER_SHIPPER_PKG, userId);
    const submissionId = `sub_${randomUUID()}`;

    const result = await callSend(runId, submissionId, userId);

    expect(result).toMatchObject({ ok: false, reason: "not_authorized" });
    const row = await ledger.readTestSendBySubmission(runId, submissionId);
    // A pre-claim `failed` row (advances gateCycle) is recorded — never `sent`.
    expect(row?.status).toBe("failed");
  });
});

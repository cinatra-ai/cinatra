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

const ORG = "org-td-authz-1958";

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
});

afterAll(() => {
  if (hasDb) setTestDeliverySendPort(null);
});

// `agent_templates.package_name` is UNIQUE and the target agent is already
// registered in the shared DB (boot), so reuse-or-create by package name —
// idempotent across re-runs and faithful (the ADMIT case runs against the REAL
// registered template). The run rows are always fresh (random ids).
async function getOrCreateTemplate(packageName: string): Promise<string> {
  const existing = await store.readAgentTemplateByPackageName(packageName);
  if (existing) return existing.id;
  const templateId = `t_${randomUUID()}`;
  await store.createAgentTemplate({
    id: templateId,
    name: `td-authz-${randomUUID().slice(0, 8)}`,
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    packageName,
  });
  return templateId;
}

async function makeRun(packageName: string, runBy: string): Promise<{ runId: string; campaignId: string }> {
  const templateId = await getOrCreateTemplate(packageName);
  const campaignId = `camp_${randomUUID()}`;
  const run = await store.createAgentRun({
    id: `r_${randomUUID()}`,
    templateId,
    inputParams: { campaignId },
    orgId: ORG,
    runBy,
  });
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

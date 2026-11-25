/**
 * cinatra#3089 — the approved send writes no object.
 *
 * The send that mails reviewed bodies binds each message to its approved
 * revision and holds one claim per message, all on the materialization ledger:
 * no statement it reaches touches an objects row, and it calls no write of the
 * objects client. Driven through `createTriggerEmailSendUseCases` with the
 * SHIPPED fan-out (type discovery, `bindFanoutMessageRevision`) and the SHIPPED
 * send records (`performRevisionEffectOnce` over `claimRevisionEffect`); only
 * the pooled database (a small `artifact_materializations` table with its
 * unique key, and the run lookup), the objects client's type list, the claim
 * store and the modules the materializer loads for other paths are stand-ins.
 *
 * Cases:
 *   W1 an approved send runs no statement on an objects row and no objects
 *      client write; each message's claim row shares its binding's output id,
 *      one per approved artifact of the run
 *   W2 a second send of the same approval writes no new row and mails nobody
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  org_id: string;
  run_id: string;
  output_id: string;
  path: string;
  extension: string;
  content_hash: string;
  artifact_id: string;
  representation_revision_id: string;
  phase: string;
};

const { poolQueryMock, table, statements, objectsClientCalls } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  table: { rows: [] as Row[] },
  statements: [] as string[],
  objectsClientCalls: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/pooled", async () => ({
  ...(await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled")),
  getPooledDb: () => ({ query: poolQueryMock }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({ getAgentPackage: vi.fn() }));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({ registryUrl: "http://registry.test", token: "t" })),
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: vi.fn() }));
vi.mock("../resolve-bound-artifact-type", () => ({ resolveBoundArtifactTarget: vi.fn() }));
vi.mock("../artifact-creation", () => ({ createSemanticArtifact: vi.fn() }));
vi.mock("../artifact-extension-access", () => ({ isArtifactExtensionWriteAllowed: vi.fn(async () => true) }));
vi.mock("../matcher-enqueue", () => ({ enqueueArtifactMatchRun: vi.fn() }));
vi.mock("../artifact-authoring", () => ({
  MAX_AUTHORED_CONTENT_BYTES: 10 * 1024 * 1024,
  TEXT_AUTHORING_COMPATIBLE_MIMES: new Set(["text/markdown", "text/plain"]),
}));
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: () => [
    {
      id: "claim-1",
      scope: "platform",
      objectTypeId: "@cinatra-ai/email:body",
      claimKind: "dedicated",
      extensionPackage: "@cinatra-ai/email-artifacts",
      status: "active",
      generation: 1,
      dispositions: null,
      installId: null,
      createdAt: null,
      updatedAt: null,
    },
  ],
}));
// The objects client: only the type list answers; any other call is recorded.
vi.mock("@cinatra-ai/objects", () => ({
  createDeterministicObjectsClient: () =>
    new Proxy(
      {},
      {
        get: (_t, name: string) =>
          name === "typesList"
            ? async () => ({ types: [{ type: "@cinatra-ai/email:body" }] })
            : name === "then"
              ? undefined
              : async () => {
                  objectsClientCalls.push(name);
                  throw new Error(`objects client ${name} is not expected`);
                },
      },
    ),
}));

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  createTriggerEmailSendUseCases,
  type DecidedBodyRead,
  type TriggerEmailSendDeps,
} from "../../trigger-email-send-use-cases";

/** The ledger statements the send reaches, over `table.rows` with its unique key. */
function runStatement(sql: string, params: unknown[]) {
  const p = (n: number) => params[n - 1] as string;
  const key = (r: Pick<Row, "run_id" | "output_id" | "extension" | "content_hash">) =>
    [r.run_id, r.output_id, r.extension, r.content_hash].join("|");
  const insert = (row: Row) => {
    if (table.rows.some((r) => key(r) === key(row))) return false;
    table.rows.push(row);
    return true;
  };
  if (/SELECT template_id FROM "public"\."agent_runs"/.test(sql)) {
    return { rows: p(1) === "run-1" && p(2) === "org-a" ? [{ template_id: "tpl-1" }] : [] };
  }
  if (/SELECT artifact_id, representation_revision_id\s+FROM "public"\."artifact_materializations"/.test(sql)) {
    const row = table.rows.find(
      (r) => r.run_id === p(1) && r.output_id === p(2) && r.extension === p(3) && r.content_hash === p(4) && r.org_id === p(5) && r.path === "email_fanout" && r.phase === "finalized",
    );
    return { rows: row ? [row] : [] };
  }
  if (/INSERT INTO "public"\."artifact_materializations"[\s\S]*VALUES \(\$1, \$2, \$3, \$4, NULL, 'email_fanout'/.test(sql)) {
    insert({ id: p(1), org_id: p(2), run_id: p(3), output_id: p(4), path: "email_fanout", extension: p(5), content_hash: p(6), artifact_id: p(7), representation_revision_id: p(8), phase: "finalized" });
    return { rows: [] };
  }
  if (/WITH bound AS/.test(sql)) {
    const bound = table.rows.find(
      (r) => r.org_id === p(2) && r.run_id === p(3) && r.output_id === p(4) && r.path === p(5) && r.phase === "finalized" && r.artifact_id === p(6) && r.representation_revision_id === p(7) && !(r.extension === p(8) && r.content_hash === p(8)),
    );
    if (!bound) return { rows: [] };
    const won = insert({ ...bound, id: p(1), output_id: p(4), path: p(5), extension: p(8), content_hash: p(8), phase: "claimed" });
    return { rows: won ? [{ id: p(1) }] : [] };
  }
  if (/^SELECT phase FROM/.test(sql.trim()) && /output_id = \$3/.test(sql)) {
    const row = table.rows.find((r) => r.org_id === p(1) && r.run_id === p(2) && r.output_id === p(3) && r.path === p(4) && r.extension === p(5) && r.content_hash === p(5));
    return { rows: row ? [{ phase: row.phase }] : [] };
  }
  if (/SET phase = 'finalized'/.test(sql)) {
    const row = table.rows.find((r) => r.id === p(1) && r.org_id === p(2) && r.extension === p(3) && r.content_hash === p(3) && r.phase === "claimed");
    if (!row) return { rows: [] };
    row.phase = "finalized";
    return { rows: [{ id: row.id }] };
  }
  throw new Error(`unexpected statement: ${sql}`);
}

const actor: PrimitiveActorContext = { actorType: "human", source: "route", userId: "user-1", sessionId: "s-1", orgId: "org-a" };
const CAMPAIGN_ID = "33333333-3333-4333-8333-333333333333";
const approved = [1, 2].map((n) => ({
  artifactId: `art-${n}`,
  representationRevisionId: `rev-${n}`,
  contactId: `c${n}`,
  recipientEmail: `p${n}@example.com`,
  subject: `Subject ${n}`,
}));

function send(sent: string[]) {
  const deps = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail: async (m: { to: string[] }) => {
      sent.push(m.to[0]!);
      return { providerId: "p", providerMessageId: `m-${sent.length}`, sentAt: "2026-11-25T00:00:00Z" };
    },
    getObjectByRef: async (ref: string) =>
      ref === "bundle"
        ? {
            id: ref,
            data: {
              cinatraAgentRunId: "run-1",
              drafts: approved.map((e) => ({ recipientId: e.contactId, recipientEmail: e.recipientEmail, subject: e.subject, body: `Body ${e.artifactId}` })),
            },
          }
        : { id: ref, data: { confirmedRecipients: approved.map((e) => ({ contactId: e.contactId, email: e.recipientEmail })) } },
    readDecidedBody: async (ref: { artifactId: string }): Promise<DecidedBodyRead> => ({
      ok: true,
      text: `Body ${ref.artifactId}`,
      data: { campaignId: CAMPAIGN_ID, contactId: ref.artifactId === "art-1" ? "c1" : "c2" },
    }),
    readRunReviewedBodies: async () => true,
    readCallingRun: async () => ({ runId: "run-1", stepId: "send" }),
    readPublishDecision: async () => ({
      status: "released",
      decidedBy: "user-2",
      surfacedValues: {
        campaignId: CAMPAIGN_ID,
        recipients: approved.map((e) => ({ email: e.recipientEmail, subject: e.subject })),
        emailBodies: approved,
      },
      declaredRows: [{ kind: "list", label: "Recipients", input: "recipients", columns: [{ label: "Email", field: "email" }, { label: "Subject", field: "subject" }] }],
    }),
  } as unknown as TriggerEmailSendDeps;
  return createTriggerEmailSendUseCases(deps).startInitialSend(
    { serviceId: "s", campaignId: CAMPAIGN_ID, approvedDraftBundleRef: "bundle", confirmedRecipientsRef: "list" } as never,
    actor,
  ) as unknown as Promise<{ status: string; sentCount: number; alreadySentCount?: number; errorMessage?: string }>;
}

beforeEach(() => {
  table.rows = [];
  statements.length = 0;
  objectsClientCalls.length = 0;
  poolQueryMock.mockReset();
  poolQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
    statements.push(sql);
    return runStatement(sql, params);
  });
});

describe("cinatra#3089 — the approved send writes no object", () => {
  it("W1 no statement touches an objects row; each claim row shares its binding's output id", async () => {
    const sent: string[] = [];
    const result = await send(sent);
    // red-first-expect: to be undefined
    expect(result.errorMessage).toBeUndefined();
    expect(result).toMatchObject({ status: "completed", sentCount: 2 });
    expect(sent).toEqual(["p1@example.com", "p2@example.com"]);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((sql) => /"objects"|\bobjects\b\s*(SET|WHERE|\()/i.test(sql))).toEqual([]);
    expect(objectsClientCalls).toEqual([]);
    const bindings = table.rows.filter((r) => r.extension === "@cinatra-ai/email-artifacts");
    const claims = table.rows.filter((r) => r.extension === "message-send");
    expect(bindings.map((r) => r.output_id)).toEqual(["email-body:run-1:art-1", "email-body:run-1:art-2"]);
    expect(claims.map((r) => r.output_id)).toEqual(bindings.map((r) => r.output_id));
    expect(claims.map((r) => [r.artifact_id, r.representation_revision_id, r.phase])).toEqual([
      ["art-1", "rev-1", "finalized"],
      ["art-2", "rev-2", "finalized"],
    ]);
  });

  it("W2 a second send of the same approval writes no new row and mails nobody", async () => {
    const sent: string[] = [];
    await send(sent);
    const rows = structuredClone(table.rows);
    const again = await send(sent);
    // red-first-expect: to match object { status: 'completed', …(2) }
    expect(again).toMatchObject({ status: "completed", sentCount: 0, alreadySentCount: 2 });
    expect(table.rows).toEqual(rows);
    expect(sent).toEqual(["p1@example.com", "p2@example.com"]);
    expect(statements.filter((sql) => /"objects"/.test(sql))).toEqual([]);
  });
});

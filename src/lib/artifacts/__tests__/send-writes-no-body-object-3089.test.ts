/**
 * cinatra#3089 — the approved send writes no BODY object.
 *
 * The send that mails reviewed bodies binds each message to its approved
 * revision and holds one claim per message, all on the materialization ledger:
 * the binding and the send records touch no objects row and call no write of
 * the objects client, so no body object is written. Driven through
 * `createTriggerEmailSendUseCases` with the SHIPPED fan-out (type discovery,
 * `bindFanoutMessageRevision`) and the SHIPPED send records
 * (`performRevisionEffectOnce` over `claimRevisionEffect`); only the pooled
 * database (a small `artifact_materializations` table with its unique key, and
 * the run lookup), the objects client's type list, the claim store and the
 * modules the materializer loads for other paths are stand-ins.
 *
 * What a send DOES write: W1 and W2 replace the mail sender with a stub, so
 * they see no mail record. W3 sends through the SHIPPED sender
 * (`createDefaultSendEmail`), the email connector's facade and the host's
 * sent-email writer (`saveSentEmailObject`); only the mail transport and the
 * session objects client (it records each save) are stand-ins. Each mailed
 * message writes its sent-email record, by design, and no body object.
 *
 * Cases:
 *   W1 an approved send (stub sender) runs no statement on an objects row and
 *      no objects client write; each message's claim row shares its binding's
 *      output id, one per approved artifact of the run
 *   W2 a second send of the same approval writes no new row and mails nobody
 *   W3 through the shipped sender and facade: each mailed message writes ONE
 *      sent-email record (with its campaign, contact and run) and no body
 *      object is written
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

const { poolQueryMock, table, statements, objectsClientCalls, sessionSaves } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  table: { rows: [] as Row[] },
  statements: [] as string[],
  objectsClientCalls: [] as string[],
  /** Each save of the session objects client (the host's sent-email writer uses it). */
  sessionSaves: [] as Array<{ typeHint?: string; rawData?: Record<string, unknown> }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/pooled", async () => ({
  ...(await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled")),
  // One connection of the pool is the same recorded statement runner.
  getPooledDb: () => ({ query: poolQueryMock, connect: async () => ({ query: poolQueryMock, release: () => undefined }) }),
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
// The stored revision's bytes: the storage key names the text (`blob:<text>`).
vi.mock("../local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({
    openByStorageKey: async ({ storageKey }: { storageKey: string }) => ({
      stream: (async function* () {
        yield Buffer.from(storageKey.replace(/^blob:/, ""), "utf8");
      })(),
    }),
  }),
}));
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
// The host's connector config: no development redirect.
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: <T,>(_key: string, fallback: T): T => fallback,
}));
// The objects client: only the type list answers; any other call is recorded.
// The session client (the host's routing reads and its sent-email writer)
// finds no sender identity and records each save.
vi.mock("@cinatra-ai/objects", () => ({
  createSessionObjectsClient: () => ({
    list: async () => ({ items: [] }),
    save: async (input: { typeHint?: string; rawData?: Record<string, unknown> }) => {
      sessionSaves.push(input);
      return { object: { id: `saved-${sessionSaves.length}` } };
    },
  }),
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

// The claim the passthrough route took for the call (cinatra#3089): the decision the call was signed for, else the
// step's decision, `d-1`; each stubbed decision carries that id unless it names its own.
const withClaim = <T extends { runId: string; publishDecisionId?: string; claim?: unknown } | null>(run: T): T =>
  run && !run.claim ? { ...run, claim: { runId: run.runId, decisionId: run.publishDecisionId ?? "d-1" } } : run;
const withDecisionId = <T extends object | null | undefined>(decision: T): T =>
  decision ? ({ id: "d-1", ...decision } as T) : decision;


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
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [] };
  if (/^SELECT pg_advisory_xact_lock_shared\(hashtext\(\$1\)\)$/.test(sql.trim())) return { rows: [] };
  if (sql === "SELECT 'decided' AS state") return { rows: [{ state: "decided" }] };
  if (/SELECT template_id FROM "public"\."agent_runs"/.test(sql)) {
    return { rows: p(1) === "run-1" && p(2) === "org-a" ? [{ template_id: "tpl-1" }] : [] };
  }
  // The binder reads the stored revision by its id and its artifact in the organisation.
  if (/SELECT b\.storage_key/.test(sql)) {
    return { rows: p(1) === "org-a" && p(3) === p(2).replace("art-", "rev-") ? [{ storage_key: `blob:Body ${p(2)}` }] : [] };
  }
  if (/^SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)$/.test(sql.trim())) return { rows: [] };
  if (/SELECT artifact_id, representation_revision_id FROM "public"\."artifact_materializations"/.test(sql)) {
    const rows = table.rows.filter(
      (r) => r.org_id === p(1) && r.run_id === p(2) && r.output_id === p(3) && r.path === "email_fanout" && r.phase === "finalized",
    );
    return { rows };
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
  // The send record read before the binding (`readRevisionEffect`).
  if (/^SELECT phase, representation_revision_id FROM/.test(sql.trim())) {
    const row = table.rows.find((r) => r.org_id === p(1) && r.run_id === p(2) && r.output_id === p(3) && r.path === p(4) && r.extension === p(5) && r.content_hash === p(5));
    return { rows: row ? [{ phase: row.phase, representation_revision_id: row.representation_revision_id }] : [] };
  }
  // The contact seat of the run (`holdRunSeat`).
  if (/INSERT INTO "public"\."artifact_materializations"[\s\S]*VALUES \(\$1, \$2, \$3, \$4, NULL, \$5, \$6, \$6, \$7, \$8, 'finalized'\)/.test(sql)) {
    insert({ id: p(1), org_id: p(2), run_id: p(3), output_id: p(4), path: p(5), extension: p(6), content_hash: p(6), artifact_id: p(7), representation_revision_id: p(8), phase: "finalized" });
    return { rows: [] };
  }
  if (/^SELECT artifact_id FROM/.test(sql.trim())) {
    const row = table.rows.find((r) => r.org_id === p(1) && r.run_id === p(2) && r.output_id === p(3) && r.path === p(4) && r.extension === p(5) && r.content_hash === p(5) && r.phase === "finalized");
    return { rows: row ? [{ artifact_id: row.artifact_id }] : [] };
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

function send(sent: string[], extra: Partial<TriggerEmailSendDeps> = {}) {
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
    readCallingRun: async () => withClaim({ runId: "run-1", stepId: "send" }),
    readClaimedPublishDecision: async (runId: string, decisionId: string) => {
      const decision = withDecisionId(await (deps as unknown as { readPublishDecision: (r: string, s: string) => Promise<object | null> }).readPublishDecision(runId, "send")) as { id?: string } | null;
      return decision?.id === decisionId ? decision : null;
    },
    // The decision state under the revision's lock, read on the claim's own
    // connection (the shipped reader's query is its own suite's subject).
    readRevisionStateUnderLock: async (query: (text: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>) => {
      const { rows } = await query("SELECT 'decided' AS state", []);
      return rows[0]?.state === "decided" ? null : "not decided";
    },
    readPublishDecision: async () => withDecisionId({
      status: "released",
      decidedBy: "user-2",
      surfacedValues: {
        campaignId: CAMPAIGN_ID,
        recipients: approved.map((e) => ({ email: e.recipientEmail, subject: e.subject })),
        emailBodies: approved,
      },
      declaredRows: [
        { kind: "list", label: "Recipients", input: "recipients", columns: [{ label: "Email", field: "email" }, { label: "Subject", field: "subject" }] },
        { kind: "artifacts", label: "Emails", input: "emailBodies" },
      ],
    }),
    ...extra,
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
  sessionSaves.length = 0;
  poolQueryMock.mockReset();
  poolQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
    statements.push(sql);
    return runStatement(sql, params);
  });
});

describe("cinatra#3089 — the approved send writes no body object", () => {
  it("W1 (stub sender) no statement touches an objects row; each claim row shares its binding's output id", async () => {
    const sent: string[] = [];
    const result = await send(sent);
    expect(result.errorMessage).toBeUndefined();
    expect(result).toMatchObject({ status: "completed", sentCount: 2 });
    expect(sent).toEqual(["p1@example.com", "p2@example.com"]);
    expect(statements.length).toBeGreaterThan(0);
    // Each claim was verified on its own connection under the revision's lock.
    expect(statements.filter((sql) => sql.trim() === "SELECT pg_advisory_xact_lock_shared(hashtext($1))")).toHaveLength(2);
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
    expect(again).toMatchObject({ status: "completed", sentCount: 0, alreadySentCount: 2 });
    expect(table.rows).toEqual(rows);
    expect(sent).toEqual(["p1@example.com", "p2@example.com"]);
    expect(statements.filter((sql) => /"objects"/.test(sql))).toEqual([]);
  });

  it("W3 through the shipped sender and facade: each mailed message writes its sent-email record and no body object", async () => {
    const [{ registerCapabilityProvider }, { resolveEmailSendProviders, resolveHostEmailRouting }, facade, { createDefaultSendEmail }] =
      await Promise.all([
        import("@/lib/extension-capabilities-registry"),
        import("@/lib/email-send-providers"),
        import("@cinatra-ai/email-connector"),
        import("../../approved-body-send"),
      ]);
    // The host's boot registers its email routing (the sent-email writer included).
    await import("@/lib/register-email-providers");
    const routing = resolveHostEmailRouting()!;
    expect(routing.saveSentEmailObject).toBeTypeOf("function");
    // The email connector's facade, wired as its own `register(ctx)` wires it.
    facade.configureEmailSystem({
      resolveConnectorId: (opts) => routing.resolveConnectorId(opts),
      applyDevModeOverride: (msg) => routing.applyDevModeOverride(msg),
      resolveConnectorProviders: () => resolveEmailSendProviders(),
      saveSentEmailObject: (input) => routing.saveSentEmailObject!(input),
    });
    registerCapabilityProvider("email-system", {
      packageName: "@cinatra-ai/email-connector",
      impl: { sendEmail: (m: never, o: never) => facade.sendEmailThroughSystem(m, o) },
    });
    // The mail transport: a connected mailbox that accepts every message.
    const transported: string[] = [];
    registerCapabilityProvider("email-send", {
      packageName: "@cinatra-ai/test-mailbox",
      impl: {
        definition: { connectorId: "mailbox-a", name: "Mailbox A", slug: "mailbox-a", description: "", settingsHref: "/" },
        getStatus: async () => ({ status: "connected" }),
        findReply: async () => null,
        send: async (m: { to: string[] }) => {
          transported.push(m.to[0]!);
          return { providerId: "mailbox-a", providerMessageId: `pm-${transported.length}`, sentAt: "2026-11-26T00:00:00Z" };
        },
      },
    });

    const stubbed: string[] = [];
    const result = await send(stubbed, { sendApprovedEmail: createDefaultSendEmail() });
    expect(result.errorMessage).toBeUndefined();
    expect(result).toMatchObject({ status: "completed", sentCount: 2 });
    // The stub sender is not used: the shipped sender handed each message to the facade.
    expect(stubbed).toEqual([]);
    expect(transported).toEqual(["p1@example.com", "p2@example.com"]);
    // The facade writes the sent-email record after the send returned (best effort, not awaited).
    await vi.waitFor(() => expect(sessionSaves).toHaveLength(2));
    // A send writes its sent-email record, one per mailed message, and nothing else.
    expect(sessionSaves.map((s) => s.typeHint)).toEqual(["@cinatra-ai/email:sent-email", "@cinatra-ai/email:sent-email"]);
    expect(sessionSaves.map((s) => [s.rawData?.toEmail, s.rawData?.campaignId, s.rawData?.contactId, s.rawData?.runId])).toEqual([
      ["p1@example.com", CAMPAIGN_ID, "c1", "run-1"],
      ["p2@example.com", CAMPAIGN_ID, "c2", "run-1"],
    ]);
    // No body object: no save of the body type, no objects client write, no statement on an objects row.
    expect(sessionSaves.filter((s) => s.typeHint === "@cinatra-ai/email:body")).toEqual([]);
    expect(objectsClientCalls).toEqual([]);
    expect(statements.filter((sql) => /"objects"|\bobjects\b\s*(SET|WHERE|\()/i.test(sql))).toEqual([]);
  });
});

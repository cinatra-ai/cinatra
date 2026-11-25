/**
 * cinatra#3089 — the durable send record of one message the approved send
 * mails, on the materialization ledger, as SQL.
 *
 * The pooled db is mocked as the ledger's other tests mock it; the functions
 * under test run unchanged.
 *
 * Cases:
 *   S1 the claim inserts the send row FROM the message's binding row (same org,
 *      run, message, artifact and revision), conditionally on the ledger key,
 *      and the caller whose insert returns a row wins
 *   S2 a claim that inserts nothing reads the send row: finalized is "sent",
 *      claimed is "in_doubt"
 *   S3 a claim of a message with no binding row throws
 *   S4 marking sent moves only a claimed send row of the organization, and
 *      giving back deletes only a claimed one
 *   S5 the send identity of a message
 *   S6 the send row's extension is a fixed value, never the binding row's pack
 *   S7 a message sent while one pack won the body type, then bound again under
 *      another winning pack to a newer approved revision: the retry mails
 *      nobody again (driven through the send with the shipped ledger)
 *   S8 a sent mark whose first write commits and then loses its reply: the
 *      retry of the mark reads the row as finalized, the message is not in
 *      doubt and the answer is completed (through the send, shipped ledger)
 *   S9 a sent mark that moves nothing reads the claim's row: finalized is
 *      success, a missing row or a claimed one is not
 *   F1 the drafting step's filed bodies of a run are its finalized mid-run
 *      rows of the body type; the send's own `email_fanout` rows never count
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { poolQueryMock } = vi.hoisted(() => ({ poolQueryMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => ({ query: poolQueryMock }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: vi.fn(),
}));

import { createHash } from "node:crypto";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { createTriggerEmailSendHandlers } from "@cinatra-ai/trigger-email-send";
import * as ledgerModule from "../materialization-ledger";
import {
  claimFanoutMessageSend,
  FANOUT_MESSAGE_SEND_MARKER,
  fanoutMessageSendOutputId,
  markFanoutMessageSent,
  releaseFanoutMessageSend,
} from "../materialization-ledger";
import {
  createTriggerEmailSendUseCases,
  type EmailFanoutArgs,
  type TriggerEmailSendDeps,
} from "../../trigger-email-send-use-cases";

const MESSAGE = {
  orgId: "org-a",
  runId: "run-1",
  outputId: "email-body:run-1:idx-0",
  artifactId: "art-1",
  representationRevisionId: "rev-1",
};

beforeEach(() => {
  poolQueryMock.mockReset();
});

describe("cinatra#3089 — one message's send record", () => {
  it("S1 the claim inserts the send row from the binding row, conditionally on the ledger key", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ id: "send-row-1" }] });
    // red-first-expect: claimFanoutMessageSend is not a function
    const claim = await claimFanoutMessageSend(MESSAGE);
    expect(claim).toEqual({ kind: "won", ledgerId: "send-row-1" });
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WITH bound AS \(\s*SELECT org_id, run_id, artifact_id, representation_revision_id/);
    expect(sql).toMatch(
      /WHERE org_id = \$2 AND run_id = \$3 AND output_id = \$4\s+AND path = 'email_fanout' AND phase = 'finalized'\s+AND artifact_id = \$5 AND representation_revision_id = \$6/,
    );
    expect(sql).toMatch(/SELECT \$1, org_id, run_id, \$7, NULL, 'email_fanout', \$9, \$8,\s+artifact_id, representation_revision_id, 'claimed'\s+FROM bound/);
    expect(sql).toMatch(/ON CONFLICT \(run_id, output_id, extension, content_hash\) DO NOTHING\s+RETURNING id/);
    expect(params.slice(1)).toEqual([
      "org-a",
      "run-1",
      "email-body:run-1:idx-0",
      "art-1",
      "rev-1",
      "email-send:run-1:idx-0",
      FANOUT_MESSAGE_SEND_MARKER,
      "message-send",
    ]);
  });

  it("S2 a claim that inserts nothing reads the send row: finalized is sent, claimed is in doubt", async () => {
    for (const [phase, kind] of [
      ["finalized", "sent"],
      ["claimed", "in_doubt"],
    ] as const) {
      poolQueryMock.mockReset();
      poolQueryMock
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ id: "send-row-1", phase, artifact_id: "art-1", representation_revision_id: "rev-1" }],
        });
      // red-first-expect: claimFanoutMessageSend is not a function
      const claim = await claimFanoutMessageSend(MESSAGE);
      expect(claim).toEqual({ kind, artifactId: "art-1", representationRevisionId: "rev-1" });
      const [sql, params] = poolQueryMock.mock.calls[1] as [string, unknown[]];
      expect(sql).toMatch(/WHERE org_id = \$1 AND run_id = \$2 AND output_id = \$3\s+AND path = 'email_fanout' AND content_hash = \$4/);
      expect(params).toEqual(["org-a", "run-1", "email-send:run-1:idx-0", FANOUT_MESSAGE_SEND_MARKER]);
    }
  });

  it("S3 a claim of a message with no binding row throws", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    // red-first-expect: claimFanoutMessageSend is not a function
    await expect(claimFanoutMessageSend(MESSAGE)).rejects.toThrow(
      "message email-body:run-1:idx-0 of run run-1 has no binding to revision rev-1 of artifact art-1",
    );
  });

  it("S4 marking sent moves only a claimed send row, and giving back deletes only a claimed one", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ id: "send-row-1" }] });
    // red-first-expect: markFanoutMessageSent is not a function
    expect(await markFanoutMessageSent({ orgId: "org-a", ledgerId: "send-row-1" })).toBe(true);
    const [markSql, markParams] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(markSql).toMatch(/SET phase = 'finalized'\s+WHERE id = \$1 AND org_id = \$2 AND path = 'email_fanout' AND phase = 'claimed'\s+RETURNING id/);
    expect(markParams).toEqual(["send-row-1", "org-a"]);

    // Nothing moved and the claim's row is gone: not marked.
    poolQueryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    expect(await markFanoutMessageSent({ orgId: "org-a", ledgerId: "send-row-1" })).toBe(false);

    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    await releaseFanoutMessageSend({ orgId: "org-a", ledgerId: "send-row-1" });
    const [relSql, relParams] = poolQueryMock.mock.calls[3] as [string, unknown[]];
    expect(relSql).toMatch(/DELETE FROM "public"\."artifact_materializations"\s+WHERE id = \$1 AND org_id = \$2 AND path = 'email_fanout' AND phase = 'claimed'/);
    expect(relParams).toEqual(["send-row-1", "org-a"]);
  });

  it("S5 the send identity of a message", () => {
    // red-first-expect: fanoutMessageSendOutputId is not a function
    expect(fanoutMessageSendOutputId("email-body:run-1:d-7")).toBe("email-send:run-1:d-7");
  });
});

// ---------------------------------------------------------------------------
// A small table standing in for `artifact_materializations`: it runs the
// ledger's own statements for the send rows by their shape, with the unique
// key (run_id, output_id, extension, content_hash) the table enforces. The
// claim's inserted extension is read off the statement itself (the binding
// row's column, or a parameter), so the statement under test decides it.
// ---------------------------------------------------------------------------
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
  phase: "claimed" | "finalized";
};

function ledgerTable() {
  const rows: Row[] = [];
  const hooks: { onMark?: (row: Row) => void } = {};
  const query = async (sql: string, params: unknown[]) => {
    const p = (n: number) => params[n - 1] as string;
    if (/WITH bound AS/.test(sql)) {
      const bound = rows.find(
        (r) =>
          r.org_id === p(2) && r.run_id === p(3) && r.output_id === p(4) && r.path === "email_fanout" &&
          r.phase === "finalized" && r.artifact_id === p(5) && r.representation_revision_id === p(6),
      );
      if (!bound) return { rows: [] };
      const select = /SELECT \$1, org_id, run_id, \$7, NULL, 'email_fanout', ([^,]+), \$8,/.exec(sql);
      if (!select) throw new Error("the claim statement has an unknown shape");
      const column = select[1]!.trim();
      const extension = column === "extension" ? bound.extension : p(Number(column.slice(1)));
      const key = [bound.run_id, p(7), extension, p(8)].join("|");
      if (rows.some((r) => [r.run_id, r.output_id, r.extension, r.content_hash].join("|") === key)) {
        return { rows: [] };
      }
      rows.push({ ...bound, id: p(1), output_id: p(7), extension, content_hash: p(8), phase: "claimed" });
      return { rows: [{ id: p(1) }] };
    }
    if (/SELECT id, phase, artifact_id, representation_revision_id/.test(sql)) {
      const row = rows.find(
        (r) => r.org_id === p(1) && r.run_id === p(2) && r.output_id === p(3) && r.path === "email_fanout" && r.content_hash === p(4),
      );
      return { rows: row ? [row] : [] };
    }
    if (/SET phase = 'finalized'/.test(sql)) {
      const row = rows.find((r) => r.id === p(1) && r.org_id === p(2) && r.path === "email_fanout" && r.phase === "claimed");
      if (!row) return { rows: [] };
      row.phase = "finalized";
      hooks.onMark?.(row);
      return { rows: [{ id: row.id }] };
    }
    if (/SELECT phase FROM/.test(sql)) {
      const row = rows.find((r) => r.id === p(1) && r.org_id === p(2) && r.path === "email_fanout");
      return { rows: row ? [{ phase: row.phase }] : [] };
    }
    if (/DELETE FROM/.test(sql)) {
      const i = rows.findIndex((r) => r.id === p(1) && r.org_id === p(2) && r.phase === "claimed");
      if (i >= 0) rows.splice(i, 1);
      return { rows: [] };
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  return { rows, hooks, query };
}

const sendActor: PrimitiveActorContext = {
  actorType: "human",
  source: "route",
  userId: "user-1",
  sessionId: "sess-1",
  orgId: "org-a",
};
/** The publish decision a person released for exactly the list a case names
 *  (cinatra#3089): the card's Recipients list row and its Emails row, drawn
 *  from the frozen values. These cases are about what the send does with an
 *  approved list, so the card shows the list the case names. */
function releasedCardFor(named: unknown) {
  const list = (typeof named === "string" ? JSON.parse(named) : named) as Array<{ recipientEmail: string; subject: string }>;
  return {
    surfacedValues: {
      recipients: list.map((e) => ({ email: e.recipientEmail, subject: e.subject })),
      emailBodies: named,
    },
    declaredRows: [
      { kind: "list", input: "recipients", columns: [{ field: "email" }, { field: "subject" }] },
      { kind: "artifacts", input: "emailBodies" },
    ],
  };
}

const BUNDLE = "11111111-1111-4111-8111-111111111111";
const LIST = "22222222-2222-4222-8222-222222222222";

/** One send of one message (draft 1 of run-1) through the send start, with the
 *  shipped send records over the table. The fan-out binds the message as the
 *  binder does: a finalized row of the message identity under the pack that
 *  wins the body type NOW and the hash of the text. */
function sendOnce(
  table: ReturnType<typeof ledgerTable>,
  opts: { winningPack: string; revision: string; text: string; sent: string[] },
) {
  const emitEmailFanout = async (args: EmailFanoutArgs) => {
    const body = args.approvedBodies!.get(0)!;
    // One message is one approved body artifact of the run (cinatra#3089).
    const outputId = "email-body:run-1:art-1";
    const contentHash = createHash("sha256").update(body.text, "utf8").digest("hex");
    const key = ["run-1", outputId, opts.winningPack, contentHash].join("|");
    if (!table.rows.some((r) => [r.run_id, r.output_id, r.extension, r.content_hash].join("|") === key)) {
      table.rows.push({
        id: `bind-${table.rows.length + 1}`,
        org_id: "org-a",
        run_id: "run-1",
        output_id: outputId,
        path: "email_fanout",
        extension: opts.winningPack,
        content_hash: contentHash,
        artifact_id: body.artifactId,
        representation_revision_id: body.representationRevisionId,
        phase: "finalized",
      });
    }
    return {
      bodies: [{ typeId: "@cinatra-ai/email:body", externalId: outputId, objectId: body.artifactId, isNew: false }],
      skipped: { bodies: false },
    };
  };
  const deps = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail: async (m: { to: string[] }) => {
      opts.sent.push(m.to[0]!);
      return { providerId: "p", providerMessageId: `m-${opts.sent.length}`, sentAt: "2026-11-25T00:00:00Z" };
    },
    getObjectByRef: async (ref: string) =>
      ref === BUNDLE
        ? {
            id: BUNDLE,
            type: "@cinatra-ai/campaigns:email-draft-bundle",
            data: {
              cinatraAgentRunId: "run-1",
              drafts: [{ recipientId: "c1", recipientEmail: "one@example.com", subject: "Hello", body: "Body one\n" }],
            },
          }
        : { id: LIST, type: "@cinatra-ai/campaigns:recipients", data: { confirmedRecipients: [{ contactId: "c1", email: "one@example.com" }] } },
    emitEmailFanout,
    readDecidedBody: async () => ({ ok: true as const, text: opts.text, data: {} }),
    readRunReviewedBodies: async () => true,
    readCallingRun: async () => ({ runId: "run-1", stepId: "send" }),
    readReleasedPublishDecision: async () => releasedCardFor(approvedBodies),
  } as unknown as TriggerEmailSendDeps;
  const approvedBodies = [
    { artifactId: "art-1", representationRevisionId: opts.revision, contactId: "c1", recipientEmail: "one@example.com", subject: "Hello" },
  ];
  const handlers = createTriggerEmailSendHandlers(createTriggerEmailSendUseCases(deps));
  return handlers["email_outreach_send_initial_start"]({
    input: {
      campaignId: "33333333-3333-4333-8333-333333333333",
      approvedDraftBundleRef: BUNDLE,
      confirmedRecipientsRef: LIST,
      approvedBodies,
    },
    actor: sendActor,
  } as never) as unknown as Promise<{ status: string; sentCount: number; alreadySentCount?: number; inDoubtCount?: number; errorMessage?: string }>;
}

describe("cinatra#3089 — one send row per message, whatever pack wins; a lost reply of a committed mark", () => {
  it("S6 the send row's extension is a fixed value, never the binding row's pack", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ id: "send-row-1" }] });
    // red-first-expect: claimFanoutMessageSend is not a function
    await claimFanoutMessageSend(MESSAGE);
    const [sql, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/'email_fanout', extension,/);
    expect(params[8]).toBe("message-send");
  });

  it("S7 a message sent under one winning pack is not mailed again after another pack wins and a newer revision is approved", async () => {
    const table = ledgerTable();
    poolQueryMock.mockImplementation(table.query);
    const sent: string[] = [];
    const first = await sendOnce(table, { winningPack: "pack-a", revision: "rev-1", text: "Body one", sent });
    expect(first).toMatchObject({ status: "completed", sentCount: 1 });
    // Another pack now wins the body type; the body was filed again (same
    // words, a trailing newline more) and approved; the send is retried.
    const retry = await sendOnce(table, { winningPack: "pack-b", revision: "rev-2", text: "Body one\n", sent });
    // red-first-expect: to deeply equal [ 'one@example.com' ]
    expect(sent).toEqual(["one@example.com"]);
    expect(retry).toMatchObject({ status: "completed", sentCount: 0, alreadySentCount: 1, inDoubtCount: 0 });
    expect(table.rows.filter((r) => r.output_id.startsWith("email-send:"))).toHaveLength(1);
  });

  it("S8 a sent mark whose first write commits and then loses its reply is read back as sent: completed, nothing in doubt", async () => {
    const table = ledgerTable();
    poolQueryMock.mockImplementation(table.query);
    let lost = false;
    table.hooks.onMark = () => {
      if (lost) return;
      lost = true;
      throw new Error("Connection terminated unexpectedly");
    };
    const sent: string[] = [];
    const result = await sendOnce(table, { winningPack: "pack-a", revision: "rev-1", text: "Body one", sent });
    expect(sent).toEqual(["one@example.com"]);
    // red-first-expect: to match object { status: 'completed', …(2) }
    expect(result).toMatchObject({ status: "completed", sentCount: 1, inDoubtCount: 0 });
    expect(result.errorMessage).toBeUndefined();
    expect(table.rows.find((r) => r.output_id.startsWith("email-send:"))?.phase).toBe("finalized");
  });

  it("S9 a sent mark that moves nothing reads the claim's row: finalized is success, claimed or missing is not", async () => {
    for (const [found, answer] of [
      [[{ phase: "finalized" }], true],
      [[{ phase: "claimed" }], false],
      [[], false],
    ] as const) {
      poolQueryMock.mockReset();
      poolQueryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: found });
      // red-first-expect: markFanoutMessageSent is not a function
      expect(await markFanoutMessageSent({ orgId: "org-a", ledgerId: "send-row-1" })).toBe(answer);
      const [sql, params] = poolQueryMock.mock.calls[1] as [string, unknown[]];
      expect(sql).toMatch(/SELECT phase FROM "public"\."artifact_materializations"\s+WHERE id = \$1 AND org_id = \$2 AND path = 'email_fanout'/);
      expect(params).toEqual(["send-row-1", "org-a"]);
    }
  });

  it("F1 the filed bodies of a run are its finalized mid-run rows of the body type, never the send's own rows", async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ filed: true }] });
    // red-first-expect: runHasFiledReviewBodies is not a function
    expect(await ledgerModule.runHasFiledReviewBodies({ runId: "run-1", objectTypeId: "@cinatra-ai/email:body" })).toBe(true);
    const [sql, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/JOIN "public"\."objects" o ON o\.id = m\.artifact_id/);
    expect(sql).toMatch(/WHERE m\.run_id = \$1 AND m\.path IN \('materialize_tool', 'end_node_binding'\)\s+AND m\.phase = 'finalized' AND o\.type = \$2/);
    expect(sql).not.toMatch(/email_fanout/);
    expect(params).toEqual(["run-1", "@cinatra-ai/email:body"]);
    poolQueryMock.mockResolvedValueOnce({ rows: [{ filed: false }] });
    expect(await ledgerModule.runHasFiledReviewBodies({ runId: "run-1", objectTypeId: "@cinatra-ai/email:body" })).toBe(false);
  });
});

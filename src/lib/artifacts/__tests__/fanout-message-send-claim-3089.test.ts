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

import {
  claimFanoutMessageSend,
  FANOUT_MESSAGE_SEND_MARKER,
  fanoutMessageSendOutputId,
  markFanoutMessageSent,
  releaseFanoutMessageSend,
} from "../materialization-ledger";

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
    expect(sql).toMatch(/WITH bound AS \(\s*SELECT org_id, run_id, extension, artifact_id, representation_revision_id/);
    expect(sql).toMatch(
      /WHERE org_id = \$2 AND run_id = \$3 AND output_id = \$4\s+AND path = 'email_fanout' AND phase = 'finalized'\s+AND artifact_id = \$5 AND representation_revision_id = \$6/,
    );
    expect(sql).toMatch(/SELECT \$1, org_id, run_id, \$7, NULL, 'email_fanout', extension, \$8,\s+artifact_id, representation_revision_id, 'claimed'\s+FROM bound/);
    expect(sql).toMatch(/ON CONFLICT \(run_id, output_id, extension, content_hash\) DO NOTHING\s+RETURNING id/);
    expect(params.slice(1)).toEqual([
      "org-a",
      "run-1",
      "email-body:run-1:idx-0",
      "art-1",
      "rev-1",
      "email-send:run-1:idx-0",
      FANOUT_MESSAGE_SEND_MARKER,
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

    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    expect(await markFanoutMessageSent({ orgId: "org-a", ledgerId: "send-row-1" })).toBe(false);

    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    await releaseFanoutMessageSend({ orgId: "org-a", ledgerId: "send-row-1" });
    const [relSql, relParams] = poolQueryMock.mock.calls[2] as [string, unknown[]];
    expect(relSql).toMatch(/DELETE FROM "public"\."artifact_materializations"\s+WHERE id = \$1 AND org_id = \$2 AND path = 'email_fanout' AND phase = 'claimed'/);
    expect(relParams).toEqual(["send-row-1", "org-a"]);
  });

  it("S5 the send identity of a message", () => {
    // red-first-expect: fanoutMessageSendOutputId is not a function
    expect(fanoutMessageSendOutputId("email-body:run-1:d-7")).toBe("email-send:run-1:d-7");
  });
});

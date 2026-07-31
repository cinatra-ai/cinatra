/**
 * cinatra#2266 AC1, END TO END: an execution-plane refusal reaches the authz
 * kernel as its OWN row, not as a repeat of the last one.
 *
 * This is deliberately not a test of the mapper (the package suite pins that)
 * nor of the cooldown gate (the kernel suite pins that). It is a test of the
 * WIRING between them, through the real `logAuditEvent` and the real cooldown,
 * with only Postgres replaced — because the defect this closes lived in
 * neither half alone. Both producers pin `resourceType` / `operation` to
 * constants, so every refusal a user received in a 60 s window collapsed onto
 * one key and only the first was ever written.
 *
 * The assertions are on the ROWS the kernel tried to insert, and specifically
 * on the two columns the acceptance criterion names — `resource_id` (the job)
 * and the reason in `metadata` — so a change that produced two rows that were
 * not actually distinguishable would fail here.
 *
 * The two producers opt in DIFFERENTLY, and that asymmetry is pinned below: the
 * command sink declares `record_every` because a voucher it refuses was
 * rejected before its command id could be trusted, while a mint event carries a
 * required `commandId` and so keeps a finer key that still absorbs a true
 * retry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("pg", async () => {
  const actual = await vi.importActual<typeof import("pg")>("pg");
  class MockPool {
    on() { return this; }
    listenerCount() { return 1; }
    query(...args: unknown[]) { return queryMock(...args); }
    connect() { return Promise.resolve({ release: () => {}, query: queryMock }); }
    end() { return Promise.resolve(); }
  }
  return { ...actual, Pool: MockPool };
});
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: vi.fn(async () => null),
  readAgentTemplateById: vi.fn(async () => null),
}));

import { _resetDeniedCooldownForTests } from "@/lib/authz/audit";
import {
  createExecutionAuditSink,
  createVoucherMintAuditSink,
} from "@/lib/execution/execution-broker-construct";
import type { VoucherMintAuditEvent } from "@/lib/execution/execution-voucher-mint";
import {
  DEFAULT_SANDBOX_LIMITS,
  type ExecutionAuditRecord,
} from "@cinatra-ai/execution-plane";

/**
 * The rows the kernel attempted, reconstructed by pairing the INSERT's own
 * column list with its VALUES list — so this reads the write the way Postgres
 * would, not by index into an argument array that a schema change could
 * silently reorder.
 *
 * The pairing walks the VALUES list rather than the parameter array, because a
 * column the statement leaves to the database appears there as a literal
 * `default` and consumes NO parameter (`created_at` always does;
 * `execution_delivery_key` does on every producer but the execution plane's own
 * durable path). Zipping columns to parameters positionally silently shifted
 * every column after the first `default` onto the wrong value — which is how an
 * additive column made assertions about `metadata` read `undefined`.
 */
type InsertedRow = Record<string, unknown> & { metadata: Record<string, unknown> };
function insertedRows(): InsertedRow[] {
  return queryMock.mock.calls.map(([query, params]) => {
    const text = (query as { text: string }).text;
    const columns = text
      .slice(text.indexOf("(") + 1, text.indexOf(")"))
      .split(",")
      .map((column) => column.trim().replaceAll('"', ""));
    const valuesClause = text.slice(text.indexOf("values (") + "values (".length);
    const slots = valuesClause
      .slice(0, valuesClause.indexOf(")"))
      .split(",")
      .map((slot) => slot.trim());
    const values = params as unknown[];
    const row: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      const slot = slots[index];
      if (slot === undefined || !slot.startsWith("$")) return; // `default`
      row[column] = values[Number(slot.slice(1)) - 1];
    });
    const metadata = row.metadata;
    row.metadata = typeof metadata === "string" ? JSON.parse(metadata) : {};
    return row as InsertedRow;
  });
}

const REFUSAL: ExecutionAuditRecord = {
  jobId: "job-1",
  orgId: "org-1",
  userId: "user-1",
  surface: "agent_run",
  runId: "run-1",
  command: "pip install pandas",
  cwd: "/workspace",
  seq: 0,
  decision: "refused",
  reason: "voucher_invalid",
  commandId: "cmd-1",
  effectivePolicy: { egressMode: "allowlist", limits: DEFAULT_SANDBOX_LIMITS },
  atMs: 1_700_000_000_000,
};

const MINT_DENIAL: VoucherMintAuditEvent = {
  decision: "denied",
  denial: "obo_ceiling_mismatch",
  detail: "the persisted chain does not contain the re-derived chain",
  orgId: "org-1",
  userId: "user-1",
  surface: "agent_run",
  runId: "run-1",
  jobId: "job-1",
  commandId: "cmd-1",
};

describe("execution refusals are not collapsed by the denied cooldown", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    _resetDeniedCooldownForTests();
  });

  describe("the command sink (execution_sandbox / sandbox_execute)", () => {
    it("records two SAME-reason pre-dispatch refusals on two different jobs", async () => {
      const sink = createExecutionAuditSink();
      await sink({ ...REFUSAL, jobId: "job-a", commandId: "cmd-a" });
      await sink({ ...REFUSAL, jobId: "job-b", commandId: "cmd-b" });

      const rows = insertedRows();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.resource_id)).toEqual(["job-a", "job-b"]);
      expect(rows.every((row) => row.decision === "denied")).toBe(true);
    });

    it("records two refusals with different reasons inside one window", async () => {
      const sink = createExecutionAuditSink();
      await sink({ ...REFUSAL, reason: "voucher_replayed" });
      await sink({ ...REFUSAL, reason: "run_removed" });

      const rows = insertedRows();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.metadata.reason)).toEqual([
        "voucher_replayed",
        "run_removed",
      ]);
    });

    it("records ten FORGED vouchers on one job as ten rows", async () => {
      // The issue's headline case. Every one of these is refused before its
      // claims are trusted, so none of them carries a commandId — under the
      // old key (and under a discriminator without the record's timestamp)
      // they were one row.
      const sink = createExecutionAuditSink();
      for (let i = 0; i < 10; i += 1) {
        await sink({
          ...REFUSAL,
          commandId: undefined,
          reason: "voucher_invalid",
          voucherRejection: "signature_invalid",
          atMs: 1_700_000_000_000 + i,
        });
      }
      expect(insertedRows()).toHaveLength(10);
    });

    it("suppresses NOTHING on this side, which is the declared posture", async () => {
      // Not an oversight: this producer cannot build a key that separates the
      // refusals that matter (a rejected voucher's command id is never
      // trusted), so it declares `record_every` rather than approximate one.
      // The broker hands each audit event to the sink exactly once, so there is
      // no repeat here to absorb — an identical record arriving twice would be
      // a delivery duplicate, which is the spool's job (#2266 G2/AC2) and not
      // something a noise control should be papering over.
      const sink = createExecutionAuditSink();
      await sink(REFUSAL);
      await sink(REFUSAL);
      expect(insertedRows()).toHaveLength(2);
    });

    it("never suppresses an EXECUTED record", async () => {
      const sink = createExecutionAuditSink();
      const executed: ExecutionAuditRecord = {
        ...REFUSAL,
        decision: "executed",
        reason: undefined,
        exitCode: 0,
        termination: "exited",
      };
      await sink(executed);
      await sink(executed);
      expect(insertedRows()).toHaveLength(2);
    });
  });

  describe("the mint sink (execution_command_voucher / sandbox_authorize)", () => {
    it("records two SAME-denial mint refusals on two different jobs", async () => {
      const sink = createVoucherMintAuditSink();
      await sink({ ...MINT_DENIAL, jobId: "job-a", commandId: "cmd-a" });
      await sink({ ...MINT_DENIAL, jobId: "job-b", commandId: "cmd-b" });

      const rows = insertedRows();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.resource_id)).toEqual(["job-a", "job-b"]);
      expect(rows.every((row) => row.resource_type === "execution_command_voucher")).toBe(
        true,
      );
    });

    it("records two mint refusals with different denials inside one window", async () => {
      const sink = createVoucherMintAuditSink();
      await sink({ ...MINT_DENIAL, denial: "run_removed" });
      await sink({ ...MINT_DENIAL, denial: "carrier_rejected" });

      const rows = insertedRows();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.metadata.denial)).toEqual([
        "run_removed",
        "carrier_rejected",
      ]);
    });

    it("records two denials of two commands on ONE job", async () => {
      const sink = createVoucherMintAuditSink();
      await sink({ ...MINT_DENIAL, commandId: "cmd-1" });
      await sink({ ...MINT_DENIAL, commandId: "cmd-2" });

      const rows = insertedRows();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.metadata.commandId)).toEqual(["cmd-1", "cmd-2"]);
    });

    it("still absorbs an exact repeat of the same command's denial", async () => {
      const sink = createVoucherMintAuditSink();
      await sink(MINT_DENIAL);
      await sink(MINT_DENIAL);
      expect(insertedRows()).toHaveLength(1);
    });
  });
});

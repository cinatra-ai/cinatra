import { describe, it, expect, beforeEach } from "vitest";
import { IdempotencyLedger, type WebhookLedgerQuery } from "../idempotency";

// In-memory emulator of the `webhook_idempotency` semantics the ledger relies
// on. It models ONLY the two statements the ledger issues (the claim UPSERT and
// the attempt-fenced finalize UPDATE) plus the read-back SELECT, with a
// controllable clock so lease expiry is deterministic. This proves the state
// machine + fencing logic without a live Postgres.
interface Row {
  scope: string;
  site_id: string;
  message_id: string;
  status: "processing" | "done" | "failed";
  lease_until: number | null; // epoch ms
  attempt_count: number;
}

function makeFakeQuery(clock: { now: number }, leaseSeconds: number): WebhookLedgerQuery {
  const rows = new Map<string, Row>();
  const keyOf = (scope: string, site: string, msg: string) => `${scope}|${site}|${msg}`;

  return async (text, params) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("INSERT INTO")) {
      const [scope, site, msg] = params as [string, string, string];
      const k = keyOf(scope, site, msg);
      const existing = rows.get(k);
      const leaseUntil = clock.now + leaseSeconds * 1000;
      if (!existing) {
        rows.set(k, {
          scope,
          site_id: site,
          message_id: msg,
          status: "processing",
          lease_until: leaseUntil,
          attempt_count: 1,
        });
        return { rows: [{ attempt_count: 1 }] };
      }
      // ON CONFLICT WHERE status='failed' OR (processing AND lease_until<now())
      const reclaimable =
        existing.status === "failed" ||
        (existing.status === "processing" && (existing.lease_until ?? 0) < clock.now);
      if (reclaimable) {
        existing.status = "processing";
        existing.lease_until = leaseUntil;
        existing.attempt_count += 1;
        return { rows: [{ attempt_count: existing.attempt_count }] };
      }
      // done OR live-lease processing → UPDATE affects 0 rows.
      return { rows: [] };
    }
    if (sql.startsWith("SELECT status")) {
      const [scope, site, msg] = params as [string, string, string];
      const r = rows.get(keyOf(scope, site, msg));
      return { rows: r ? [{ status: r.status, lease_until: r.lease_until }] : [] };
    }
    if (sql.startsWith("UPDATE")) {
      const [scope, site, msg, attempt, status] = params as [
        string,
        string,
        string,
        number,
        "done" | "failed",
      ];
      const r = rows.get(keyOf(scope, site, msg));
      if (r && r.attempt_count === attempt) {
        r.status = status;
        r.lease_until = null;
        return { rows: [{ id: 1 }] };
      }
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
}

describe("IdempotencyLedger leased state machine", () => {
  const LEASE = 30;
  let clock: { now: number };
  let ledger: IdempotencyLedger;

  beforeEach(() => {
    clock = { now: 1_000_000 };
    ledger = new IdempotencyLedger({
      query: makeFakeQuery(clock, LEASE),
      table: '"cinatra"."webhook_idempotency"',
      leaseSeconds: LEASE,
    });
  });

  it("claims a fresh message (attempt 1)", async () => {
    const d = await ledger.claim("v/s/h", "site", "m1");
    expect(d).toEqual({ kind: "claimed", attemptCount: 1 });
  });

  it("a live-lease second arrival is in-progress (409)", async () => {
    await ledger.claim("v/s/h", "site", "m2");
    const d = await ledger.claim("v/s/h", "site", "m2");
    expect(d.kind).toBe("in-progress");
  });

  it("a finalized (done) message replays as deduped", async () => {
    const c = await ledger.claim("v/s/h", "site", "m3");
    expect(c.kind).toBe("claimed");
    await ledger.finalize("v/s/h", "site", "m3", 1, "done");
    const replay = await ledger.claim("v/s/h", "site", "m3");
    expect(replay.kind).toBe("deduped");
  });

  it("a failed message is re-claimable (attempt bumps)", async () => {
    await ledger.claim("v/s/h", "site", "m4");
    await ledger.finalize("v/s/h", "site", "m4", 1, "failed");
    const retry = await ledger.claim("v/s/h", "site", "m4");
    expect(retry).toEqual({ kind: "claimed", attemptCount: 2 });
  });

  it("a crashed holder's stale lease is re-claimed after expiry", async () => {
    await ledger.claim("v/s/h", "site", "m5"); // attempt 1, never finalized
    // Advance past the lease.
    clock.now += (LEASE + 1) * 1000;
    const retry = await ledger.claim("v/s/h", "site", "m5");
    expect(retry).toEqual({ kind: "claimed", attemptCount: 2 });
  });

  it("attempt-fenced finalize: a stale holder cannot overwrite the newer attempt", async () => {
    const first = await ledger.claim("v/s/h", "site", "m6"); // attempt 1
    expect(first).toEqual({ kind: "claimed", attemptCount: 1 });
    clock.now += (LEASE + 1) * 1000;
    const second = await ledger.claim("v/s/h", "site", "m6"); // attempt 2 reclaims
    expect(second).toEqual({ kind: "claimed", attemptCount: 2 });

    // The crashed first holder wakes up and tries to finalize with attempt 1.
    const staleWon = await ledger.finalize("v/s/h", "site", "m6", 1, "done");
    expect(staleWon).toBe(false);

    // The live second holder finalizes with attempt 2 → wins.
    const liveWon = await ledger.finalize("v/s/h", "site", "m6", 2, "done");
    expect(liveWon).toBe(true);

    // And the row is now terminal-done (replay deduped).
    const replay = await ledger.claim("v/s/h", "site", "m6");
    expect(replay.kind).toBe("deduped");
  });
});

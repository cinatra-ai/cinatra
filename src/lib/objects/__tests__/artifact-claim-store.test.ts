import { beforeEach, describe, expect, it, vi } from "vitest";

// SQL-shape proof for the claim-registry DB primitives (cinatra#1425, epic
// #1424 foundation) — the same harness the skill-lifecycle store uses: the
// postgres runner is mocked and we assert the emitted SQL / params /
// transaction boundaries carry the safety properties:
//   - every winner transition is ONE transaction opened by the per-type
//     advisory lock, and each mutating statement is a self-contained CTE
//     chain (UPDATE → event INSERT → queue INSERT), so a CAS miss writes
//     nothing (AC-2 atomicity, at the statement level);
//   - the DEDICATED-claimant conflict surfaces as the typed
//     ArtifactClaimConflictError off the DB constraint (AC-1, service half —
//     the DDL half is pinned in migration-artifact-claim-registry-core0034);
//   - dormancy / reactivation SQL mirrors the policy leaf's domination rule,
//     and reactivation bumps the generation (AC-2).
const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import {
  ArtifactClaimConflictError,
  activateArtifactTypeClaim,
  buildActivateClaimQuery,
  buildActivateDormancyQuery,
  buildFinalizeRetirementQuery,
  buildReactivateDefaultsQuery,
  buildReserveClaimQueries,
  finalizeArtifactTypeClaimRetirement,
  reserveArtifactTypeClaim,
} from "@/lib/objects/artifact-claim-store";

// Braces matter: `() => mock.mockReset()` would RETURN the mock (chainable),
// and vitest calls a function returned from a hook as a CLEANUP callback —
// invoking whatever implementation the test installed (a throwing one here).
beforeEach(() => {
  runPostgresQueriesSync.mockReset();
});

const CLAIM_ROW = {
  id: "c1",
  scope: "org:org-1",
  object_type_id: "@vendor/pkg:thing",
  claim_kind: "dedicated",
  extension_package: "@vendor/pkg-artifact",
  extension_version: "1.0.0",
  install_id: "inst1",
  status: "reserved",
  generation: 1,
  dispositions: null,
  created_at: "2026-07-12",
  updated_at: "2026-07-12",
};

describe("reserveArtifactTypeClaim", () => {
  it("inserts the claim + its 'reserve' event in one transaction", () => {
    runPostgresQueriesSync.mockReturnValue([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const claimId = reserveArtifactTypeClaim({
      scope: "org:org-1",
      objectTypeId: "@vendor/pkg:thing",
      claimKind: "dedicated",
      extensionPackage: "@vendor/pkg-artifact",
      extensionVersion: "1.0.0",
      installId: "inst1",
      actor: "system",
    });
    expect(claimId).toBeTruthy();
    const call = runPostgresQueriesSync.mock.calls[0][0] as {
      transaction?: boolean;
      queries: Array<{ text: string; values?: unknown[] }>;
    };
    expect(call.transaction).toBe(true);
    expect(call.queries[0].text).toMatch(/INSERT INTO "cinatra"\."artifact_type_claims"/);
    expect(call.queries[0].text).toMatch(/'reserved'/);
    expect(call.queries[1].text).toMatch(/INSERT INTO "cinatra"\."artifact_claim_events"/);
    expect(call.queries[1].text).toMatch(/'reserve'/);
    expect(call.queries[1].values?.[0]).toBe(claimId);
  });

  it("AC-1: maps the dedicated-claimant unique violation to ArtifactClaimConflictError", () => {
    runPostgresQueriesSync.mockImplementation(() => {
      throw new Error(
        'duplicate key value violates unique constraint "artifact_type_claims_one_live_dedicated"',
      );
    });
    expect(() =>
      reserveArtifactTypeClaim({
        scope: "org:org-1",
        objectTypeId: "@vendor/pkg:thing",
        claimKind: "dedicated",
        extensionPackage: "@other/pkg-artifact",
        extensionVersion: "2.0.0",
        actor: "system",
      }),
    ).toThrow(ArtifactClaimConflictError);
  });

  it("maps the one-live-DEFAULT-claimant violation to the same typed conflict", () => {
    runPostgresQueriesSync.mockImplementation(() => {
      throw new Error(
        'duplicate key value violates unique constraint "artifact_type_claims_one_live_default"',
      );
    });
    expect(() =>
      reserveArtifactTypeClaim({
        scope: "platform",
        objectTypeId: "@vendor/pkg:thing",
        claimKind: "default",
        extensionPackage: "@cinatra-ai/default-artifact",
        extensionVersion: "1.0.0",
        actor: "system",
      }),
    ).toThrow(ArtifactClaimConflictError);
  });

  it("rejects an invalid scope and invalid dispositions BEFORE touching the DB (fail-closed)", () => {
    expect(() =>
      reserveArtifactTypeClaim({
        scope: "workspace",
        objectTypeId: "@vendor/pkg:thing",
        claimKind: "default",
        extensionPackage: "@vendor/pkg-artifact",
        extensionVersion: "1.0.0",
        actor: "system",
      }),
    ).toThrow(/invalid claim scope/);
    expect(() =>
      reserveArtifactTypeClaim({
        scope: "platform",
        objectTypeId: "@vendor/pkg:thing",
        claimKind: "default",
        extensionPackage: "@vendor/pkg-artifact",
        extensionVersion: "1.0.0",
        dispositions: { projection: "none", pinnable: true },
        actor: "system",
      }),
    ).toThrow(/invalid claim dispositions/);
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("rejects a tombstoned dynamic-namespace objectTypeId BEFORE touching the DB (cinatra#1789)", () => {
    for (const objectTypeId of ["@dynamic/types:invoice", "@cinatra-ai/dynamic:invoice"]) {
      expect(() =>
        reserveArtifactTypeClaim({
          scope: "platform",
          objectTypeId,
          claimKind: "default",
          extensionPackage: "@vendor/pkg-artifact",
          extensionVersion: "1.0.0",
          actor: "system",
        }),
      ).toThrow(/tombstoned/);
    }
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });
});

describe("activateArtifactTypeClaim — atomic winner transition (AC-2)", () => {
  it("runs lock → dormancy → activation CAS in ONE transaction, events + queue rows in the same statements", () => {
    runPostgresQueriesSync
      // the pre-read of the claim row
      .mockReturnValueOnce([{ rows: [CLAIM_ROW], rowCount: 1 }])
      // the transaction: [lock, dormancy, activate]
      .mockReturnValueOnce([
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 0 },
        { rows: [{ claim_event_id: "e1" }, { claim_event_id: "e1" }], rowCount: 2 },
      ]);
    const out = activateArtifactTypeClaim({ claimId: "c1", actor: "system" });
    expect(out).toEqual({ changed: true });

    const txn = runPostgresQueriesSync.mock.calls[1][0] as {
      transaction?: boolean;
      queries: Array<{ text: string; values?: unknown[] }>;
    };
    expect(txn.transaction).toBe(true);
    const [lock, dormancy, activate] = txn.queries;
    // 1) per-type advisory transaction lock serializes all transitions.
    expect(lock.text).toMatch(/pg_advisory_xact_lock\(hashtext\('cinatra-artifact-claim:' \|\| \$1::text\)\)/);
    expect(lock.values).toEqual(["@vendor/pkg:thing"]);
    // 2) dormancy: guarded on the CAS precondition (reserved + dedicated),
    //    scope rule mirrors the policy leaf (platform dominates every scope,
    //    org dominates its own), and writes winner-change events + BOTH queue
    //    kinds in the SAME statement.
    expect(dormancy.text).toMatch(/status = 'reserved' AND claim_kind = 'dedicated'/);
    expect(dormancy.text).toMatch(/c\.scope = 'platform' OR t\.scope = c\.scope/);
    expect(dormancy.text).toMatch(/SET status = 'dormant'/);
    expect(dormancy.text).toMatch(/'winner-change'/);
    expect(dormancy.text).toMatch(/'dedicated-activated'/);
    expect(dormancy.text).toMatch(/VALUES \('binding-reconcile'\), \('re-projection'\)/);
    // 3) activation CAS: reserved → active, except a dominated DEFAULT lands
    //    dormant directly (never a transient second active winner).
    expect(activate.text).toMatch(/WHERE t\.id = \$1 AND t\.status = 'reserved'/);
    expect(activate.text).toMatch(/THEN 'dormant'\s+ELSE 'active'/);
    expect(activate.text).toMatch(/d\.status IN \('active', 'retiring'\)/);
    expect(activate.text).toMatch(/'activate'/);
    expect(activate.text).toMatch(/landedStatus/);
    expect(activate.text).toMatch(/VALUES \('binding-reconcile'\), \('re-projection'\)/);
    // 4) both events ride ONE ordered INSERT (activate ord 1, winner-change
    //    ord 2) so the events table's identity `seq` reflects transition
    //    order — sibling CTEs carry no ordering guarantee.
    expect(activate.text).toMatch(/UNION ALL/);
    expect(activate.text).toMatch(/ORDER BY ord/);
    expect(activate.text.indexOf("'activate' AS event")).toBeLessThan(activate.text.indexOf("'winner-change'"));
    // 5) queue rows derive from the winner-change event only.
    expect(activate.text).toMatch(/WHERE e\.event = 'winner-change'/);
  });

  it("reports changed=false (fail-closed no-op) when the claim is not reserved", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [{ ...CLAIM_ROW, status: "active" }], rowCount: 1 }])
      .mockReturnValueOnce([
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 0 },
        { rows: [], rowCount: 0 },
      ]);
    expect(activateArtifactTypeClaim({ claimId: "c1", actor: "system" })).toEqual({ changed: false });
  });

  it("reports changed=false without writing when the claim does not exist", () => {
    runPostgresQueriesSync.mockReturnValueOnce([{ rows: [], rowCount: 0 }]);
    expect(activateArtifactTypeClaim({ claimId: "missing", actor: "system" })).toEqual({ changed: false });
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1); // only the read
  });
});

describe("finalizeArtifactTypeClaimRetirement — retire + reactivate (AC-2)", () => {
  it("retires under the same lock and reactivates no-longer-dominated defaults with a NEW generation", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [{ ...CLAIM_ROW, status: "active" }], rowCount: 1 }]) // pre-read
      .mockReturnValueOnce([
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 2 },
        { rows: [], rowCount: 2 },
      ]) // transaction
      .mockReturnValueOnce([{ rows: [{ ...CLAIM_ROW, status: "retired" }], rowCount: 1 }]); // post-read
    const out = finalizeArtifactTypeClaimRetirement({ claimId: "c1", actor: "system" });
    expect(out).toEqual({ changed: true });

    const txn = runPostgresQueriesSync.mock.calls[1][0] as {
      transaction?: boolean;
      queries: Array<{ text: string; values?: unknown[] }>;
    };
    expect(txn.transaction).toBe(true);
    const [lock, retire, reactivate] = txn.queries;
    expect(lock.text).toMatch(/pg_advisory_xact_lock/);
    // retire CAS + 'retire' event; winner-change + queue ONLY when the claim
    // was winner-eligible.
    expect(retire.text).toMatch(/SET status = 'retired'/);
    expect(retire.text).toMatch(/'retire'/);
    expect(retire.text).toMatch(/WHERE r\.prior_status IN \('active', 'retiring'\)/);
    expect(retire.text).toMatch(/VALUES \('binding-reconcile'\), \('re-projection'\)/);
    // ordered single INSERT: retire (ord 1) before winner-change (ord 2).
    expect(retire.text).toMatch(/UNION ALL/);
    expect(retire.text).toMatch(/ORDER BY ord/);
    expect(retire.text.indexOf("'retire' AS event")).toBeLessThan(retire.text.indexOf("'winner-change'"));
    // reactivation: dormant defaults, generation bump, NOT EXISTS mirrors the
    // domination rule, events + queue in the same statement.
    expect(reactivate.text).toMatch(/SET status = 'active', generation = t\.generation \+ 1/);
    expect(reactivate.text).toMatch(/t\.status = 'dormant'/);
    expect(reactivate.text).toMatch(/NOT EXISTS/);
    expect(reactivate.text).toMatch(/d\.scope = t\.scope OR d\.scope = 'platform'/);
    expect(reactivate.text).toMatch(/'dedicated-retired'/);
    expect(reactivate.text).toMatch(/'dormant->active'/);
    expect(reactivate.text).toMatch(/VALUES \('binding-reconcile'\), \('re-projection'\)/);
  });
});

describe("query builders (shape invariants)", () => {
  it("every winner-change statement writes its queue rows FROM its event CTE (atomicity by construction)", () => {
    for (const q of [
      buildActivateDormancyQuery("cinatra", "c1", "system"),
      buildActivateClaimQuery("cinatra", "c1", "system"),
      buildFinalizeRetirementQuery("cinatra", "c1", "system"),
      buildReactivateDefaultsQuery("cinatra", "c1", "system"),
    ]) {
      expect(q.text).toMatch(/INSERT INTO "cinatra"\."artifact_binding_reconcile_queue"/);
      expect(q.text).toMatch(/FROM ev(_winner)? e CROSS JOIN/);
    }
  });

  it("reserve emits a PLAIN INSERT (no ON CONFLICT) so conflicts ABORT, never silently no-op", () => {
    const [insert] = buildReserveClaimQueries("cinatra", {
      claimId: "c1",
      scope: "platform",
      objectTypeId: "@vendor/pkg:thing",
      claimKind: "dedicated",
      extensionPackage: "@vendor/pkg-artifact",
      extensionVersion: "1.0.0",
      dispositionsJson: null,
      actor: "system",
    });
    expect(insert.text).not.toMatch(/ON CONFLICT/);
  });
});

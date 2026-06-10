/**
 * agent_creation_request store — decision-notification tracking (issue #79).
 *
 * Covers the `notification_state` contract:
 *   - `decideAgentCreationRequestCas` stamps the notification claim
 *     ({decision, claimedAt}) in the SAME atomic UPDATE that wins
 *     proposed → decided, and verifies the win via the UPDATE's rowCount —
 *     a same-decision racer that loses the UPDATE must throw
 *     StaleProposalError even though a status re-read would look "decided"
 *     (so a loser can never claim another cycle's notification).
 *   - `markAgentCreationRequestNotificationSent` merges `sentAt` into the
 *     existing claim instead of replacing it.
 *   - `editRejectedRequest` resets `notification_state` to NULL so the NEXT
 *     decision after an author edit claims + notifies again.
 *
 * Pattern: dependency-composition — mock `postgres-sync` to capture the SQL
 * + return canned results per call. `server-only` is auto-stubbed by the
 * root vitest alias.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock infra
// ---------------------------------------------------------------------------

const capturedQueries: Array<{ text: string; values: unknown[] }> = [];

type CannedResult = { rows: Array<Record<string, unknown>>; rowCount: number };
let cannedResults: CannedResult[] = [];

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn(
    (opts: { queries: Array<{ text: string; values?: unknown[] }> }) => {
      return opts.queries.map((q) => {
        capturedQueries.push({ text: q.text, values: q.values ?? [] });
        return cannedResults.shift() ?? { rows: [], rowCount: 0 };
      });
    },
  ),
}));

vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: vi.fn(),
  postgresSchema: "cinatra_test",
  getPostgresConnectionString: vi.fn(() => "postgres://stub"),
}));

// ---------------------------------------------------------------------------
// SUT imports — after the mocks are registered.
// ---------------------------------------------------------------------------

import {
  decideAgentCreationRequestCas,
  markAgentCreationRequestNotificationSent,
  editRejectedRequest,
  StaleProposalError,
} from "@/lib/agent-creation-requests-store";

/** Full DB-column row shape for the readById round-trips in edit. */
function dbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "req-1",
    org_id: "org-1",
    author_id: "user-author",
    package_slug: "test-agent",
    package_name: "@test/test-agent",
    package_version: "0.1.0",
    status: "rejected",
    proposal_snapshot: { oas: {}, packageJson: {}, skillMd: null },
    review_report: null,
    snapshot_hash: "hash-1",
    resolved_approver_ids: null,
    decided_by: "user-admin",
    decided_at: "2026-06-10T12:00:00.000Z",
    rejection_reason: "missing tests",
    publish_result: null,
    notification_state: { decision: "rejected", claimedAt: "2026-06-10T12:00:01.000Z" },
    created_at: "2026-06-10T11:00:00.000Z",
    updated_at: "2026-06-10T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedQueries.length = 0;
  cannedResults = [];
});

describe("decideAgentCreationRequestCas — atomic notification claim", () => {
  it("stamps the notification claim in the SAME UPDATE that wins proposed → decided", () => {
    cannedResults = [
      // readAgentCreationRequestById (pre-check): still proposed.
      { rows: [dbRow({ status: "proposed", decided_by: null, decided_at: null, rejection_reason: null, notification_state: null })], rowCount: 1 },
      // The decide UPDATE wins.
      { rows: [], rowCount: 1 },
      // readAgentCreationRequestById (returned row): decided + claimed.
      {
        rows: [
          dbRow({
            status: "rejected",
            notification_state: { decision: "rejected", claimedAt: "2026-06-10T12:00:01.000Z" },
          }),
        ],
        rowCount: 1,
      },
    ];
    const row = decideAgentCreationRequestCas({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "user-admin",
      decision: "reject",
      reason: "missing tests",
      expectedSnapshotHash: "hash-1",
    });
    const update = capturedQueries.find((q) => q.text.startsWith("UPDATE"));
    expect(update).toBeDefined();
    // One atomic statement: the decide CAS guards AND the claim stamp.
    expect(update!.text).toContain("status = 'proposed'");
    expect(update!.text).toContain("snapshot_hash = $6");
    expect(update!.text).toContain("notification_state = $7");
    const state = JSON.parse(update!.values[6] as string) as {
      decision: string;
      claimedAt: string;
      sentAt?: string;
    };
    expect(state.decision).toBe("rejected");
    expect(state.claimedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // sentAt is stamped only AFTER a successful notification write.
    expect(state.sentAt).toBeUndefined();
    expect(row.status).toBe("rejected");
  });

  it("throws StaleProposalError on rowCount 0 even when a re-read would show the decided status", () => {
    cannedResults = [
      // Pre-check read: proposed (the racer has not committed yet).
      { rows: [dbRow({ status: "proposed", decided_by: null, decided_at: null, rejection_reason: null, notification_state: null })], rowCount: 1 },
      // The decide UPDATE loses the race (another same-decision decide won).
      { rows: [], rowCount: 0 },
      // NOTE: no re-read result is needed — the loser must throw on rowCount
      // alone. A re-read WOULD show status='rejected' (the winner's write),
      // which is exactly why rowCount is the win signal: the loser must not
      // claim the winner's notification.
    ];
    expect(() =>
      decideAgentCreationRequestCas({
        id: "req-1",
        orgId: "org-1",
        decidedBy: "user-admin-2",
        decision: "reject",
        expectedSnapshotHash: "hash-1",
      }),
    ).toThrow(StaleProposalError);
    // The loser never issued the post-UPDATE re-read.
    expect(capturedQueries).toHaveLength(2);
  });
});

describe("markAgentCreationRequestNotificationSent", () => {
  it("merges sentAt into the EXACT claim being acknowledged (never replaces, never creates, never a later cycle's claim)", () => {
    cannedResults = [{ rows: [], rowCount: 1 }];
    markAgentCreationRequestNotificationSent({
      id: "req-1",
      orgId: "org-1",
      decision: "rejected",
      claimedAt: "2026-06-10T12:00:01.000Z",
    });
    expect(capturedQueries).toHaveLength(1);
    const { text, values } = capturedQueries[0];
    // jsonb concatenation preserves the claim fields...
    expect(text).toContain("notification_state = notification_state || $3::jsonb");
    // ...a missing claim is never invented from nothing...
    expect(text).toContain("notification_state IS NOT NULL");
    // ...and the stamp is scoped to the claim identity minted by THIS cycle's
    // decide CAS: a stalled cycle-1 notifier that resumes after an author
    // edit + re-decision finds a different (decision, claimedAt) and no-ops,
    // so it can never make the new cycle look delivered.
    expect(text).toContain("notification_state->>'decision' = $4");
    expect(text).toContain("notification_state->>'claimedAt' = $5");
    const patch = JSON.parse(values[2] as string) as { sentAt: string };
    expect(patch.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(values[3]).toBe("rejected");
    expect(values[4]).toBe("2026-06-10T12:00:01.000Z");
  });
});

describe("editRejectedRequest", () => {
  it("resets notification_state so the next decision cycle notifies again", () => {
    cannedResults = [
      // readAgentCreationRequestById (pre-check)
      { rows: [dbRow()], rowCount: 1 },
      // UPDATE
      { rows: [], rowCount: 1 },
      // readAgentCreationRequestById (returned row)
      {
        rows: [
          dbRow({
            status: "proposed",
            snapshot_hash: "hash-2",
            decided_by: null,
            decided_at: null,
            rejection_reason: null,
            notification_state: null,
          }),
        ],
        rowCount: 1,
      },
    ];
    const row = editRejectedRequest({
      id: "req-1",
      orgId: "org-1",
      authorId: "user-author",
      newSnapshot: { oas: {}, packageJson: {}, skillMd: null },
    });
    const update = capturedQueries.find((q) => q.text.startsWith("UPDATE"));
    expect(update).toBeDefined();
    expect(update!.text).toContain("notification_state = NULL");
    expect(row.notificationState).toBeNull();
    expect(row.status).toBe("proposed");
  });
});

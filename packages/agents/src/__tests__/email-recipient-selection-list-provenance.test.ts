/**
 * Recipient bundle provenance contract.
 *
 * SCOPING NOTE: this test is hermetic. It does NOT drive a live WayFlow run.
 * Instead it locks the contract between
 *   - the storage layer (email_outreach_recipients_list handler in
 *     email-outreach-stage-actions.ts), which projects bundle-level
 *     provenance into the response, AND
 *   - fetchCampaignRecipients(runId), the public read path used by the
 *     review renderer.
 *
 * The full WayFlow run (a real list → real recipient-selection agent →
 * real bundle) is exercised against a live environment.
 *
 * Two contracts under test:
 *   1. provenance-present  — when an `@cinatra-ai/campaigns:recipients` row
 *      carries `sourceListId` / `sourceListName` / `sourceListMemberType` /
 *      `sourceListSnapshotAt`, the read path surfaces them as
 *      `source: { listId, listName, memberType, snapshotAt }`.
 *   2. provenance-absent (legacy compat) — when no `sourceListId` exists,
 *      the response has NO `source` key (not null, not undefined, ABSENT).
 *
 * Naming: file is `*-provenance.test.ts` (not `*.integration.test.ts`)
 * because the package's vitest.config excludes `*.integration.test.ts` from
 * the default fast-unit run, and this test is hermetic (no real Postgres).
 * The integration-suffix config is reserved for live-Postgres tests.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the objects-client path BEFORE importing the source-under-test.
// `email_outreach_recipients_list` now reads run objects through:
//   requireActorContext()  → resolves the test actor context
//   createSessionObjectsClient(actor).list({ runId, limit })
//                          → returns { items: ObjEnvelope[] }
// The handler filters to envelopes whose `type` is in RECIPIENTS_TYPES and
// returns the latest by `createdAt`. We wrap each per-runId seed row in the
// envelope shape so the source path lights up correctly.
// ---------------------------------------------------------------------------

type Row = { data: Record<string, unknown> };
const RECIPIENT_TYPE = "@cinatra-ai/campaigns:recipients";

// `vi.hoisted` keeps the shared Map module-scoped at hoist time so the
// `vi.mock` factory closures can rely on it without TDZ issues.
const { rowsByRunId } = vi.hoisted(() => ({
  rowsByRunId: new Map<string, Array<{ data: Record<string, unknown> }>>(),
}));

vi.mock("@/lib/auth-session", () => ({
  requireActorContext: async () => ({
    actorType: "human",
    source: "ui",
    userId: "test-user-1",
  }),
}));

vi.mock("@cinatra-ai/objects", () => ({
  createSessionObjectsClient: () => ({
    list: async (input: { runId?: string; limit?: number }) => {
      const runId = String(input.runId ?? "");
      const seeds = rowsByRunId.get(runId) ?? [];
      // Wrap each seed row in ObjEnvelope shape. The test passes
      // `{ data: { confirmedRecipients: [...] } }` per row; the source
      // reads `envelope.data` so we forward `row.data` as the envelope's
      // `data` field (NOT the whole row, which would double-nest under
      // `data.data` and break the recipient extraction). createdAt is
      // monotonic by insertion order so `pickLatest` selects the
      // last-seeded bundle — mirrors the prior
      // `ORDER BY created_at DESC LIMIT 1` semantics.
      const items = seeds.map((row, idx) => ({
        id: `obj-${runId}-${idx}`,
        type: RECIPIENT_TYPE,
        data: row.data,
        createdAt: new Date(2026, 0, 1, 0, 0, idx).toISOString(),
        actor: { runId },
      }));
      return { items };
    },
  }),
}));

import { fetchCampaignRecipients } from "../email-outreach-stage-actions";

beforeEach(() => {
  rowsByRunId.clear();
});

describe("recipient bundle provenance — fetchCampaignRecipients ↔ email_outreach_recipients_list", () => {
  it("surfaces bundle-level provenance (sourceListId/Name/MemberType/SnapshotAt) when a list-sourced bundle is stored", async () => {
    const runId = "run-with-list";
    const snapshotAt = "2026-05-11T08:00:00.000Z";
    rowsByRunId.set(runId, [
      {
        data: {
          confirmedRecipients: [
            {
              contactId: "c1",
              accountId: "a1",
              name: "Alice",
              email: "alice@example.com",
              title: "CEO",
              accountName: "Acme",
            },
            {
              contactId: "c2",
              accountId: "a2",
              name: "Bob",
              email: "bob@example.com",
              title: "CTO",
              accountName: "Globex",
            },
            {
              contactId: "c3",
              accountId: "a3",
              name: "Carol",
              email: "carol@example.com",
              title: "VP",
              accountName: "Initech",
            },
          ],
          sourceListId: "list-beta-prospects",
          sourceListName: "Beta Prospects",
          sourceListMemberType: "contact",
          sourceListSnapshotAt: snapshotAt,
        },
      },
    ]);

    const result = await fetchCampaignRecipients(runId);

    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({
      contactName: "Alice",
      contactEmail: "alice@example.com",
    });

    // The reader projection must carry the bundle's own contactId straight
    // through (CRM provider-native id → the renderer's contact-name link),
    // and keep startupId as the account/company link target (accountId) —
    // NOT collapse contactId into startupId.
    expect(result.items[0].contactId).toBe("c1");
    expect(result.items[0].startupId).toBe("a1");
    expect(result.items[1].contactId).toBe("c2");
    expect(result.items[1].startupId).toBe("a2");

    expect(result.source).toEqual({
      listId: "list-beta-prospects",
      listName: "Beta Prospects",
      memberType: "contact",
      snapshotAt,
    });
  });

  it("omits the source key entirely for legacy bundles without sourceListId (backward-compat)", async () => {
    const runId = "run-legacy";
    rowsByRunId.set(runId, [
      {
        data: {
          // Legacy bundle: no sourceListId / sourceListName / etc.
          confirmedRecipients: [
            {
              contactId: "c1",
              accountId: "a1",
              name: "Alice",
              email: "alice@example.com",
            },
          ],
        },
      },
    ]);

    const result = await fetchCampaignRecipients(runId);

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);

    // KEY assertion: `source` must be absent — not null, not undefined-as-key.
    expect("source" in result).toBe(false);
  });

  it("treats a blank string sourceListId as legacy — source key remains absent", async () => {
    const runId = "run-blank-source";
    rowsByRunId.set(runId, [
      {
        data: {
          confirmedRecipients: [
            { contactId: "c1", name: "Alice", email: "alice@example.com" },
          ],
          sourceListId: "   ", // whitespace-only — handler trims and treats as empty
          sourceListName: "ghost",
        },
      },
    ]);

    const result = await fetchCampaignRecipients(runId);

    expect("source" in result).toBe(false);
  });
});

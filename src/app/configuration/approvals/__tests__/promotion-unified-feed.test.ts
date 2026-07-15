// cinatra#1560 (E10) — the shared promotion source on the E5/E7 UNIFIED FEED:
// dedup identity + keyset-cursor stability when ONE source federates ≥2 subject
// types. All promotion rows share one `sourceKey` (the source has one id), so
// the subject-type-prefixed row id is the sole tie-break + dedup key — this
// proves that keeps pagination collision-free and stable across page boundaries.
//
// Hermetic: the notification keyset reader is an in-memory ms-epoch port; the
// promotion source is fixture-backed and INJECTED via deps.sources (no DB, no
// registry, no runtime). Mirrors unified-feed.test.ts's harness.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/notifications", () => ({
  listNotificationsKeysetForUserId: vi.fn(() => []),
}));
vi.mock("../sources/registry", () => ({ availableSources: vi.fn(async () => []) }));
vi.mock("../sources/marketplace-shared", () => ({
  MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID: "marketplace-submission-moderation",
  MARKETPLACE_MY_SUBMISSIONS_SOURCE_ID: "marketplace-my-submissions",
  MARKETPLACE_VENDOR_APP_MODERATION_SOURCE_ID: "marketplace-vendor-app-moderation",
  MARKETPLACE_VENDOR_APP_STATUS_SOURCE_ID: "marketplace-vendor-app-status",
}));
vi.mock("@/components/ui/badge", () => ({ Badge: () => null }));

import {
  canonicalSourceKey,
  approvalDedupKey,
  loadUnifiedFeedPage,
  type UnifiedFeedCursor,
  type UnifiedFeedItem,
} from "../unified-feed";
import type { AppNotification } from "@/lib/notifications";
import type { ApprovalSource, ApprovalViewer } from "../sources/types";
import { buildPromotionContract, type PromotionBackend, type PromotionBackendRow } from "../sources/promotion-subjects";
import { buildPromotionSource } from "../sources/promotion-requests";
import { PROMOTION_SOURCE_ID } from "../sources/source-ids";

const viewer: ApprovalViewer = { userId: "u", orgId: "o", isAdmin: true };

function backend(rows: PromotionBackendRow[]): PromotionBackend {
  return {
    canReview: () => true,
    canRequest: () => true,
    listInbox: async () => rows,
    listMine: async () => [],
    countInbox: async () => rows.length,
    countMine: async () => 0,
    decide: async () => ({ ok: true }),
  };
}

function br(subjectId: string, createdAt: string): PromotionBackendRow {
  return { subjectId, title: subjectId, status: "pending", createdAt };
}

function promotionSource(memory: PromotionBackendRow[], artifact: PromotionBackendRow[]): ApprovalSource {
  const adapters = [
    { subjectType: "memory", kindLabel: "Memory", backend: backend(memory) },
    { subjectType: "artifact", kindLabel: "Artifact", backend: backend(artifact) },
  ];
  return buildPromotionSource(buildPromotionContract(adapters), adapters);
}

function makeNotifReader(store: AppNotification[]) {
  const ms = (s: string) => Date.parse(s);
  return (args: {
    userId: string;
    limit: number;
    before?:
      | { boundary: "row"; createdAt: string; id: string }
      | { boundary: "createdAtInclusive"; createdAt: string }
      | { boundary: "createdAtExclusive"; createdAt: string };
  }): AppNotification[] => {
    let rows = store.slice();
    const b = args.before;
    if (b) {
      const bc = ms(b.createdAt);
      if (b.boundary === "row") {
        rows = rows.filter((n) => ms(n.createdAt) < bc || (ms(n.createdAt) === bc && n.id < b.id));
      } else if (b.boundary === "createdAtInclusive") {
        rows = rows.filter((n) => ms(n.createdAt) <= bc);
      } else {
        rows = rows.filter((n) => ms(n.createdAt) < bc);
      }
    }
    rows.sort((x, y) =>
      ms(x.createdAt) !== ms(y.createdAt) ? (ms(x.createdAt) > ms(y.createdAt) ? -1 : 1) : x.id > y.id ? -1 : 1,
    );
    return rows.slice(0, args.limit);
  };
}

function notif(id: string, createdAt: string): AppNotification {
  return { id, title: id, body: "", kind: "info", createdAt } as AppNotification;
}

const keyOf = (i: UnifiedFeedItem) => `${i.sourceKey}#${i.id}`;

async function pageAll(source: ApprovalSource, reader: ReturnType<typeof makeNotifReader>, limit: number) {
  const out: UnifiedFeedItem[] = [];
  let cursor: UnifiedFeedCursor | null = null;
  for (let i = 0; i < 200; i += 1) {
    const page = await loadUnifiedFeedPage(viewer, {
      limit,
      cursor,
      deps: { sources: [source], listNotifications: reader },
    });
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

describe("promotion rows on the unified feed", () => {
  it("all share ONE canonical sourceKey; the prefixed id is the unique dedup key", async () => {
    expect(canonicalSourceKey(PROMOTION_SOURCE_ID)).toBe(PROMOTION_SOURCE_ID);
    const src = promotionSource([br("m1", "2026-07-14T03:00:00Z")], [br("a1", "2026-07-14T02:00:00Z")]);
    const page = await loadUnifiedFeedPage(viewer, {
      limit: 50,
      deps: { sources: [src], listNotifications: makeNotifReader([]) },
    });
    const approvals = page.items.filter((i) => i.kind === "approval");
    expect(approvals.map((i) => i.sourceKey)).toEqual([PROMOTION_SOURCE_ID, PROMOTION_SOURCE_ID]);
    expect(approvals.map((i) => i.id)).toEqual(["memory:m1", "artifact:a1"]);
    // Distinct dedup keys → different subject types never collide.
    const dedupKeys = approvals.map((i) => approvalDedupKey(PROMOTION_SOURCE_ID, i.id));
    expect(new Set(dedupKeys).size).toBe(2);
  });

  it("keyset pagination is STABLE across page boundaries — no dup, no skip", async () => {
    const memory = [br("m1", "2026-07-14T05:00:00Z"), br("m2", "2026-07-14T02:00:00Z")];
    const artifact = [br("a1", "2026-07-14T04:00:00Z"), br("a2", "2026-07-14T01:00:00Z")];
    const src = promotionSource(memory, artifact);
    const reader = makeNotifReader([notif("n1", "2026-07-14T03:00:00Z"), notif("n2", "2026-07-14T00:30:00Z")]);

    const oneShot = await loadUnifiedFeedPage(viewer, {
      limit: 50,
      deps: { sources: [src], listNotifications: reader },
    });
    const paged = await pageAll(src, reader, 1);

    const oneKeys = oneShot.items.map(keyOf);
    const pagedKeys = paged.map(keyOf);
    // Same rows, same order, page-by-page as in one shot.
    expect(pagedKeys).toEqual(oneKeys);
    // No duplicates, nothing skipped: 4 approvals + 2 notifications.
    expect(new Set(pagedKeys).size).toBe(6);
    expect(pagedKeys).toEqual([
      "promotion-requests#memory:m1", // 05:00
      "promotion-requests#artifact:a1", // 04:00
      "notifications#n1", // 03:00
      "promotion-requests#memory:m2", // 02:00
      "promotion-requests#artifact:a2", // 01:00
      "notifications#n2", // 00:30
    ]);
  });

  it("a same-instant cross-subject tie orders by id DESC and paginates stably", async () => {
    // memory:m1 and artifact:a1 at the SAME instant — one sourceKey, so the tie
    // breaks on id DESC ("memory:m1" > "artifact:a1").
    const src = promotionSource([br("m1", "2026-07-14T02:00:00Z")], [br("a1", "2026-07-14T02:00:00Z")]);
    const reader = makeNotifReader([]);
    const paged = await pageAll(src, reader, 1);
    expect(paged.map(keyOf)).toEqual(["promotion-requests#memory:m1", "promotion-requests#artifact:a1"]);
    expect(new Set(paged.map(keyOf)).size).toBe(2);
  });
});

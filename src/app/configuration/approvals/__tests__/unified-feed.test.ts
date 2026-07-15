/**
 * Unit proof for the unified notifications + pending-approvals data layer
 * (cinatra#1555 E5): the source-delegated pending predicate, the EXPLICIT dedup
 * pairing with a STABLE canonical source key, the two-tier keyset merge (stable
 * across page boundaries + under concurrent inserts), the cross-stream tie-break
 * and its epoch-based (offset-tolerant) timestamp comparison.
 *
 * Fully hermetic: the heavy top-level imports (`@/lib/notifications`, the source
 * `registry`, `marketplace-shared`) are mocked, and the merge is driven through
 * INJECTED deps (a faithful in-memory ms-epoch notification keyset reader + fake
 * sources), so there is no DB, no network, and no agents/marketplace runtime.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notifications", () => ({
  // Overridden per-test via injected deps; present only so the import resolves.
  listNotificationsKeysetForUserId: vi.fn(() => []),
}));
vi.mock("../sources/registry", () => ({ availableSources: vi.fn(async () => []) }));
// String literals inline (the factory is hoisted above any top-level const).
vi.mock("../sources/marketplace-shared", () => ({
  MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID: "marketplace-submission-moderation",
  MARKETPLACE_MY_SUBMISSIONS_SOURCE_ID: "marketplace-my-submissions",
  MARKETPLACE_VENDOR_APP_MODERATION_SOURCE_ID: "marketplace-vendor-app-moderation",
  MARKETPLACE_VENDOR_APP_STATUS_SOURCE_ID: "marketplace-vendor-app-status",
}));

// Real string values of the four marketplace source ids the dedup pairing keys
// on — must match the mocked module above.
const SUBMISSION_MODERATION = "marketplace-submission-moderation";
const MY_SUBMISSIONS = "marketplace-my-submissions";
const VENDOR_APP_MODERATION = "marketplace-vendor-app-moderation";
const VENDOR_APP_STATUS = "marketplace-vendor-app-status";
// Canonical (deduped) source keys.
const SUBMISSION_KEY = "marketplace-submission";
const VENDOR_APP_KEY = "marketplace-vendor-application";

import {
  approvalDedupKey,
  canonicalizeInstant,
  canonicalSourceKey,
  compareUnifiedDesc,
  decodeUnifiedFeedCursor,
  dedupeApprovals,
  encodeUnifiedFeedCursor,
  loadUnifiedFeedPage,
  notificationBoundFromCursor,
  NOTIFICATION_SOURCE_KEY,
  type UnifiedFeedCursor,
  type UnifiedFeedItem,
} from "../unified-feed";
import type { AppNotification } from "@/lib/notifications";
import type {
  ApprovalRow,
  ApprovalSource,
  ApprovalViewer,
  Direction,
  FetchOpts,
} from "../sources/types";

const viewer: ApprovalViewer = { userId: "u", orgId: "o", isAdmin: true };

// --- fixtures ---------------------------------------------------------------

function arow(sourceId: string, id: string, createdAt: string, status = "pending"): ApprovalRow {
  return { id, sourceId, title: `${sourceId}:${id}`, status, createdAt };
}

function notif(id: string, createdAt: string): AppNotification {
  return { id, title: `n:${id}`, body: "", kind: "info", createdAt };
}

function fakeSource(
  id: string,
  cfg: { inbox?: ApprovalRow[]; mine?: ApprovalRow[]; throwOn?: Direction },
): ApprovalSource {
  const inbox = cfg.inbox ?? [];
  const mine = cfg.mine ?? [];
  return {
    id,
    title: id,
    availability: () => "ready",
    appliesTo: (_v: ApprovalViewer, dir: Direction) =>
      dir === "inbox" ? cfg.inbox !== undefined : cfg.mine !== undefined,
    counts: async () => ({ inbox: 0, mine: 0 }),
    async fetchInbox() {
      if (cfg.throwOn === "inbox") throw new Error("boom-inbox");
      return { availability: "ready", rows: inbox, actions: [] };
    },
    async fetchMine(_v: ApprovalViewer, _opts?: FetchOpts) {
      if (cfg.throwOn === "mine") throw new Error("boom-mine");
      return { availability: "ready", rows: mine, actions: [] };
    },
    rowRenderer: () => null,
    actions: { decide: async () => ({ ok: true }) },
  };
}

/** Faithful in-memory port of the notifications keyset SQL, at MILLISECOND
 *  epoch precision (mirrors `date_trunc('milliseconds', created_at)` + the
 *  `created_at < cursor + 1ms` bounds), newest-first (`ms DESC, id DESC`). */
function makeNotifReader(store: { rows: AppNotification[] }) {
  const ms = (s: string) => Date.parse(s);
  return (args: {
    userId: string;
    limit: number;
    before?:
      | { boundary: "row"; createdAt: string; id: string }
      | { boundary: "createdAtInclusive"; createdAt: string }
      | { boundary: "createdAtExclusive"; createdAt: string };
  }): AppNotification[] => {
    let rows = store.rows.slice();
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

async function pageAll(
  sourcesFor: () => ApprovalSource[],
  notifReader: ReturnType<typeof makeNotifReader>,
  limit: number,
): Promise<UnifiedFeedItem[]> {
  const out: UnifiedFeedItem[] = [];
  let cursor: UnifiedFeedCursor | null = null;
  for (let i = 0; i < 200; i += 1) {
    const page = await loadUnifiedFeedPage(viewer, {
      limit,
      cursor,
      deps: { sources: sourcesFor(), listNotifications: notifReader },
    });
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

const keyOf = (i: UnifiedFeedItem) => `${i.sourceKey}#${i.id}`;

// --- pure helpers -----------------------------------------------------------

describe("canonicalizeInstant", () => {
  it("normalizes offsets + spellings to canonical UTC ms ISO; passes through junk", () => {
    expect(canonicalizeInstant("2026-01-01T01:00:00+01:00")).toBe("2026-01-01T00:00:00.000Z");
    expect(canonicalizeInstant("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(canonicalizeInstant("not-a-date")).toBe("not-a-date");
  });
});

describe("canonical source key + dedup key — explicit pairing", () => {
  it("the two marketplace pairs collapse onto one stable canonical key; others keep their id", () => {
    expect(canonicalSourceKey(SUBMISSION_MODERATION)).toBe(SUBMISSION_KEY);
    expect(canonicalSourceKey(MY_SUBMISSIONS)).toBe(SUBMISSION_KEY);
    expect(canonicalSourceKey(VENDOR_APP_MODERATION)).toBe(VENDOR_APP_KEY);
    expect(canonicalSourceKey(VENDOR_APP_STATUS)).toBe(VENDOR_APP_KEY);
    expect(canonicalSourceKey("agent-creation-requests")).toBe("agent-creation-requests");

    expect(approvalDedupKey(SUBMISSION_MODERATION, "s1")).toBe(approvalDedupKey(MY_SUBMISSIONS, "s1"));
    expect(approvalDedupKey(VENDOR_APP_MODERATION, "va1")).toBe(approvalDedupKey(VENDOR_APP_STATUS, "va1"));
    expect(approvalDedupKey(SUBMISSION_MODERATION, "s1")).not.toBe(approvalDedupKey(MY_SUBMISSIONS, "s2"));
    // A non-paired source sharing an id value with a paired one does NOT collide.
    expect(approvalDedupKey("host-port-grants", "s1")).not.toBe(approvalDedupKey(SUBMISSION_MODERATION, "s1"));
    expect(approvalDedupKey("agent-creation-requests", "x")).toBe("agent-creation-requests:x");
  });
});

describe("comparator (createdAt DESC by EPOCH, sourceKey ASC, id DESC)", () => {
  it("orders as specified and treats offset-equal instants as a tie", () => {
    const bNewer = { createdAt: "2026-01-03T00:00:00Z", sourceKey: "z", id: "0" };
    const a = { createdAt: "2026-01-02T00:00:00Z", sourceKey: "b", id: "1" };
    expect(compareUnifiedDesc(bNewer, a)).toBeLessThan(0);
    // Same instant, different spelling → NOT ordered by createdAt; falls to sourceKey.
    const s1 = { createdAt: "2026-01-02T00:00:00.000Z", sourceKey: "aaa", id: "9" };
    const s2 = { createdAt: "2026-01-02T01:00:00+01:00", sourceKey: "bbb", id: "0" };
    expect(compareUnifiedDesc(s1, s2)).toBeLessThan(0); // aaa < bbb, same instant
    // Same instant + sourceKey → id DESC.
    const i1 = { createdAt: "2026-01-02T00:00:00Z", sourceKey: "k", id: "9" };
    const i2 = { createdAt: "2026-01-02T00:00:00Z", sourceKey: "k", id: "1" };
    expect(compareUnifiedDesc(i1, i2)).toBeLessThan(0);
  });
});

describe("notificationBoundFromCursor", () => {
  it("derives row / inclusive / exclusive from the cursor's sourceKey (createdAt canonicalized)", () => {
    expect(
      notificationBoundFromCursor({ createdAt: "2026-01-01T00:00:00Z", sourceKey: NOTIFICATION_SOURCE_KEY, id: "n1" }),
    ).toEqual({ boundary: "row", createdAt: "2026-01-01T00:00:00.000Z", id: "n1" });
    // 'agent-...' < 'notifications' → equal-instant notifications still ahead.
    expect(
      notificationBoundFromCursor({ createdAt: "2026-01-01T00:00:00Z", sourceKey: "agent-creation-requests", id: "a1" }),
    ).toEqual({ boundary: "createdAtInclusive", createdAt: "2026-01-01T00:00:00.000Z" });
    // 'workflow-...' > 'notifications' → equal-instant notifications already past.
    expect(
      notificationBoundFromCursor({ createdAt: "2026-01-01T00:00:00Z", sourceKey: "workflow-legacy-passthrough", id: "w1" }),
    ).toEqual({ boundary: "createdAtExclusive", createdAt: "2026-01-01T00:00:00.000Z" });
  });
});

describe("dedupeApprovals — inbox wins on a collision", () => {
  it("keeps ONE row per underlying item, preferring the actionable inbox row", () => {
    const modRow = arow(SUBMISSION_MODERATION, "s1", "2026-01-01T00:00:00Z");
    const selfRow = arow(MY_SUBMISSIONS, "s1", "2026-01-01T00:00:00Z");
    const deduped = dedupeApprovals(
      [{ row: modRow, direction: "inbox" }],
      [{ row: selfRow, direction: "mine" }],
    );
    expect(deduped).toHaveLength(1);
    expect(deduped[0].direction).toBe("inbox");
    expect(deduped[0].row.sourceId).toBe(SUBMISSION_MODERATION);
  });
});

// --- integration: the merge --------------------------------------------------

describe("loadUnifiedFeedPage — merge, dedup, source-delegated pending", () => {
  it("merge-sorts notifications + approvals newest first by createdAt", async () => {
    const store = {
      rows: [notif("n1", "2026-01-05T00:00:00Z"), notif("n2", "2026-01-02T00:00:00Z")],
    };
    const sources = [
      fakeSource("agent-creation-requests", {
        inbox: [arow("agent-creation-requests", "a1", "2026-01-04T00:00:00Z")],
        mine: [arow("agent-creation-requests", "a2", "2026-01-01T00:00:00Z", "proposed")],
      }),
    ];
    const page = await loadUnifiedFeedPage(viewer, {
      limit: 10,
      deps: { sources, listNotifications: makeNotifReader(store) },
    });
    expect(page.items.map(keyOf)).toEqual([
      "notifications#n1", // 01-05
      "agent-creation-requests#a1", // 01-04
      "notifications#n2", // 01-02
      "agent-creation-requests#a2", // 01-01
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("calls fetchMine with { status: 'proposed' } and does NOT re-filter by status — pending-only is the SOURCE contract (#1555)", async () => {
    const seenOpts: (FetchOpts | undefined)[] = [];
    const agent: ApprovalSource = {
      ...fakeSource("agent-creation-requests", { mine: [] }),
      async fetchMine(_v: ApprovalViewer, opts?: FetchOpts) {
        seenOpts.push(opts);
        return { availability: "ready", rows: [], actions: [] };
      },
    };
    // A source whose pending rows carry a NON-{proposed,pending,applied} status
    // (e.g. dynamic-type 'unapproved'/'reserved') must NOT be dropped: the union
    // trusts the source's pending-only fetch, it does not gate on status string.
    const dyn = fakeSource("dynamic-type-artifact-visibility", {
      inbox: [
        arow("dynamic-type-artifact-visibility", "d1", "2026-01-03T00:00:00Z", "unapproved"),
        arow("dynamic-type-artifact-visibility", "d2", "2026-01-02T00:00:00Z", "reserved"),
      ],
    });
    const page = await loadUnifiedFeedPage(viewer, {
      limit: 10,
      deps: { sources: [agent, dyn], listNotifications: makeNotifReader({ rows: [] }) },
    });
    expect(seenOpts).toEqual([{ status: "proposed" }]);
    expect(page.items.map((i) => i.id)).toEqual(["d1", "d2"]);
  });

  it("dedups BOTH marketplace pairs onto a STABLE canonical key; the actionable inbox row wins", async () => {
    const sources = [
      fakeSource(SUBMISSION_MODERATION, { inbox: [arow(SUBMISSION_MODERATION, "s1", "2026-01-04T00:00:00Z")] }),
      fakeSource(MY_SUBMISSIONS, { mine: [arow(MY_SUBMISSIONS, "s1", "2026-01-04T00:00:00Z")] }),
      fakeSource(VENDOR_APP_MODERATION, { inbox: [arow(VENDOR_APP_MODERATION, "va1", "2026-01-03T00:00:00Z", "applied")] }),
      fakeSource(VENDOR_APP_STATUS, { mine: [arow(VENDOR_APP_STATUS, "va1", "2026-01-03T00:00:00Z", "applied")] }),
    ];
    const page = await loadUnifiedFeedPage(viewer, {
      limit: 10,
      deps: { sources, listNotifications: makeNotifReader({ rows: [] }) },
    });
    expect(page.items).toHaveLength(2);
    const bySrcKey = Object.fromEntries(page.items.map((i) => [i.sourceKey, i.approval]));
    // The deduped row carries the CANONICAL source key (stable across pages).
    expect(bySrcKey[SUBMISSION_KEY]?.direction).toBe("inbox");
    expect(bySrcKey[SUBMISSION_KEY]?.row.sourceId).toBe(SUBMISSION_MODERATION);
    expect(bySrcKey[VENDOR_APP_KEY]?.direction).toBe("inbox");
    expect(bySrcKey[VENDOR_APP_KEY]?.row.sourceId).toBe(VENDOR_APP_MODERATION);
  });

  it("non-colliding sources with the SAME id value stay separate rows", async () => {
    const sources = [
      fakeSource("host-port-grants", { inbox: [arow("host-port-grants", "s1", "2026-01-02T00:00:00Z")] }),
      fakeSource(SUBMISSION_MODERATION, { inbox: [arow(SUBMISSION_MODERATION, "s1", "2026-01-01T00:00:00Z")] }),
    ];
    const page = await loadUnifiedFeedPage(viewer, {
      limit: 10,
      deps: { sources, listNotifications: makeNotifReader({ rows: [] }) },
    });
    expect(page.items.map((i) => i.sourceKey).sort()).toEqual([SUBMISSION_KEY, "host-port-grants"].sort());
  });

  it("a throwing source degrades the page: surviving rows still returned, but NO unsound cursor", async () => {
    const throwing = fakeSource("host-port-grants", { inbox: [], throwOn: "inbox" });
    const ok = fakeSource("agent-creation-requests", {
      inbox: [arow("agent-creation-requests", "ok", "2026-01-01T00:00:00Z")],
    });
    const page = await loadUnifiedFeedPage(viewer, {
      limit: 10,
      deps: { sources: [throwing, ok], listNotifications: makeNotifReader({ rows: [] }) },
    });
    // The surviving source's rows are still shown — the feed does not 500 on one
    // bad source...
    expect(page.items.map((i) => i.id)).toEqual(["ok"]);
    // ...but the page is flagged degraded and hands out NO cursor: an incomplete
    // approval snapshot cannot yield a sound keyset position.
    expect(page.degraded).toBe(true);
    expect(page.nextCursor).toBeNull();
  });
});

// --- integration: soundness under source failure ----------------------------

describe("degraded pages never advance the cursor (keyset soundness under failure)", () => {
  it("a transiently-failing source is not silently skipped on a later page — the degraded page suppresses the cursor, so a retry recovers its rows (#1555)", async () => {
    // A marketplace-style source that throws on its FIRST fetch, then recovers
    // and returns a row NEWER than every notification — exactly the row a naive
    // "advance the cursor anyway" would filter out of every later page forever.
    let mCalls = 0;
    const mRow = arow(SUBMISSION_MODERATION, "m-new", "2026-01-09T00:00:00Z");
    const flaky: ApprovalSource = {
      ...fakeSource(SUBMISSION_MODERATION, { inbox: [] }),
      async fetchInbox() {
        mCalls += 1;
        if (mCalls === 1) throw new Error("marketplace 503");
        return { availability: "ready", rows: [mRow], actions: [] };
      },
    };
    const store = {
      rows: [
        notif("n1", "2026-01-05T00:00:00Z"),
        notif("n2", "2026-01-03T00:00:00Z"),
        notif("n3", "2026-01-01T00:00:00Z"),
      ],
    };
    const reader = makeNotifReader(store);

    // Page 1 — the source is down: degraded, surviving notifications shown, and
    // NO cursor (so the client cannot page forward over the incomplete snapshot).
    const p1 = await loadUnifiedFeedPage(viewer, {
      limit: 2,
      deps: { sources: [flaky], listNotifications: reader },
    });
    expect(p1.degraded).toBe(true);
    expect(p1.nextCursor).toBeNull();
    expect(p1.items.every((i) => i.kind === "notification")).toBe(true); // m-new absent while down

    // Retry the SAME (null) cursor now that the source recovered: a sound,
    // complete page — m-new (the newest row) is at the TOP, nothing lost to a
    // stale advanced cursor, and the cursor is handed out again.
    const retry = await loadUnifiedFeedPage(viewer, {
      limit: 2,
      deps: { sources: [flaky], listNotifications: reader },
    });
    expect(retry.degraded).toBe(false);
    expect(retry.items[0].id).toBe("m-new");
    expect(retry.nextCursor).not.toBeNull();
  });
});

// --- integration: keyset stability ------------------------------------------

describe("keyset pagination stability", () => {
  it("paging with a small limit yields the full ordered feed — no dup, no skip", async () => {
    const store = {
      rows: Array.from({ length: 6 }, (_, i) =>
        notif(`n${i}`, `2026-01-${String(20 - i * 2).padStart(2, "0")}T00:00:00Z`),
      ),
    };
    const sources = [
      fakeSource("agent-creation-requests", {
        inbox: Array.from({ length: 4 }, (_, i) =>
          arow("agent-creation-requests", `a${i}`, `2026-01-${String(19 - i * 2).padStart(2, "0")}T00:00:00Z`),
        ),
      }),
    ];
    const reader = makeNotifReader(store);
    const full = await pageAll(() => sources, reader, 1000);
    const paged = await pageAll(() => sources, reader, 2);
    expect(paged.map(keyOf)).toEqual(full.map(keyOf)); // identical order
    expect(new Set(paged.map(keyOf)).size).toBe(paged.length); // no dup
    for (let i = 1; i < paged.length; i += 1) {
      expect(compareUnifiedDesc(paged[i - 1], paged[i])).toBeLessThan(0); // strictly descending
    }
  });

  it("cross-stream tie (same instant) breaks by sourceKey ASC then id DESC, stable across a limit-1 boundary", async () => {
    const T = "2026-01-10T00:00:00Z";
    const store = { rows: [notif("nX", T)] };
    const sources = [
      fakeSource("agent-creation-requests", { inbox: [arow("agent-creation-requests", "aX", T)] }),
      fakeSource("workflow-legacy-passthrough", { inbox: [arow("workflow-legacy-passthrough", "wX", T)] }),
    ];
    const reader = makeNotifReader(store);
    const paged = await pageAll(() => sources, reader, 1);
    expect(paged.map(keyOf)).toEqual([
      "agent-creation-requests#aX", // 'agent...' < 'notifications'
      "notifications#nX",
      "workflow-legacy-passthrough#wX", // 'workflow...' > 'notifications'
    ]);
    expect(new Set(paged.map(keyOf)).size).toBe(3); // no dup across the tie boundary
  });

  it("a concurrent insert NEWER than the cursor never appears on a later page (no dup/skip)", async () => {
    const store = {
      rows: [notif("n-old1", "2026-01-05T00:00:00Z"), notif("n-old2", "2026-01-03T00:00:00Z")],
    };
    const sources = [
      fakeSource("agent-creation-requests", {
        inbox: [
          arow("agent-creation-requests", "a-new", "2026-01-06T00:00:00Z"),
          arow("agent-creation-requests", "a-mid", "2026-01-04T00:00:00Z"),
        ],
      }),
    ];
    const reader = makeNotifReader(store);
    const p1 = await loadUnifiedFeedPage(viewer, { limit: 2, deps: { sources, listNotifications: reader } });
    expect(p1.items.map(keyOf)).toEqual(["agent-creation-requests#a-new", "notifications#n-old1"]);
    expect(p1.nextCursor).not.toBeNull();
    store.rows.push(notif("n-future", "2026-02-01T00:00:00Z")); // concurrent insert, newest of all
    const p2 = await loadUnifiedFeedPage(viewer, {
      limit: 10,
      cursor: p1.nextCursor,
      deps: { sources, listNotifications: reader },
    });
    expect(p2.items.map(keyOf)).toEqual(["agent-creation-requests#a-mid", "notifications#n-old2"]);
    expect(p2.items.some((i) => i.id === "n-future")).toBe(false);
  });
});

describe("cursor token round-trip", () => {
  it("encodes + decodes; malformed → null", () => {
    const c: UnifiedFeedCursor = { createdAt: "2026-01-01T00:00:00.000Z", sourceKey: "notifications", id: "abc" };
    expect(decodeUnifiedFeedCursor(encodeUnifiedFeedCursor(c))).toEqual(c);
    expect(decodeUnifiedFeedCursor(null)).toBeNull();
    expect(decodeUnifiedFeedCursor("")).toBeNull();
    expect(decodeUnifiedFeedCursor("!!!not-base64-json!!!")).toBeNull();
    expect(decodeUnifiedFeedCursor(Buffer.from('{"createdAt":1}', "utf8").toString("base64url"))).toBeNull();
  });
});

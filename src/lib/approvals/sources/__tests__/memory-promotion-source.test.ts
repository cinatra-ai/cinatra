// cinatra#1381 AC1 + AC6 — the memory subject is LIVE on the shared promotion
// source, and it brought no surface of its own with it.
//
// AC1 (by fixture, per the AC's own wording): a pending memory promotion appears
// as a feed row in the unified /notifications source, the requester sees it under
// "your requests", the reviewer sees it in the inbox, its count reaches the
// top-bar bell badge, and an approve routes to the memory backend carrying the
// CAS token the row published.
//
// AC6: no approvals page, route or promotion-specific UI is introduced — the
// source registry, its ids and the promotion source's own identity are unchanged.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Inert Badge — the renderer smoke asserts the plain text the source emits.
vi.mock("@/components/ui/badge", () => ({ Badge: () => null }));

const listMemoryPromotionInbox = vi.fn(async () => [] as unknown[]);
const listMemoryPromotionMine = vi.fn(async () => [] as unknown[]);
const countMemoryPromotionInbox = vi.fn(async () => 0);
const countMemoryPromotionMine = vi.fn(async () => 0);
const decideMemoryPromotion = vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true }));

vi.mock("@/lib/objects/memory-row-promotion", () => ({
  listMemoryPromotionInbox: (...a: unknown[]) => listMemoryPromotionInbox(...(a as [])),
  listMemoryPromotionMine: (...a: unknown[]) => listMemoryPromotionMine(...(a as [])),
  countMemoryPromotionInbox: (...a: unknown[]) => countMemoryPromotionInbox(...(a as [])),
  countMemoryPromotionMine: (...a: unknown[]) => countMemoryPromotionMine(...(a as [])),
  decideMemoryPromotion: (...a: unknown[]) => decideMemoryPromotion(...(a as [])),
}));

// The artifact subject shares this source; stub its data layer so this suite
// measures the MEMORY contribution and nothing else.
vi.mock("@/lib/objects/artifact-row-promotion", () => ({
  listArtifactPromotionInbox: async () => [],
  listArtifactPromotionMine: async () => [],
  countArtifactPromotionInbox: async () => 0,
  countArtifactPromotionMine: async () => 0,
  decideArtifactPromotion: async () => ({ ok: true }),
}));

import { promotionRequestsSource } from "../promotion-requests";
import { promotionRequestsContract } from "../promotion-requests.contract";
import { memoryPromotionAdapter, promotionSubjectAdapters } from "../promotion-subjects";
import { PROMOTION_SOURCE_ID } from "../source-ids";
import { summarizeApprovalsNav } from "@/lib/approvals/nav-summary";
import type { ApprovalViewer } from "../types";

const admin: ApprovalViewer = { userId: "u-admin", orgId: "org-1", isAdmin: true };
const member: ApprovalViewer = { userId: "u-member", orgId: "org-1", isAdmin: false };

const PENDING = {
  requestId: "req-1",
  objectId: "mem-1",
  title: "Deployment runbook",
  status: "pending",
  createdAt: "2026-08-20T00:00:00.000Z",
  version: "3",
  fromScope: "private",
  toScope: "organization",
  toOwnerLabel: null,
  toOwnerId: "org-1",
  requestedBy: "u-member",
  duplicateHint: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  listMemoryPromotionInbox.mockResolvedValue([]);
  listMemoryPromotionMine.mockResolvedValue([]);
  countMemoryPromotionInbox.mockResolvedValue(0);
  countMemoryPromotionMine.mockResolvedValue(0);
  decideMemoryPromotion.mockResolvedValue({ ok: true });
});

describe("the dormant adapter is plugged", () => {
  it("memoryPromotionAdapter carries a backend (it shipped `backend: null` for this issue)", () => {
    expect(memoryPromotionAdapter.subjectType).toBe("memory");
    expect(memoryPromotionAdapter.kindLabel).toBe("Memory");
    expect(memoryPromotionAdapter.backend).not.toBeNull();
  });

  it("the shared source is READY, so the feed and the badge stop dropping it", async () => {
    expect(await promotionRequestsContract.availability(admin)).toBe("ready");
    expect(await promotionRequestsSource.availability(admin)).toBe("ready");
  });

  it("applies to a reviewer's inbox and to any member's own requests", () => {
    expect(promotionRequestsSource.appliesTo(admin, "inbox")).toBe(true);
    expect(promotionRequestsSource.appliesTo(member, "mine")).toBe(true);
  });
});

describe("AC1 — the pending request as a unified-feed row", () => {
  it("appears in the REVIEWER's inbox under the memory-prefixed row id, carrying the CAS token", async () => {
    listMemoryPromotionInbox.mockResolvedValue([PENDING]);
    const env = await promotionRequestsSource.fetchInbox!(admin);
    expect(env.availability).toBe("ready");
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0]).toMatchObject({
      id: "memory:req-1",
      sourceId: PROMOTION_SOURCE_ID,
      title: "Deployment runbook",
      status: "pending",
      version: "3",
    });
    // The inline approve/reject affordance is the SHARED source's, unchanged.
    expect(env.actions.map((a) => a.id).sort()).toEqual(["approve", "reject"]);
    expect(env.actions.find((a) => a.id === "reject")?.requiresReason).toBe(true);
  });

  it("appears in the REQUESTER's own list", async () => {
    listMemoryPromotionMine.mockResolvedValue([PENDING]);
    const env = await promotionRequestsSource.fetchMine!(member);
    expect(env.rows[0].id).toBe("memory:req-1");
  });

  it("renders through the SHARED generic renderer — the Memory kind badge and the scope line", async () => {
    listMemoryPromotionInbox.mockResolvedValue([PENDING]);
    const [row] = (await promotionRequestsSource.fetchInbox!(admin)).rows;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(promotionRequestsSource.rowRenderer!(row, { direction: "inbox" }) as never);
    expect(html).toContain("Deployment runbook");
    expect(html).toContain("Private → Organization");
    expect(html).toContain("by u-member");
  });

  it("its count reaches the top-bar bell badge through the SAME light contract", async () => {
    countMemoryPromotionInbox.mockResolvedValue(2);
    countMemoryPromotionMine.mockResolvedValue(0);
    expect(await promotionRequestsContract.counts(admin)).toEqual({ inbox: 2, mine: 0 });
    const badge = await summarizeApprovalsNav([promotionRequestsContract], admin);
    expect(badge).toEqual({ total: 2, visible: true });
  });

  it("lights the badge for a non-admin requester through their OWN pending request", async () => {
    countMemoryPromotionInbox.mockResolvedValue(0);
    countMemoryPromotionMine.mockResolvedValue(1);
    const badge = await summarizeApprovalsNav([promotionRequestsContract], member);
    expect(badge.visible).toBe(true);
  });

  it("a non-reviewer contributes ZERO inbox count — the badge never leaks work they cannot see", async () => {
    countMemoryPromotionInbox.mockResolvedValue(99);
    expect(await promotionRequestsContract.counts(member)).toMatchObject({ inbox: 0 });
    expect(countMemoryPromotionInbox).not.toHaveBeenCalled();
  });
});

describe("AC1 — the approve routes to the memory backend", () => {
  it("dispatches by the row-id discriminator and carries the reviewed version back", async () => {
    const res = await promotionRequestsSource.actions!.decide(
      { rowId: "memory:req-1", action: "approve", expectedVersion: "3" },
      admin,
    );
    expect(res).toEqual({ ok: true });
    expect(decideMemoryPromotion).toHaveBeenCalledWith({
      requestId: "req-1",
      action: "approve",
      expectedVersion: "3",
      viewer: admin,
    });
  });

  it("a rejection without a reason is refused by the SHARED source before the backend is touched", async () => {
    const res = await promotionRequestsSource.actions!.decide(
      { rowId: "memory:req-1", action: "reject" },
      admin,
    );
    expect(res as Record<string, unknown>).toMatchObject({ ok: false, code: "reason_required" });
    expect(decideMemoryPromotion).not.toHaveBeenCalled();
  });

  it("maps a `secret_scan` refusal to a FORBIDDEN decide result, surfaced in place", async () => {
    decideMemoryPromotion.mockResolvedValue({ ok: false, code: "secret_scan", message: "refused" });
    const res = await promotionRequestsSource.actions!.decide(
      { rowId: "memory:req-1", action: "approve", expectedVersion: "3" },
      admin,
    );
    expect(res).toMatchObject({ ok: false, kind: "forbidden", code: "secret_scan" });
  });

  it("a malformed or foreign row id never reaches the memory backend", async () => {
    for (const rowId of ["req-1", ":req-1", "memory:", "unknownsubject:req-1"]) {
      const res = await promotionRequestsSource.actions!.decide(
        { rowId, action: "approve", expectedVersion: "3" },
        admin,
      );
      expect(res).toMatchObject({ ok: false, code: "not_found" });
    }
    expect(decideMemoryPromotion).not.toHaveBeenCalled();
  });
});

describe("AC6 — no approvals page, route or promotion-specific UI is introduced", () => {
  it("the promotion source keeps ONE id and gains no sibling", () => {
    expect(promotionRequestsSource.id).toBe(PROMOTION_SOURCE_ID);
    expect(promotionRequestsContract.id).toBe(PROMOTION_SOURCE_ID);
    expect(promotionSubjectAdapters.map((a) => a.subjectType).sort()).toEqual(["artifact", "memory"]);
  });

  it("the memory subject ships NO source file of its own — only a backend", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(join(here, ".."))
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    // A backend, not a source: there is no `memory-*.contract.ts`, and the
    // registry row for this subject lives in promotion-subjects.ts.
    expect(files).toContain("memory-promotion.ts");
    expect(files.filter((f) => f.startsWith("memory") && f.includes("contract"))).toEqual([]);
  });

  it("adds no route under src/app for approvals or promotion", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const appDir = join(here, "..", "..", "..", "..", "app");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (entry === "page.tsx" || entry === "route.ts") out.push(full);
      }
      return out;
    };
    const routes = walk(appDir).map((p) => p.slice(appDir.length));
    // The ONE approvals-named route in the tree PREDATES this issue: the
    // agent-creation-request detail page, owned by that source. Pinned exactly,
    // so a promotion route added here would show up as a new entry rather than
    // hide behind a loose "some approvals routes exist" assertion.
    expect(routes.filter((r) => /approval/i.test(r))).toEqual([
      "/configuration/agents/approvals/[id]/page.tsx",
    ]);
    expect(routes.filter((r) => /promotion/i.test(r))).toEqual([]);
    // The memory server action is an action module, deliberately NOT a route.
    expect(routes.filter((r) => r.startsWith("/memory/"))).toEqual([]);
  });
});

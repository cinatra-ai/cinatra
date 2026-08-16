/**
 * PER-PRODUCER fixtures for the APPROVALS half of the aligned-affordances sweep
 * (cinatra#2701 change 2, epic #2699 S2).
 *
 * `/notifications` is the member-facing feed. It renders two link species that
 * can point into `/configuration`:
 *
 *   • an APPROVAL row's `href` (the source sets the approval-detail route on
 *     every row, including the author's own);
 *   • a NOTIFICATION row's `href` — the persisted author notification a decision
 *     writes, whose rows already exist in the database from before the epic.
 *
 * Both are suppressed HERE, on the way into the view-model, which is the only
 * place the feed is built (server first paint and client "load more" both land
 * in `loadFeedWindow`). Suppressing at render is what covers the pre-existing
 * rows: the stored href is deliberately left alone in the database.
 *
 * The actions menu (`AgentDecisionActions`) is pinned by source below: it is a
 * client component and the repo carries no RTL at root.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AppNotification } from "@cinatra-ai/notifications/types";
import type { UnifiedFeedItem } from "@/lib/approvals/unified-feed";

import { buildFeedRowVMs } from "../feed-view-model";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

const APPROVAL_HREF = "/configuration/agents/approvals/a-1";

/** The row an approval source emits — href set on every row, author's included. */
function approvalItem(href: string | undefined): UnifiedFeedItem {
  return {
    kind: "approval",
    createdAt: "2026-05-15T06:00:00.000Z",
    sourceKey: "agent-creation-requests",
    id: "a-1",
    approval: {
      row: {
        id: "a-1",
        sourceId: "agent-creation-requests",
        title: "Web Research Agent",
        status: "proposed",
        createdAt: "2026-05-15T06:00:00.000Z",
        version: "cas-1",
        ...(href ? { href } : {}),
      },
      direction: "inbox",
    },
  };
}

/** A notification row PERSISTED BEFORE this epic, still carrying its href. */
function preExistingAuthorNotification(): UnifiedFeedItem {
  const notification: AppNotification = {
    id: "n-legacy",
    title: "Agent proposal approved",
    body: "Your agent creation request '@acme/web-research' was approved.",
    kind: "success",
    createdAt: "2026-04-01T09:00:00.000Z",
    href: APPROVAL_HREF,
  };
  return {
    kind: "notification",
    createdAt: notification.createdAt,
    sourceKey: "notifications",
    id: notification.id,
    notification,
  };
}

describe("cinatra#2701 — the feed withholds /configuration hrefs from a non-admin", () => {
  it("an APPROVAL row loses its href for a non-admin viewer", () => {
    const [vm] = buildFeedRowVMs([approvalItem(APPROVAL_HREF)], false);
    expect(vm.kind).toBe("approval");
    if (vm.kind === "approval") expect(vm.approval.href).toBeUndefined();
  });

  it("an APPROVAL row keeps its href, byte-identical, for an admin viewer", () => {
    const [vm] = buildFeedRowVMs([approvalItem(APPROVAL_HREF)], true);
    if (vm.kind === "approval") expect(vm.approval.href).toBe(APPROVAL_HREF);
  });

  it("nothing else about the approval row changes for a non-admin", () => {
    const [member] = buildFeedRowVMs([approvalItem(APPROVAL_HREF)], false);
    const [admin] = buildFeedRowVMs([approvalItem(APPROVAL_HREF)], true);
    if (member.kind === "approval" && admin.kind === "approval") {
      const { href: _mh, ...memberRest } = member.approval;
      const { href: _ah, ...adminRest } = admin.approval;
      expect(memberRest).toEqual(adminRest);
    }
  });

  it("a PRE-EXISTING author notification renders WITHOUT a dead link for its non-admin recipient", () => {
    const item = preExistingAuthorNotification();
    const [vm] = buildFeedRowVMs([item], false);
    expect(vm.kind).toBe("notification");
    if (vm.kind === "notification") {
      expect(vm.notification.href).toBeUndefined();
      // The message itself is untouched — the author still learns the outcome.
      expect(vm.notification.title).toBe("Agent proposal approved");
      expect(vm.notification.body).toContain("was approved");
    }
    // The STORED row is not mutated — suppression is a render-time act.
    expect(item.notification?.href).toBe(APPROVAL_HREF);
  });

  it("the same pre-existing row keeps its link for an admin recipient", () => {
    const [vm] = buildFeedRowVMs([preExistingAuthorNotification()], true);
    if (vm.kind === "notification") expect(vm.notification.href).toBe(APPROVAL_HREF);
  });

  it("a NON-configuration href is never touched, for either viewer", () => {
    for (const isAdmin of [false, true]) {
      const [vm] = buildFeedRowVMs([approvalItem("/artifacts/obj_1")], isAdmin);
      if (vm.kind === "approval") expect(vm.approval.href).toBe("/artifacts/obj_1");
    }
  });

  it("the argument is fail-closed: omitting it suppresses rather than leaks", () => {
    const [vm] = buildFeedRowVMs([approvalItem(APPROVAL_HREF)]);
    if (vm.kind === "approval") expect(vm.approval.href).toBeUndefined();
  });

  it("no rendered view-model of a non-admin feed mentions /configuration anywhere", () => {
    const vms = buildFeedRowVMs(
      [approvalItem(APPROVAL_HREF), preExistingAuthorNotification()],
      false,
    );
    expect(JSON.stringify(vms)).not.toContain("/configuration");
  });
});

describe("cinatra#2701 — the feed's only view-model build is viewer-scoped", () => {
  it("loadFeedWindow passes the viewer's admin standing into the mapper", () => {
    expect(read("src/app/notifications/feed-window.ts")).toMatch(
      /buildFeedRowVMs\(raw, viewer\.isAdmin\)/,
    );
  });
});

describe("cinatra#2701 — the approvals ACTIONS MENU renders no Details link without an href", () => {
  const src = read("src/lib/approvals/agent-decision-actions.tsx");

  it("detailsHref is optional", () => {
    expect(src).toMatch(/detailsHref\?: string;/);
  });

  it("the Details link is conditional on it", () => {
    expect(src).toMatch(/\{detailsHref \? \(\s*\n\s*<Link/);
  });

  it("the feed's inline actions pass the row href through, with NO substitute destination", () => {
    const inline = read("src/app/notifications/approval-inline-actions.tsx");
    expect(inline).toMatch(/detailsHref=\{href\}/);
    expect(inline).not.toMatch(/detailsHref=\{href \?\? "\/notifications"\}/);
  });
});

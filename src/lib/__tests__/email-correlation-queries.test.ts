// cinatra#1456 — email correlation query seam VIEW-ASSEMBLY logic.
//
// Unit-level: mocks createSessionObjectsClient so no DB is touched. Proves each
// view (thread / campaign / contact) reads the CORRECT object types with the
// CORRECT allow-listed `dataEquals` filter (routed through the CANONICAL
// objects_list, so per-row object.read authz applies — verified by the fact the
// seam calls createSessionObjectsClient(actor).list, never listObjectsByFilter
// directly), assembles the records, surfaces the truncated flag, scopes the
// contact view by (connectorId, contactId), and short-circuits an empty thread
// key. The real indexed SQL those filters compile to is proven on real Postgres
// in src/lib/__tests__/integration/email-correlation-query-seam.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

type ListCall = { type?: string; dataEquals?: unknown; limit?: number };
const listCalls: ListCall[] = [];
// Per (type) canned rows; the fake list returns rows whose type matches.
let rowsByType: Record<string, Array<{ id: string; type: string; data: Record<string, unknown>; createdAt: string }>> = {};

vi.mock("@cinatra-ai/objects", () => ({
  createSessionObjectsClient: () => ({
    list: async (inp: ListCall) => {
      listCalls.push(inp);
      const items = rowsByType[inp.type ?? ""] ?? [];
      return { items, nextCursor: null };
    },
  }),
}));

import {
  getEmailThreadView,
  getCampaignEmailView,
  getContactEmailView,
  deriveThreadId,
} from "@/lib/email-correlation-queries";
import type { ActorContext } from "@/lib/authz/actor-context";

const actor = { principalType: "HumanUser", principalId: "u1", organizationId: "org-1", authSource: "ui", policyVersion: "v2" } as ActorContext;
const SENT = "@cinatra-ai/email:sent-email";
const REPLY = "@cinatra-ai/email:received-reply";
const RECIPIENT = "@cinatra-ai/email:recipient";
const BODY = "@cinatra-ai/email:body";

function row(id: string, type: string, data: Record<string, unknown> = {}) {
  return { id, type, data, createdAt: "2026-07-20T00:00:00Z" };
}

beforeEach(() => {
  listCalls.length = 0;
  rowsByType = {};
});

function callFor(type: string): ListCall | undefined {
  return listCalls.find((c) => c.type === type);
}

describe("getEmailThreadView", () => {
  it("reads sent-email + received-reply filtered by the derived threadId, assembles both", async () => {
    rowsByType[SENT] = [row("s1", SENT, { threadId: "conn-a:pt-9" })];
    rowsByType[REPLY] = [row("r1", REPLY, { threadId: "conn-a:pt-9" })];
    const view = await getEmailThreadView({ actor, connectorId: "conn-a", providerThreadId: "pt-9" });
    expect(view.threadId).toBe("conn-a:pt-9");
    expect(view.sends.records.map((r) => r.id)).toEqual(["s1"]);
    expect(view.replies.records.map((r) => r.id)).toEqual(["r1"]);
    expect(callFor(SENT)?.dataEquals).toEqual([{ key: "threadId", value: "conn-a:pt-9" }]);
    expect(callFor(REPLY)?.dataEquals).toEqual([{ key: "threadId", value: "conn-a:pt-9" }]);
  });

  it("short-circuits to an empty view (no list call) when the provider thread id is blank", async () => {
    const view = await getEmailThreadView({ actor, connectorId: "conn-a", providerThreadId: "   " });
    expect(view.threadId).toBe("");
    expect(view.sends.records).toHaveLength(0);
    expect(view.replies.records).toHaveLength(0);
    expect(listCalls).toHaveLength(0);
  });
});

describe("getCampaignEmailView", () => {
  it("reads sends + replies + recipients + bodies filtered by campaignId", async () => {
    rowsByType[SENT] = [row("s1", SENT)];
    rowsByType[REPLY] = [row("r1", REPLY)];
    rowsByType[RECIPIENT] = [row("rc1", RECIPIENT)];
    rowsByType[BODY] = [row("b1", BODY)];
    const view = await getCampaignEmailView({ actor, campaignId: "camp-1" });
    expect(view.sends.records.map((r) => r.id)).toEqual(["s1"]);
    expect(view.replies.records.map((r) => r.id)).toEqual(["r1"]);
    expect(view.recipients.records.map((r) => r.id)).toEqual(["rc1"]);
    expect(view.bodies.records.map((r) => r.id)).toEqual(["b1"]);
    for (const t of [SENT, REPLY, RECIPIENT, BODY]) {
      expect(callFor(t)?.dataEquals).toEqual([{ key: "campaignId", value: "camp-1" }]);
    }
  });
});

describe("getContactEmailView", () => {
  it("scopes by the (connectorId, contactId) PAIR — connector-scoped, not a bare contactId", async () => {
    rowsByType[SENT] = [row("s1", SENT)];
    rowsByType[REPLY] = [];
    const view = await getContactEmailView({ actor, connectorId: "conn-a", contactId: "c-77" });
    expect(view.sends.records.map((r) => r.id)).toEqual(["s1"]);
    expect(callFor(SENT)?.dataEquals).toEqual([
      { key: "connectorId", value: "conn-a" },
      { key: "contactId", value: "c-77" },
    ]);
  });
});

describe("truncated flag", () => {
  it("is true only when a list hits the 500-row page budget", async () => {
    rowsByType[SENT] = Array.from({ length: 500 }, (_v, i) => row(`s${i}`, SENT));
    rowsByType[REPLY] = [row("r1", REPLY)];
    const view = await getEmailThreadView({ actor, connectorId: "conn-a", providerThreadId: "pt-9" });
    expect(view.sends.truncated).toBe(true);
    expect(view.replies.truncated).toBe(false);
    expect(callFor(SENT)?.limit).toBe(500);
  });
});

describe("deriveThreadId (shared writer/reader key)", () => {
  it("joins connectorId + providerThreadId; undefined for a blank thread id", () => {
    expect(deriveThreadId("conn-a", "pt-9")).toBe("conn-a:pt-9");
    expect(deriveThreadId("conn-a", "  ")).toBeUndefined();
    expect(deriveThreadId("conn-a", undefined)).toBeUndefined();
  });
});

/**
 * cinatra#3089 — which run made a bundle is the provenance the host recorded,
 * never the bundle's own data.
 *
 * A send that holds no released list mails the bundle's text only when no run
 * that made the bundles filed bodies for review. Those runs are the run of the
 * call (the server's context) and the runs the host RECORDED as writers of the
 * two referenced objects (`readObjectRuns`); a run id written into a bundle's
 * data (`cinatraAgentRunId`, which `objects_save` keeps as the caller sent it)
 * decides nothing.
 *
 * Cases:
 *   V1 a call without a run, whose bundle's data names no run but whose
 *      recorded writer run filed bodies, is refused before any mail
 *   V2 a run id in the bundle's data is never looked up; the recorded runs are
 *   V3 objects no run ever wrote, on a call without a run: the reference-only
 *      send mails the bundle as before
 *   V4 recorded runs that cannot be read refuse the send
 *   V5 the shipped reader: the object's row run and every run its append-only
 *      change history records, read in the actor's organization; an object the
 *      actor cannot read is refused
 *   V6 the check stops at the first run that filed (the call's run first)
 *   V7 more runs than the cap refuse the send with a fixed code
 *   V8 the filings read in all are capped; a normal campaign is unaffected
 *   V9 a writer read's thrown store text is not passed on
 */
import { describe, expect, it, vi } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

const { objectRows, eventQueries } = vi.hoisted(() => ({
  objectRows: new Map<string, { runId: string | null }>(),
  eventQueries: [] as Array<{ text: string; values: unknown[] }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/postgres-config", () => ({ getPostgresConnectionString: () => "postgres://test", postgresSchema: "public" }));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/objects-store", () => ({
  getObjectById: (id: string, scope: { orgId: string }) =>
    scope.orgId === "org-1" && objectRows.has(id) ? { id, type: "t", data: {}, runId: objectRows.get(id)!.runId } : null,
}));
vi.mock("@/lib/postgres-async", () => ({
  runPostgresQueriesAsync: async ({ queries }: { queries: Array<{ text: string; values: unknown[] }> }) => {
    eventQueries.push(...queries);
    const [q] = queries;
    const objectId = q!.values[1] as string;
    const rows = objectId === "bundle-a" && q!.values[0] === "org-1" ? [{ run_id: "run-7" }, { run_id: "run-8" }] : [];
    return [{ rows }];
  },
}));

import {
  createTriggerEmailSendUseCases,
  type TriggerEmailSendDeps,
} from "../trigger-email-send-use-cases";

const actor: PrimitiveActorContext = { actorType: "human", source: "route", userId: "user-1", sessionId: "s-1", orgId: "org-1" };

function fixture(opts: { bundleData?: Record<string, unknown>; objectRuns?: Record<string, string[]> | "fails"; filed?: string[]; callRun?: string; historyError?: string }) {
  const sent: string[] = [];
  const asked: string[] = [];
  const caps: number[] = [];
  const objectsRead: string[] = [];
  const envelopes: Record<string, { id: string; data: unknown }> = {
    "bundle-a": { id: "bundle-a", data: { ...(opts.bundleData ?? {}), drafts: [{ recipientId: "c1", recipientEmail: "p1@example.com", subject: "S", body: "Bundle text" }] } },
    "list-a": { id: "list-a", data: { confirmedRecipients: [{ contactId: "c1", email: "p1@example.com" }] } },
  };
  const deps = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail: async (m: { to: string[] }) => {
      sent.push(m.to[0]!);
      return { providerId: "p", providerMessageId: "m", sentAt: "2026-11-25T00:00:00Z" };
    },
    getObjectByRef: async (ref: string) => envelopes[ref] ?? null,
    emitEmailFanout: async () => ({ bodies: [], skipped: { bodies: false } }),
    readCallingRun: async () => (opts.callRun ? { runId: opts.callRun } : null),
    readPublishDecision: async () => null,
    readRunReviewedBodies: async (runId: string, _actor: unknown, cap: number) => {
      asked.push(runId);
      caps.push(cap);
      return (opts.filed ?? []).includes(runId);
    },
    readObjectRuns: async (objectId: string) => {
      objectsRead.push(objectId);
      if (opts.historyError) throw new Error(opts.historyError);
      if (opts.objectRuns === "fails") throw new Error("the history could not be read");
      return opts.objectRuns?.[objectId] ?? [];
    },
  } as unknown as TriggerEmailSendDeps;
  const start = () =>
    createTriggerEmailSendUseCases(deps).startInitialSend(
      { serviceId: "s", campaignId: "camp-1", approvedDraftBundleRef: "bundle-a", confirmedRecipientsRef: "list-a" } as never,
      actor,
    ) as unknown as Promise<{ status: string; errorMessage?: string }>;
  return { sent, asked, caps, objectsRead, start };
}

describe("cinatra#3089 — the runs that made a bundle are the recorded ones", () => {
  it("V1 a bundle whose data names no run, but whose recorded writer run filed bodies, is refused", async () => {
    const f = fixture({ objectRuns: { "bundle-a": ["run-reviewed"] }, filed: ["run-reviewed"] });
    const result = await f.start();
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("run run-reviewed filed artifacts for review");
    expect(f.sent).toEqual([]);
  });

  it("V2 a run id in the bundle's data is never looked up; the recorded runs are", async () => {
    const f = fixture({ bundleData: { cinatraAgentRunId: "run-claimed" }, objectRuns: { "bundle-a": ["run-real"], "list-a": ["run-list"] } });
    await f.start();
    expect(f.asked).toEqual(["run-real", "run-list"]);
  });

  it("V3 objects no run ever wrote, on a call without a run, are mailed as before", async () => {
    const f = fixture({});
    const result = await f.start();
    expect(result.status).toBe("completed");
    expect(f.sent).toEqual(["p1@example.com"]);
    expect(f.asked).toEqual([]);
  });

  it("V4 recorded runs that cannot be read refuse the send", async () => {
    const f = fixture({ objectRuns: "fails" });
    const result = await f.start();
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("which runs wrote object bundle-a could not be read");
    expect(f.sent).toEqual([]);
  });

  it("V6 the check stops at the first run that filed: a call whose own run filed reads no writer of the bundles", async () => {
    const f = fixture({ callRun: "run-call", filed: ["run-call"], objectRuns: { "bundle-a": ["run-7", "run-8"] } });
    const result = await f.start();
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("run run-call filed artifacts for review");
    expect(f.asked).toEqual(["run-call"]);
    expect(f.objectsRead).toEqual([]);
    expect(f.sent).toEqual([]);
    // Among the writers too: the first that filed ends the check.
    const g = fixture({ objectRuns: { "bundle-a": ["run-1", "run-2", "run-3"] }, filed: ["run-1"] });
    expect((await g.start()).status).toBe("failed");
    expect(g.asked).toEqual(["run-1"]);
  });

  it("V7 more runs than one send looks up refuse the send with a fixed code, never read as 'nothing filed'", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `run-${String(i).padStart(2, "0")}`);
    const f = fixture({ objectRuns: { "bundle-a": many } });
    const result = await f.start();
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("(provenance_over_cap)");
    expect(f.asked).toEqual([]);
    expect(f.sent).toEqual([]);
    // With the call's run counted, 20 writers are one too many as well.
    const g = fixture({ callRun: "run-call", objectRuns: { "bundle-a": many.slice(0, 20) } });
    expect((await g.start()).errorMessage).toContain("(provenance_over_cap)");
    expect(g.asked).toEqual(["run-call"]);
    expect(g.sent).toEqual([]);
  });

  it("V8 the filings read in all are capped: a normal campaign keeps 200 per run, many writers share the rest", async () => {
    const normal = fixture({ callRun: "run-call", objectRuns: { "bundle-a": ["run-call", "run-w1"], "list-a": ["run-w2"] } });
    expect((await normal.start()).status).toBe("completed");
    expect(normal.asked).toEqual(["run-call", "run-w1", "run-w2"]);
    expect(normal.caps).toEqual([200, 200, 200]);
    expect(normal.sent).toEqual(["p1@example.com"]);
    const writers = Array.from({ length: 19 }, (_, i) => `run-w${i}`);
    const wide = fixture({ callRun: "run-call", objectRuns: { "bundle-a": writers } });
    expect((await wide.start()).status).toBe("completed");
    expect(wide.asked).toHaveLength(20);
    expect(wide.caps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(600);
    expect(wide.caps.slice(1).every((c) => c === Math.floor(400 / 19))).toBe(true);
  });

  it("V9 a writer read's thrown text (a store error) is not passed on", async () => {
    const f = fixture({ historyError: "connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432/app" });
    const result = await f.start();
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("which runs wrote object bundle-a could not be read (writer_runs_unreadable)");
    expect(result.errorMessage).not.toContain("postgres://");
    expect(result.errorMessage).not.toContain("hunter2");
    expect(f.sent).toEqual([]);
  });

  it("V5 the shipped reader answers the row run and every recorded history run, in the actor's organization", async () => {
    const { listObjectWriterRunIds } = await import("../artifacts/current-decided-revision-read");
    objectRows.set("bundle-a", { runId: "run-9" });
    objectRows.set("bundle-b", { runId: null });
    const kernelActor = { principalId: "user-1", organizationId: "org-1" } as never;
    expect(await listObjectWriterRunIds({ actor: kernelActor, orgId: "org-1", objectId: "bundle-a" })).toEqual(["run-7", "run-8", "run-9"]);
    expect(await listObjectWriterRunIds({ actor: kernelActor, orgId: "org-1", objectId: "bundle-b" })).toEqual([]);
    const history = eventQueries.at(-1)!;
    expect(history.text).toMatch(/FROM "public"\."object_change_event"/);
    expect(history.text).toMatch(/org_id = \$1 AND object_id = \$2/);
    expect(history.values.slice(0, 2)).toEqual(["org-1", "bundle-b"]);
    // Another organization, or an object the actor cannot read: refused.
    await expect(listObjectWriterRunIds({ actor: kernelActor, orgId: "org-2", objectId: "bundle-a" })).rejects.toThrow(/cannot read object bundle-a/);
  });
});

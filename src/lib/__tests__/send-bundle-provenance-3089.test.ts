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

function fixture(opts: { bundleData?: Record<string, unknown>; objectRuns?: Record<string, string[]> | "fails"; filed?: string[] }) {
  const sent: string[] = [];
  const asked: string[] = [];
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
    readCallingRun: async () => null,
    readPublishDecision: async () => null,
    readRunReviewedBodies: async (runId: string) => {
      asked.push(runId);
      return (opts.filed ?? []).includes(runId);
    },
    readObjectRuns: async (objectId: string) => {
      if (opts.objectRuns === "fails") throw new Error("the history could not be read");
      return opts.objectRuns?.[objectId] ?? [];
    },
  } as unknown as TriggerEmailSendDeps;
  const start = () =>
    createTriggerEmailSendUseCases(deps).startInitialSend(
      { serviceId: "s", campaignId: "camp-1", approvedDraftBundleRef: "bundle-a", confirmedRecipientsRef: "list-a" } as never,
      actor,
    ) as unknown as Promise<{ status: string; errorMessage?: string }>;
  return { sent, asked, start };
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

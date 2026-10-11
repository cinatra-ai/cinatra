/**
 * cinatra#3089 (lifecycle-d W1) — the email fan-out's body write on the
 * ledgered writer, driven through the fan-out's own seams.
 *
 * `materializeEmailFanout` takes its body writer as an injected `writeBody`
 * (production wires it to the materialization ledger); the fake below models
 * the ledger's claim key — (run, message identity, extension, content hash) —
 * and the mid-run filing a drafting step may already have made, so a retry and
 * a pre-filed body are both observable without a database. The send boundary
 * (`startInitialSend`) is driven through its own `emitEmailFanout` seam built
 * from the real `materializeEmailFanout`, never a stub of the code under test.
 *
 * Cases (the acceptance list of this leg):
 *   A1 a fan-out over N draft items writes N body revisions through the
 *      ledgered writer on the fan-out's own path, each keyed by the message
 *      identity and the content hash
 *   A3 a retried fan-out over the same drafts writes nothing new and returns
 *      the same artifact ids
 *   B1 a fan-out over a body already filed under the same identity key returns
 *      that artifact and writes no second one
 *   C1 the body text lands under bodyMarkdown and no undeclared body key is
 *      written
 *   C2 a body row the claim's contract refuses fails the send visibly with the
 *      refusal named, never a warning and a continued send
 *   D1 the fan-out writes no row for any draft outside the current send and
 *      rewrites no existing row or association
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  createTriggerEmailSendUseCases,
  materializeEmailFanout,
  emailBodyExternalId,
  EMAIL_BODY_TYPE_ID,
  EMAIL_RECIPIENT_TYPE_ID,
  type EmailFanoutArgs,
  type EmailFanoutSaveFn,
} from "../trigger-email-send-use-cases";

const EXT = "@cinatra-ai/email-artifacts";
const ALL_TYPES = new Set([EMAIL_BODY_TYPE_ID, EMAIL_RECIPIENT_TYPE_ID]);
const DECLARED_BODY_KEYS = new Set(["runId", "campaignId", "subject", "bodyMarkdown", "contactId"]);

const actor: PrimitiveActorContext = {
  actorType: "human",
  source: "route",
  userId: "user-1",
  sessionId: "sess-1",
  orgId: "org-1",
};

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

type BodyWrite = {
  runId: string;
  outputId: string;
  title: string;
  markdown: string;
  typedData: Record<string, unknown>;
};

/**
 * The objects store the RECIPIENT half still writes through (and where the
 * historical raw body rows of earlier sends live), plus a ledger-keyed body
 * writer: one artifact per (run, outputId, extension, content hash); a
 * finalized mid-run row of the same run + extension + content hash (the
 * drafting step's own filing) is reused before any claim.
 */
function makeFixture() {
  const rows = new Map<string, { id: string; type: string; data: Record<string, unknown> }>();
  const associations = new Map<string, { from: string; to: string }>();
  const saveCalls: Array<{ typeHint: string; rawData: Record<string, unknown> }> = [];
  let seq = 0;
  const save: EmailFanoutSaveFn = async ({ rawData, typeHint }) => {
    saveCalls.push({ typeHint, rawData });
    const key = `${typeHint}::external:${String(rawData.externalId ?? "").toLowerCase()}`;
    const existing = rows.get(key);
    if (existing) {
      existing.data = rawData;
      return { objectId: existing.id, type: typeHint, isNew: false, wasMerged: true };
    }
    seq += 1;
    const row = { id: `obj-${seq}`, type: typeHint, data: rawData };
    rows.set(key, row);
    return { objectId: row.id, type: typeHint, isNew: true, wasMerged: false };
  };

  const ledger = new Map<string, { artifactId: string; path: string }>();
  const midRun = new Map<string, { artifactId: string }>();
  const bodyWrites: BodyWrite[] = [];
  let artifacts = 0;
  const writeBody = vi.fn(async (w: BodyWrite) => {
    bodyWrites.push(w);
    const hash = sha256(w.markdown);
    const prefiled = midRun.get(`${w.runId}|${EXT}|${hash}`);
    if (prefiled) {
      return { ok: true as const, artifactId: prefiled.artifactId, representationRevisionId: `${prefiled.artifactId}-rev`, deduped: true };
    }
    const key = `${w.runId}|${w.outputId}|${EXT}|${hash}`;
    const hit = ledger.get(key);
    if (hit) {
      return { ok: true as const, artifactId: hit.artifactId, representationRevisionId: `${hit.artifactId}-rev`, deduped: true };
    }
    artifacts += 1;
    const artifactId = `art-${artifacts}`;
    ledger.set(key, { artifactId, path: "email_fanout" });
    return { ok: true as const, artifactId, representationRevisionId: `${artifactId}-rev`, deduped: false };
  });
  return {
    rows,
    associations,
    saveCalls,
    save,
    ledger,
    midRun,
    bodyWrites,
    writeBody,
    created: () => artifacts,
  };
}

const twoDrafts = [
  { id: "d1", contactId: "c1", subject: "Hello One", body: "Body one", step: 1 },
  { id: "d2", contactId: "c2", subject: "Hello Two", body: "Body two", step: 1 },
];
const twoRecipients = [
  { contactId: "c1", email: "one@example.com", name: "One" },
  { contactId: "c2", email: "two@example.com", name: "Two" },
];
const input = { runScopeId: "run-1", campaignId: "camp-1", drafts: twoDrafts, recipients: twoRecipients };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cinatra#3089 — the fan-out's body write on the ledgered writer", () => {
  it("A1 a fan-out over N draft items writes N body revisions through the ledgered writer on the fan-out's own path, each keyed by the message identity and the content hash", async () => {
    const fx = makeFixture();
    const result = await materializeEmailFanout(input, {
      save: fx.save,
      writeBody: fx.writeBody,
      registeredTypes: ALL_TYPES,
    });

    expect(fx.writeBody).toHaveBeenCalledTimes(2);
    expect(fx.bodyWrites.map((w) => w.outputId)).toEqual([
      emailBodyExternalId("run-1", "d1"),
      emailBodyExternalId("run-1", "d2"),
    ]);
    expect(fx.bodyWrites.map((w) => w.runId)).toEqual(["run-1", "run-1"]);
    expect([...fx.ledger.keys()]).toEqual([
      `run-1|${emailBodyExternalId("run-1", "d1")}|${EXT}|${sha256("Body one")}`,
      `run-1|${emailBodyExternalId("run-1", "d2")}|${EXT}|${sha256("Body two")}`,
    ]);
    expect([...fx.ledger.values()].every((r) => r.path === "email_fanout")).toBe(true);
    // No body goes through the raw objects save any more.
    expect(fx.saveCalls.filter((c) => c.typeHint === EMAIL_BODY_TYPE_ID)).toHaveLength(0);
    expect(result.bodies.map((b) => b.objectId)).toEqual(["art-1", "art-2"]);
    expect(result.bodies.every((b) => b.isNew)).toBe(true);
    expect(result.bodies.map((b) => b.externalId)).toEqual([
      emailBodyExternalId("run-1", "d1"),
      emailBodyExternalId("run-1", "d2"),
    ]);
    // The recipient half is left exactly as it was: one raw record per recipient.
    expect(fx.saveCalls.filter((c) => c.typeHint === EMAIL_RECIPIENT_TYPE_ID)).toHaveLength(2);
  });

  it("A3 a retried fan-out over the same drafts writes nothing new and returns the same artifact ids", async () => {
    const fx = makeFixture();
    const deps = { save: fx.save, writeBody: fx.writeBody, registeredTypes: ALL_TYPES };
    const first = await materializeEmailFanout(input, deps);
    const second = await materializeEmailFanout(input, deps);

    expect(fx.created()).toBe(2);
    expect(fx.ledger.size).toBe(2);
    expect(second.bodies.map((b) => b.objectId)).toEqual(first.bodies.map((b) => b.objectId));
    expect(first.bodies.map((b) => b.objectId)).toEqual(["art-1", "art-2"]);
    expect(second.bodies.every((b) => !b.isNew)).toBe(true);
  });

  it("B1 a fan-out over a body already filed under the same identity key returns that artifact and writes no second one", async () => {
    const fx = makeFixture();
    // The drafting step filed d1's body mid-run (same run, extension, bytes).
    fx.midRun.set(`run-1|${EXT}|${sha256("Body one")}`, { artifactId: "prefiled-1" });
    const deps = { save: fx.save, writeBody: fx.writeBody, registeredTypes: ALL_TYPES };

    const first = await materializeEmailFanout(input, deps);
    const second = await materializeEmailFanout(input, deps);

    expect(first.bodies[0]).toMatchObject({ objectId: "prefiled-1", isNew: false });
    expect(second.bodies[0]).toMatchObject({ objectId: "prefiled-1", isNew: false });
    // Only d2 was ever written — one artifact per message across both runs.
    expect(fx.created()).toBe(1);
    expect(second.bodies.map((b) => b.objectId)).toEqual(first.bodies.map((b) => b.objectId));
  });

  it("C1 the body text lands under bodyMarkdown and no undeclared body key is written", async () => {
    const fx = makeFixture();
    await materializeEmailFanout(input, {
      save: fx.save,
      writeBody: fx.writeBody,
      registeredTypes: ALL_TYPES,
    });

    expect(fx.bodyWrites).toHaveLength(2);
    for (const [i, w] of fx.bodyWrites.entries()) {
      expect(w.markdown).toBe(twoDrafts[i].body);
      expect(w.typedData.bodyMarkdown).toBe(twoDrafts[i].body);
      for (const key of Object.keys(w.typedData)) {
        expect(DECLARED_BODY_KEYS.has(key)).toBe(true);
      }
      for (const undeclared of ["body", "externalId", "draftItemId", "step", "email", "recipientEmail"]) {
        expect(w.typedData).not.toHaveProperty(undeclared);
      }
    }
    expect(fx.bodyWrites[0].typedData).toEqual({
      runId: "run-1",
      campaignId: "camp-1",
      subject: "Hello One",
      bodyMarkdown: "Body one",
      contactId: "c1",
    });
  });

  it("C2 a body row the claim's contract refuses fails the send visibly with the refusal named, never a warning and a continued send", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fx = makeFixture();
    const refusal = 'object type "@cinatra-ai/email:body" refused the payload: bodyMarkdown must be a string';
    const refusingWriter = vi.fn(async () => ({ ok: false as const, error: refusal }));
    const sendEmail = vi.fn().mockResolvedValue({
      providerId: "gmail",
      providerMessageId: "m1",
      sentAt: new Date().toISOString(),
    });
    const emitEmailFanout = (args: EmailFanoutArgs) =>
      materializeEmailFanout(args, {
        save: fx.save,
        writeBody: refusingWriter,
        registeredTypes: ALL_TYPES,
      });
    const bundles: Record<string, { id: string; type: string; data: unknown }> = {
      "draft-ref": {
        id: "draft-ref",
        type: "@cinatra-ai/campaigns:email-draft-bundle",
        data: { cinatraAgentRunId: "run-42", drafts: twoDrafts },
      },
      "recip-ref": {
        id: "recip-ref",
        type: "@cinatra-ai/campaigns:recipients",
        data: { confirmedRecipients: twoRecipients },
      },
    };
    const uc = createTriggerEmailSendUseCases({
      getCampaign: vi.fn().mockResolvedValue(null),
      getDraftsByIds: vi.fn().mockResolvedValue([]),
      sendEmail: sendEmail as never,
      getObjectByRef: (async (ref: string) => bundles[ref] ?? null) as never,
      emitEmailFanout,
    });

    const result = await uc.startInitialSend(
      {
        serviceId: "s",
        campaignId: "camp-c2",
        approvedDraftBundleRef: "draft-ref",
        confirmedRecipientsRef: "recip-ref",
        senderEmail: "sender@cinatra.ai",
      } as never,
      actor,
    );

    expect(result).toMatchObject({ status: "failed", sentCount: 0 });
    expect(String((result as unknown as { errorMessage?: string }).errorMessage)).toContain(refusal);
    expect(sendEmail).not.toHaveBeenCalled();
    const fanoutWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes("per-email artifact fan-out failed"),
    );
    expect(fanoutWarnings).toHaveLength(0);

    // A writer that throws is the same visible failure, never swallowed.
    const throwingUc = createTriggerEmailSendUseCases({
      getCampaign: vi.fn().mockResolvedValue(null),
      getDraftsByIds: vi.fn().mockResolvedValue([]),
      sendEmail: sendEmail as never,
      getObjectByRef: (async (ref: string) => bundles[ref] ?? null) as never,
      emitEmailFanout: (args: EmailFanoutArgs) =>
        materializeEmailFanout(args, {
          save: fx.save,
          writeBody: async () => {
            throw new Error("ledger unreachable");
          },
          registeredTypes: ALL_TYPES,
        }),
    });
    const thrown = await throwingUc.startInitialSend(
      {
        serviceId: "s",
        campaignId: "camp-c2b",
        approvedDraftBundleRef: "draft-ref",
        confirmedRecipientsRef: "recip-ref",
      } as never,
      actor,
    );
    expect(thrown).toMatchObject({ status: "failed", sentCount: 0 });
    expect(String((thrown as unknown as { errorMessage?: string }).errorMessage)).toContain("ledger unreachable");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("D1 the fan-out writes no row for any draft outside the current send and rewrites no existing row or association", async () => {
    const fx = makeFixture();
    // A historical raw body row of an earlier send and its association.
    const oldKey = `${EMAIL_BODY_TYPE_ID}::external:${emailBodyExternalId("run-old", "d0")}`;
    fx.rows.set(oldKey, {
      id: "obj-old",
      type: EMAIL_BODY_TYPE_ID,
      data: {
        externalId: emailBodyExternalId("run-old", "d0"),
        runId: "run-old",
        campaignId: "camp-1",
        draftItemId: "d0",
        subject: "Old",
        body: "Old raw body",
      },
    });
    fx.associations.set("assoc-old", { from: "obj-old", to: "contact-c0" });
    const rowsBefore = structuredClone([...fx.rows.entries()]);
    const assocBefore = structuredClone([...fx.associations.entries()]);

    await materializeEmailFanout(input, {
      save: fx.save,
      writeBody: fx.writeBody,
      registeredTypes: ALL_TYPES,
    });

    // The seeded historical rows are byte-identical; nothing was backfilled.
    expect([...fx.rows.entries()].filter(([k]) => k === oldKey)).toEqual(
      rowsBefore.filter(([k]) => k === oldKey),
    );
    expect([...fx.associations.entries()]).toEqual(assocBefore);
    expect(fx.saveCalls.filter((c) => c.typeHint === EMAIL_BODY_TYPE_ID)).toHaveLength(0);
    expect(fx.bodyWrites.map((w) => w.outputId)).toEqual([
      emailBodyExternalId("run-1", "d1"),
      emailBodyExternalId("run-1", "d2"),
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { EMAIL_BODY_TYPE_ID, materializeEmailFanout } from "@/lib/trigger-email-send-use-cases";

// cinatra#3089: given the approved body of each mailed draft, the fan-out
// writes no body. It binds each message to its approved revision, keyed by
// the approved body artifact, and files nothing for a draft without one.
const drafts = [
  { id: "d1", contactId: "c1", subject: "Hello One", body: "Bundle body one" },
  { id: "d2", contactId: "c2", subject: "Hello Two", body: "Bundle body two" },
  { id: "d3", contactId: "c3", subject: "Hello Three", body: "Bundle body three" },
];
const recipients = [
  { contactId: "c1", email: "one@example.com", name: "One" },
  { contactId: "c2", email: "two@example.com", name: "Two" },
  { contactId: "c3", email: "three@example.com", name: "Three" },
];
const approvedBodies = new Map([
  [0, { artifactId: "art-1", representationRevisionId: "rev-1", text: "Approved body one" }],
  [2, { artifactId: "art-3", representationRevisionId: "rev-3", text: "Approved body three" }],
]);
type Deps = Parameters<typeof materializeEmailFanout>[1];

describe("the email fan-out of the approved form", () => {
  it("binds each message to its approved revision and writes no body", async () => {
    const writes: unknown[] = [];
    const binds: unknown[] = [];
    const result = await materializeEmailFanout(
      { runScopeId: "run-1", campaignId: "camp-1", drafts, recipients, approvedBodies },
      {
        writeBody: async (w: unknown) => {
          writes.push(w);
          return { ok: true as const, artifactId: "x", representationRevisionId: "x", deduped: false };
        },
        bindBody: async (b: { artifactId: string; representationRevisionId: string }) => {
          binds.push(b);
          return { ok: true as const, artifactId: b.artifactId, representationRevisionId: b.representationRevisionId, deduped: false };
        },
        registeredTypes: new Set([EMAIL_BODY_TYPE_ID]),
      } as unknown as Deps,
    );
    expect(writes).toEqual([]);
    expect(binds).toEqual([
      { runId: "run-1", outputId: "email-body:run-1:art-1", markdown: "Approved body one", artifactId: "art-1", representationRevisionId: "rev-1" },
      { runId: "run-1", outputId: "email-body:run-1:art-3", markdown: "Approved body three", artifactId: "art-3", representationRevisionId: "rev-3" },
    ]);
    expect(result.bodies).toEqual([
      { typeId: EMAIL_BODY_TYPE_ID, externalId: "email-body:run-1:art-1", objectId: "art-1", isNew: false },
      { typeId: EMAIL_BODY_TYPE_ID, externalId: "email-body:run-1:art-3", objectId: "art-3", isNew: false },
    ]);
  });

  it("refuses a bind the binder refuses, a binder that throws (with a fixed reason), and a missing binder", async () => {
    const run = (bindBody: unknown) =>
      materializeEmailFanout(
        { runScopeId: "run-1", campaignId: "camp-1", drafts, recipients, approvedBodies },
        { bindBody, registeredTypes: new Set([EMAIL_BODY_TYPE_ID]) } as unknown as Deps,
      );
    // A refusal's text is not passed on either (the binder's store error lands in it): a fixed code.
    // red-first-expect: to throw error including 'the email body email-body:run-1:art-1
    const refused = run(async () => ({ ok: false, error: "already bound to rev-0" }));
    await expect(refused).rejects.toThrow("the email body email-body:run-1:art-1 was refused (bind_refused)");
    await expect(refused).rejects.not.toThrow("rev-0");
    const thrown = run(async () => {
      throw new Error("stored secret text");
    });
    await expect(thrown).rejects.toThrow("the email body email-body:run-1:art-1 could not be bound (bind_failed)");
    await expect(thrown).rejects.not.toThrow("stored secret text");
    await expect(run(undefined)).rejects.toThrow("the fan-out has no binder for approved bodies");
  });

  it("refuses approved bodies when the body type is not registered, binding nothing", async () => {
    const binds: unknown[] = [];
    await expect(
      materializeEmailFanout(
        { runScopeId: "run-1", campaignId: "camp-1", drafts, recipients, approvedBodies },
        {
          bindBody: async (b: unknown) => {
            binds.push(b);
            return { ok: true as const, artifactId: "x", representationRevisionId: "x", deduped: false };
          },
          registeredTypes: new Set(["@cinatra-ai/email:recipient"]),
        } as unknown as Deps,
      ),
    ).rejects.toThrow(`the object type ${EMAIL_BODY_TYPE_ID} is not registered, so no message can be bound to its approved body`);
    expect(binds).toEqual([]);
  });
});

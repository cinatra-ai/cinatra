import { describe, expect, it } from "vitest";

import { EMAIL_BODY_TYPE_ID, materializeEmailFanout } from "@/lib/trigger-email-send-use-cases";

// cinatra#3089 row 4, the recipient half: the delivery agent files one
// recipient record per confirmed recipient; the application's fan-out files
// the bodies only and writes no recipient record of its own.
const RECIPIENT_TYPE = "@cinatra-ai/email:recipient";

const drafts = [
  { id: "d1", contactId: "c1", subject: "Hello One", body: "Body one" },
  { id: "d2", contactId: "c2", subject: "Hello Two", body: "Body two" },
];
const recipients = [
  { contactId: "c1", email: "one@example.com", name: "One" },
  { contactId: "c2", email: "two@example.com", name: "Two" },
];

describe("the application's email fan-out after the delivery agent files recipients", () => {
  it("writes no recipient record even when the recipient type is registered", async () => {
    const saves: Array<{ typeHint?: string }> = [];
    const bodyWrites: unknown[] = [];
    const deps = {
      save: async (input: { typeHint?: string }) => {
        saves.push(input);
        return { objectId: `o-${saves.length}`, created: true };
      },
      writeBody: async (w: unknown) => {
        bodyWrites.push(w);
        return { ok: true as const, revisionId: `r-${bodyWrites.length}` };
      },
      registeredTypes: new Set([EMAIL_BODY_TYPE_ID, RECIPIENT_TYPE]),
    };
    await materializeEmailFanout(
      { runScopeId: "run-1", campaignId: "camp-1", drafts, recipients },
      deps as unknown as Parameters<typeof materializeEmailFanout>[1],
    );
    expect(saves.filter((s) => s.typeHint === RECIPIENT_TYPE)).toHaveLength(0);
    expect(bodyWrites).toHaveLength(2);
  });
});

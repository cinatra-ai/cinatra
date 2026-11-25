/**
 * The test-send plan (cinatra#4150) answers what a publish card shows: the From of every message and each selected
 * draft, in send order, as it was read.
 *
 * The deps are injected, so no database, connector or objects store is loaded.
 */
import { describe, expect, it, vi } from "vitest";
import { planTestSendSelection } from "../trigger-email-send-use-cases";

type Draft = { id: string; subject: string; body: string };

const D1: Draft = { id: "d1", subject: "Hello", body: "Hi {{first_name}}, a short note." };
const D2: Draft = { id: "d2", subject: "Follow", body: "Second draft body." };

function deps() {
  return {
    deps: {
      getCampaign: vi.fn(async () => ({ id: "c1", senderName: "Sales", senderEmail: "sales@example.com", draftIds: ["d1", "d2"] })),
      getDraftsByIds: vi.fn(async (ids: string[]) => [D1, D2].filter((d) => ids.includes(d.id))),
      sendEmail: vi.fn() as never,
    },
  };
}

describe("the plan names what the card shows", () => {
  it("answers the sender and every selected draft, in send order, as it was read", async () => {
    const { deps: d } = deps();
    const plan = await planTestSendSelection(
      { campaignId: "c1", recipientEmail: " tester@example.com ", selectionMode: "all_initial" },
      d,
    );
    expect(plan).toMatchObject({
      ok: true,
      recipientEmail: "tester@example.com",
      selectedDraftIds: ["d1", "d2"],
      sender: { email: "sales@example.com", name: "Sales" },
      selectedDrafts: [D1, D2],
    });
  });

  it("refuses at planning a recipient the send refuses: one rule, at most 320 characters with an @", async () => {
    const { deps: d } = deps();
    for (const recipientEmail of [`${"a".repeat(310)}@example.com`, "no-at-sign", "   "]) {
      expect(await planTestSendSelection({ campaignId: "c1", recipientEmail, selectionMode: "all_initial" }, d))
        .toEqual({ ok: false, reason: "invalid_recipient" });
    }
  });
});

// @vitest-environment jsdom
/**
 * cinatra#3470: a step declared with a "kind" screen of the recipients or the
 * drafts review is sent only the answer that screen stages (the server's check
 * is `isCampaignRecipientsReviewAnswer` / `isEmailDraftsReviewAnswer`, read in
 * `kindScreenAnswer`). This suite draws the host's own screens and reads
 * what they stage: that answer passes the server's check, and the host's
 * Continue is held until it is staged, so a Continue never sends the bare
 * approval marker the server refuses.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/review-kind-screen-answer-3470.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("@cinatra-ai/sdk-ui", () => ({ LoadingSpinner: () => null }));
vi.mock("@/lib/cinatra-toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("../email-outreach-stage-actions", () => ({
  fetchInitialDrafts: vi.fn(async () => ({ items: [], total: 0 })),
  fetchChildInterruptOutput: vi.fn(async () => null),
  updateInitialDraft: vi.fn(async () => undefined),
  checkEmailOutreachAsyncStatus: vi.fn(async () => ({ status: "idle" })),
  fetchCampaignRecipients: vi.fn(async () => ({ items: [], total: 0 })),
  confirmCampaignRecipients: vi.fn(async () => undefined),
  removeEmailOutreachRecipients: vi.fn(async () => undefined),
}));

import { CampaignRecipientsReviewRenderer } from "../campaign-recipients-review-renderer";
import { EmailDraftsReviewRenderer } from "../email-drafts-review-renderer";
import {
  isCampaignRecipientsReviewAnswer,
  isEmailDraftsReviewAnswer,
  readWayflowSubmittedValues,
} from "../hitl-gate-submit";
import { registerFieldRendererBindings } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";

const RECIPIENTS = [
  { startupId: "acct-1", startupName: "Example One", contactName: "Ada", contactEmail: "ada@example.com" },
];
const DRAFTS = [
  { id: "d-1", recipientId: "r-1", recipientEmail: "ada@example.com", subject: "Hi", body: "Hello", status: "draft" },
];

/** Draw `Renderer` with `value` and return what it staged last, once it staged anything. */
async function stagedBy(
  Renderer: React.ComponentType<Record<string, unknown>>,
  value: Record<string, unknown>,
  runId = "run-1",
): Promise<Record<string, unknown>> {
  const onChange = vi.fn();
  render(<Renderer value={value} onChange={onChange} context={{ connectedApps: [], runId }} />);
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  return onChange.mock.calls.at(-1)![0] as Record<string, unknown>;
}

/** What the server reads from the staged answer's resume text. */
const sent = (staged: Record<string, unknown>) => readWayflowSubmittedValues({ userResponse: staged.userResponse });

afterEach(() => cleanup());

describe("the recipients review stages the answer the server sends (cinatra#3470)", () => {
  it("its preloaded recipients stage the campaign id as the resume text", async () => {
    const staged = await stagedBy(CampaignRecipientsReviewRenderer as never, {
      recipients: RECIPIENTS,
      campaignId: "camp-1",
    });
    // red-first-expect: isCampaignRecipientsReviewAnswer is not a function
    expect(isCampaignRecipientsReviewAnswer(sent(staged))).toBe(true);
    expect(sent(staged)).toMatchObject({ campaignId: "camp-1", approved: true });
  });

  it("its preloaded recipients with no campaign id stage the run's id, as its loaded recipients do", async () => {
    const staged = await stagedBy(CampaignRecipientsReviewRenderer as never, { recipients: RECIPIENTS }, "run-7");
    expect(sent(staged)).toMatchObject({ campaignId: "run-7", approved: true });
    expect(isCampaignRecipientsReviewAnswer(sent(staged))).toBe(true);
  });
});

describe("the drafts review stages the answer the server sends (cinatra#3470)", () => {
  it("its drafts stage the ids it approves, with the campaign id it was handed", async () => {
    const staged = await stagedBy(EmailDraftsReviewRenderer as never, { drafts: DRAFTS, campaignId: "camp-1" });
    expect(sent(staged)).toEqual({ campaignId: "camp-1", approvedDraftIds: ["d-1"], edited: false, editedIds: [] });
    expect(isEmailDraftsReviewAnswer(sent(staged))).toBe(true);
  });

  it("drafts found by the run alone stage no campaign id, and that answer is sent", async () => {
    const staged = await stagedBy(EmailDraftsReviewRenderer as never, { drafts: DRAFTS });
    expect(sent(staged)).toEqual({ approvedDraftIds: ["d-1"], edited: false, editedIds: [] });
    expect(isEmailDraftsReviewAnswer(sent(staged))).toBe(true);
  });
});

describe("a recipients or drafts review answer is read with exactly the keys its screen stages (cinatra#3470)", () => {
  it("the recipients screen stages no removal, and an answer that adds one, or any other key, is refused", async () => {
    const staged = await stagedBy(CampaignRecipientsReviewRenderer as never, {
      recipients: RECIPIENTS,
      campaignId: "camp-1",
    });
    const answer = sent(staged)!;
    expect(Object.keys(answer).sort()).toEqual(["approved", "approvedAt", "campaignId"]);
    // red-first-expect: isCampaignRecipientsReviewAnswer is not a function
    expect(isCampaignRecipientsReviewAnswer({ ...answer, removedRecipients: [{ startupId: "acct-1" }] })).toBe(false);
    expect(isCampaignRecipientsReviewAnswer({ ...answer, note: "x" })).toBe(false);
  });

  it("the drafts screen stages no draft text, and an answer that adds it, a removal or any other key, is refused", async () => {
    const staged = await stagedBy(EmailDraftsReviewRenderer as never, { drafts: DRAFTS, campaignId: "camp-1" });
    const answer = sent(staged)!;
    // red-first-expect: isEmailDraftsReviewAnswer is not a function
    expect(isEmailDraftsReviewAnswer({ ...answer, drafts: [{ id: "d-1", body: "Changed" }] })).toBe(false);
    expect(isEmailDraftsReviewAnswer({ ...answer, removedRecipients: [] })).toBe(false);
    expect(isEmailDraftsReviewAnswer({ ...answer, note: "x" })).toBe(false);
  });
});

describe("a declared recipients or drafts review holds the host's Continue until its answer is staged", () => {
  it.each([
    ["campaign-recipients-review", { campaignId: "camp-1", approved: true, approvedAt: "2026-01-01T00:00:00.000Z" }],
    ["email-drafts-review", { approvedDraftIds: ["d-1"], edited: false, editedIds: [] }],
  ])("%s", (kind, answer) => {
    const id = `@acme-test/review-hold-agent:${kind}`;
    registerFieldRendererBindings([{ id, kind, priority: 90, midRunHitl: true, screen: { layout: "kind" } }]);
    try {
      const entry = fieldRendererRegistry.list().find((e) => e.id === id);
      const ready = (staged: Record<string, unknown>) => entry?.continueReady?.({ runValue: {}, staged });
      // red-first-expect: expected undefined to be false
      expect(ready({})).toBe(false);
      expect(ready({ campaignId: "camp-1" })).toBe(false);
      expect(ready({ ...answer, userResponse: JSON.stringify(answer) })).toBe(true);
    } finally {
      const held = fieldRendererRegistry as { unregisterEntry?: (entry: unknown) => void };
      for (const entry of fieldRendererRegistry.list().filter((e) => e.id === id)) held.unregisterEntry?.(entry);
    }
  });
});

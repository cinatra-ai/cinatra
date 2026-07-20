// @vitest-environment jsdom
/**
 * Regression coverage for local-state value synchronization in custom field
 * renderers.
 *
 * Sweep the host custom field renderers for the `useState`-only local-state bug
 * fixed in `SchemaFieldRenderer`. Add `useEffect([value])`
 * sync wherever buffered local state holds a copy of the `value` prop and the
 * parent (HITL flow) can rewrite `value` mid-edit (AI suggestions, form.reset,
 * polling).
 *
 * MIGRATION NOTE (cinatra#1625, eng#548): the FollowUpCadence component moved
 * into @cinatra-ai/email-artifacts; its value-sync + poll-guard coverage moved
 * with it (email-artifacts/src/__tests__/follow-up-cadence.test.tsx). This host
 * suite keeps the renderers that remain host-owned: SchemaFieldRenderer,
 * EmailDraftsReviewRenderer, and SendConfirmationRenderer.
 *
 * INLINE-FALLBACK NOTE for Test 4:
 *   `SendConfirmationRenderer` resolves its embedded sender field through the
 *   field-renderer REGISTRY (the gmail-sender COMPONENT migrated into
 *   @cinatra-ai/email-artifacts, cinatra#1625). With no gmail connected
 *   (BASE_CONTEXT), the gmail-sender condition does NOT activate, so resolve()
 *   returns null and SendConfirmation renders its OWN eager inline email
 *   `<input id="field-senderEmail">` fallback — a native input `queryByDisplayValue`
 *   can read, which commits every keystroke to senderEmail immediately (codex
 *   2026-07-21: the buffering schema floor was rejected because a typed address
 *   could be lost on approval). These tests exercise that eager path + the
 *   SendConfirmation senderEmail sync.
 *
 *   pnpm --filter @cinatra/agents exec vitest run \
 *     src/__tests__/renderer-local-state.test.tsx
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Stub lucide-react so jsdom does not hit React-version mismatches.
// (Same shape as schema-field-renderer-hide-submit.test.tsx.)
// ---------------------------------------------------------------------------
vi.mock("lucide-react", () => ({
  ChevronDown: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "chevron-down", className }),
  ChevronUp: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "chevron-up", className }),
  Check: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "check", className }),
  X: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "x", className }),
  Loader2: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "loader2", className }),
}));

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Stub the email-outreach stage actions so EmailDraftsReviewRenderer's
// preloaded-drafts path can render without hitting any DB/MCP plumbing.
vi.mock("../email-outreach-stage-actions", () => ({
  fetchInitialDrafts: vi.fn(async () => ({ items: [], total: 0 })),
  fetchChildInterruptOutput: vi.fn(async () => null),
  updateInitialDraft: vi.fn(async () => undefined),
  checkEmailOutreachAsyncStatus: vi.fn(async () => ({ status: "idle" })),
  fetchCampaignRecipients: vi.fn(async () => ({ items: [], total: 0 })),
}));

import { SchemaFieldRenderer } from "../schema-field-renderer";
import { EmailDraftsReviewRenderer } from "../email-drafts-review-renderer";
import { SendConfirmationRenderer } from "../send-confirmation-renderer";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_CONTEXT = { connectedApps: [] as string[] };

// ---------------------------------------------------------------------------
// Test 1 — SchemaFieldRenderer regression guard
// ---------------------------------------------------------------------------

describe("SchemaFieldRenderer value-sync regression guard", () => {
  afterEach(() => {
    cleanup();
  });

  it("syncs localValue when value prop changes externally from 'initial' to 'updated'", () => {
    const { rerender } = render(
      <SchemaFieldRenderer
        fieldName="website"
        schema={{ type: "string", title: "Website" }}
        value="initial"
        onChange={() => {}}
        context={BASE_CONTEXT}
      />,
    );
    expect(screen.queryByDisplayValue("initial")).not.toBeNull();

    rerender(
      <SchemaFieldRenderer
        fieldName="website"
        schema={{ type: "string", title: "Website" }}
        value="updated"
        onChange={() => {}}
        context={BASE_CONTEXT}
      />,
    );
    expect(screen.queryByDisplayValue("updated")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 3a / 3b / 3c — EmailDraftsReviewRenderer
// ---------------------------------------------------------------------------

describe("EmailDraftsReviewRenderer value-sync", () => {
  afterEach(() => {
    cleanup();
  });

  it("3a — re-seeds drafts AND edits when draft content (subject/body fingerprint) changes externally", async () => {
    const initial = { drafts: [{ id: "d1", subject: "A", body: "a" }] };
    const updated = { drafts: [{ id: "d1", subject: "B", body: "b" }] };
    const { rerender } = render(
      <EmailDraftsReviewRenderer
        fieldName="review"
        schema={{ type: "object" }}
        value={initial}
        onChange={() => {}}
        context={BASE_CONTEXT}
        label="Review"
      />,
    );
    // Wait for preloaded drafts to render the subject input.
    expect(await screen.findByDisplayValue("A")).not.toBeNull();
    rerender(
      <EmailDraftsReviewRenderer
        fieldName="review"
        schema={{ type: "object" }}
        value={updated}
        onChange={() => {}}
        context={BASE_CONTEXT}
        label="Review"
      />,
    );
    expect(await screen.findByDisplayValue("B")).not.toBeNull();
  });

  it("3b — POLL SAFETY: does NOT overwrite in-progress user edits when value re-references with same content (regression guard for line-268 comment)", async () => {
    const draftContent = { id: "d1", subject: "A", body: "a" };
    // First reference of value.
    const valueT0 = { drafts: [{ ...draftContent }] };
    const { rerender } = render(
      <EmailDraftsReviewRenderer
        fieldName="review"
        schema={{ type: "object" }}
        value={valueT0}
        onChange={() => {}}
        context={BASE_CONTEXT}
        label="Review"
      />,
    );
    const subjectInput = (await screen.findByDisplayValue("A")) as HTMLInputElement;

    // Simulate the user typing into the subject input.
    fireEvent.change(subjectInput, { target: { value: "user-typed" } });
    expect(subjectInput.value).toBe("user-typed");

    // Parent poll cycle: parent re-emits a fresh array/object reference but
    // with structurally identical draft content. Without the fingerprint
    // guard this would re-seed `edits` and clobber the user's typed text.
    const valueT1 = { drafts: [{ ...draftContent }] };
    rerender(
      <EmailDraftsReviewRenderer
        fieldName="review"
        schema={{ type: "object" }}
        value={valueT1}
        onChange={() => {}}
        context={BASE_CONTEXT}
        label="Review"
      />,
    );

    // The user's edit must survive the poll re-reference.
    expect(subjectInput.value).toBe("user-typed");
  });

  it("3c — preserves recipientEmail through value-sync coercion", async () => {
    const { rerender } = render(
      <EmailDraftsReviewRenderer
        fieldName="drafts"
        schema={{ type: "object" }}
        value={{ drafts: [{ id: "d1", subject: "Hello", body: "Body", recipientEmail: "alice@example.com" }] }}
        onChange={() => {}}
        context={BASE_CONTEXT}
        label="Drafts"
      />,
    );

    // Simulate AI suggestion: new content + recipientEmail preserved
    rerender(
      <EmailDraftsReviewRenderer
        fieldName="drafts"
        schema={{ type: "object" }}
        value={{ drafts: [{ id: "d1", subject: "Updated", body: "New body", recipientEmail: "alice@example.com" }] }}
        onChange={() => {}}
        context={BASE_CONTEXT}
        label="Drafts"
      />,
    );

    // recipientEmail must survive — not fall back to "Unknown recipient"
    await waitFor(() => {
      expect(screen.queryByText("alice@example.com")).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Test 4 — SendConfirmationRenderer (registry-resolved sender via input shim)
// ---------------------------------------------------------------------------

describe("SendConfirmationRenderer value-sync", () => {
  afterEach(() => {
    cleanup();
  });

  it("syncs senderEmail when value.senderEmail changes externally from a@x.com to b@x.com (via registry-shim input)", () => {
    const { rerender } = render(
      <SendConfirmationRenderer
        fieldName="send"
        schema={{ type: "object" }}
        value={{ campaignId: "c1", senderEmail: "a@x.com" }}
        onChange={() => {}}
        context={BASE_CONTEXT}
        label="Send"
      />,
    );
    // Initial state: shim shows "a@x.com".
    expect(screen.queryByDisplayValue("a@x.com")).not.toBeNull();

    rerender(
      <SendConfirmationRenderer
        fieldName="send"
        schema={{ type: "object" }}
        value={{ campaignId: "c1", senderEmail: "b@x.com" }}
        onChange={() => {}}
        context={BASE_CONTEXT}
        label="Send"
      />,
    );
    // After sync, the senderEmail state syncs and the shim shows "b@x.com".
    expect(screen.queryByDisplayValue("b@x.com")).not.toBeNull();
  });

  it("POLL SAFETY: does NOT overwrite user-typed senderEmail when parent re-emits same content", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SendConfirmationRenderer
        fieldName="send"
        schema={{ type: "object" }}
        value={{ campaignId: "c1", senderEmail: "a@x.com" }}
        onChange={onChange}
        context={BASE_CONTEXT}
        label="Send"
      />,
    );
    // Simulate user typing a different address directly into the shim input.
    const input = screen.getByDisplayValue("a@x.com") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "user@typed.com" } });
    expect(screen.queryByDisplayValue("user@typed.com")).not.toBeNull();

    // Poll tick: parent re-emits the SAME senderEmail with a new object reference.
    rerender(
      <SendConfirmationRenderer
        fieldName="send"
        schema={{ type: "object" }}
        value={{ campaignId: "c1", senderEmail: "a@x.com" }}
        onChange={onChange}
        context={BASE_CONTEXT}
        label="Send"
      />,
    );
    // The fingerprint guard must prevent the poll re-reference from resetting the
    // user's typed value back to "a@x.com".
    expect(screen.queryByDisplayValue("user@typed.com")).not.toBeNull();
    expect(screen.queryByDisplayValue("a@x.com")).toBeNull();
  });

  it("commits a typed fallback address to the approval payload (eager, not buffered)", () => {
    // codex 2026-07-21 merge gate: typing into the no-gmail inline fallback must
    // reach the approval onChange payload WITHOUT a Continue/flush (the buffering
    // schema floor would have dropped it). SendConfirmation emits
    // { campaignId, senderEmail } whenever senderEmail changes.
    const onChange = vi.fn();
    render(
      <SendConfirmationRenderer
        fieldName="send"
        schema={{ type: "object" }}
        value={{ campaignId: "c1" }}
        onChange={onChange}
        context={BASE_CONTEXT}
        label="Send"
      />,
    );
    const input = document.getElementById("field-senderEmail") as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: "typed@sender.com" } });
    // The latest onChange emission carries the eagerly-committed address.
    const lastCall = onChange.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ campaignId: "c1", senderEmail: "typed@sender.com" });
  });
});

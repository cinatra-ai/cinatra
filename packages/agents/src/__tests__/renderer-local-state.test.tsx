// @vitest-environment jsdom
/**
 * Regression coverage for local-state value synchronization in custom field
 * renderers.
 *
 * Sweep three custom field renderers for the `useState`-only local-state bug
 * fixed in `SchemaFieldRenderer`. Add `useEffect([value])`
 * sync wherever buffered local state holds a copy of the `value` prop and the
 * parent (HITL flow) can rewrite `value` mid-edit (AI suggestions, form.reset,
 * polling).
 *
 * RED STATE EXPECTATIONS (this commit):
 *   - Test 1 (SchemaFieldRenderer regression guard for value sync):
 *     PASSES — the canonical `useEffect([value])` sync is already in place at
 *     `schema-field-renderer.tsx` lines 73-88. Included here as a pinned
 *     regression guard so the value sync can never silently regress.
 *   - Test 2 (FollowUpCadenceFieldRenderer): FAILS — current code at line 63
 *     only re-seeds when `hideSubmit && !Array.isArray(value)`; passing a new
 *     array does not re-sync the `days` state.
 *   - Test 3a (EmailDraftsReviewRenderer content change): FAILS — there is no
 *     [value] sync today; the renderer reads `preloaded` only on mount.
 *   - Test 3b (EmailDraftsReviewRenderer POLL SAFETY): PASSES TRIVIALLY in RED
 *     because no sync exists — user typing is preserved by default. The test
 *     remains MUST-PASS in GREEN because the fingerprint guard is supposed to
 *     prevent the new sync from clobbering edits when the parent's poll cycle
 *     re-references `value` with the same content. This is the critical
 *     regression guard for the line-268 comment in
 *     `email-drafts-review-renderer.tsx`. A naive `useEffect([value])` (no
 *     fingerprint) would FAIL this test, signalling the bug.
 *   - Test 4 (SendConfirmationRenderer): FAILS — there is no [value] sync for
 *     `senderEmail` today; only `aiSuggestions` is observed.
 *
 * SELECT-SHIM NOTE for Test 4:
 *   `SendConfirmationRenderer` renders `GmailSenderFieldRenderer`, which uses
 *   a shadcn `Select` (button + span text, NOT a native `<input>`). In jsdom,
 *   `screen.queryByDisplayValue("…")` cannot find the value because there is
 *   no underlying input element. We therefore mock the child renderer as a
 *   simple controlled `<input data-testid="gmail-sender">` so display-value
 *   queries are deterministic across both RED and GREEN.
 *
 *   pnpm --filter @cinatra/agent-builder exec vitest run \
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

// Replace GmailSenderFieldRenderer with a controlled <input> shim so tests can
// assert sender email via queryByDisplayValue (the real one is a shadcn Select).
vi.mock("../gmail-sender-renderer", () => ({
  GmailSenderFieldRenderer: ({
    value,
    onChange,
  }: {
    value: unknown;
    onChange: (v: string) => void;
  }) =>
    React.createElement("input", {
      "data-testid": "gmail-sender",
      value: typeof value === "string" ? value : "",
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        onChange(e.target.value),
    }),
}));

import { SchemaFieldRenderer } from "../schema-field-renderer";
import { FollowUpCadenceFieldRenderer } from "../follow-up-cadence-renderer";
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
// Test 2 — FollowUpCadenceFieldRenderer
// ---------------------------------------------------------------------------

describe("FollowUpCadenceFieldRenderer value-sync", () => {
  afterEach(() => {
    cleanup();
  });

  it("syncs days local state when value prop changes externally from [3] to [7, 14]", () => {
    const { rerender } = render(
      <FollowUpCadenceFieldRenderer
        fieldName="cadence"
        schema={{ type: "array" }}
        value={[3]}
        onChange={() => {}}
        context={BASE_CONTEXT}
        label="Cadence"
      />,
    );
    rerender(
      <FollowUpCadenceFieldRenderer
        fieldName="cadence"
        schema={{ type: "array" }}
        value={[7, 14]}
        onChange={() => {}}
        context={BASE_CONTEXT}
        label="Cadence"
      />,
    );
    // After the GREEN fix, the renderer reflects the new array.
    expect(screen.queryByDisplayValue("7")).not.toBeNull();
    expect(screen.queryByDisplayValue("14")).not.toBeNull();
  });

  it("does not re-fire onChange on a same-value rerender when hideSubmit=true", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FollowUpCadenceFieldRenderer
        fieldName="cadence"
        schema={{ type: "array" }}
        value={[3, 7]}
        onChange={onChange}
        context={BASE_CONTEXT}
        hideSubmit={true}
        label="Cadence"
      />,
    );
    const baselineCalls = onChange.mock.calls.length;
    // Simulate a parent re-emitting the same value (which is what happens
    // after a keystroke flushes onChange → parent setValue → re-render).
    rerender(
      <FollowUpCadenceFieldRenderer
        fieldName="cadence"
        schema={{ type: "array" }}
        value={[3, 7]}
        onChange={onChange}
        context={BASE_CONTEXT}
        hideSubmit={true}
        label="Cadence"
      />,
    );
    // The structural-equality guard means setDays is NOT called → no
    // re-render → no extra onChange.
    expect(onChange.mock.calls.length).toBe(baselineCalls);
  });
});

// ---------------------------------------------------------------------------
// Test 3a / 3b — EmailDraftsReviewRenderer
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

  it("3c — preserves recipientEmail through value-sync coercion (WR-01 fix)", async () => {
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
// Test 4 — SendConfirmationRenderer (with mocked GmailSenderFieldRenderer)
// ---------------------------------------------------------------------------

describe("SendConfirmationRenderer value-sync", () => {
  afterEach(() => {
    cleanup();
  });

  it("syncs senderEmail when value.senderEmail changes externally from a@x.com to b@x.com (via mocked GmailSenderFieldRenderer input shim)", () => {
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
    // After the GREEN fix, the senderEmail state syncs and the shim shows
    // "b@x.com".
    expect(screen.queryByDisplayValue("b@x.com")).not.toBeNull();
  });

  it("POLL SAFETY: does NOT overwrite user-typed senderEmail when parent re-emits same content (CR-01 fix)", () => {
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
});

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
 * MIGRATION NOTE (cinatra#1625): the FollowUpCadence component moved
 * into @cinatra-ai/email-artifacts; its value-sync + poll-guard coverage moved
 * with it (email-artifacts/src/__tests__/follow-up-cadence.test.tsx). The
 * SendConfirmation SHELL likewise relocated into @cinatra-ai/email-artifacts
 * (cinatra#1961, S8 successor) — action-decoupled, it now composes the sibling
 * gmail-sender directly and renders its eager inline email `<input>` fallback when
 * gmail is disconnected; its senderEmail value-sync + poll-guard coverage moved
 * with it (email-artifacts/src/__tests__/send-confirmation.test.tsx). This host
 * suite keeps the renderers that remain host-owned: SchemaFieldRenderer and
 * EmailDraftsReviewRenderer.
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

// Test 4 — SendConfirmationRenderer — RELOCATED (cinatra#1961): the send-confirmation
// SHELL moved into @cinatra-ai/email-artifacts; its eager-inline sender value-sync,
// poll-safety fingerprint guard, and eager approval-payload commit coverage now
// live in email-artifacts/src/__tests__/send-confirmation.test.tsx.

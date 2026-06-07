// @vitest-environment jsdom
/**
 * AuditorReviewRenderer tests for the auditor-agent HITL review surface.
 *
 * Verifies the drawer markup contract, ownership guard, and accept/dismiss
 * behavior for the auditor-agent HITL renderer surface.
 *
 * Run: pnpm exec vitest run src/__tests__/auditor-review-renderer.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Lucide mock — hoist-safe pattern for renderer tests.
// ---------------------------------------------------------------------------
vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return {
    ClipboardList: StubIcon,
    Loader2: StubIcon,
    ChevronDown: StubIcon,
    Check: StubIcon,
    X: StubIcon,
    default: StubIcon,
  };
});

// The renderer calls the shared toast wrapper. Spy at the wrapper module so the
// test can assert toast.success was invoked.
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Auditor-agent renderer calls the shared server actions under the hood.
vi.mock("../server-actions", () => ({
  getAuditDrawerDataAction: vi.fn(async () => ({
    prompts: [
      {
        id: "p1",
        stepKey: "step1",
        message: "guidance text",
        capturedAt: "2026-04-30T00:00:00Z",
      },
    ],
    preview: {
      id: "ps1",
      name: "Audit Skill",
      description: "drawer desc",
      content: "PREVIEW_MD",
      basedOnSkillIds: ["custom:foo:bar"],
    },
    error: null,
  })),
  dismissAuditPromptsAction: vi.fn(async () => ({ ok: true, dismissed: 1 })),
}));

// Production import (AFTER mocks).
import { AuditorReviewRenderer } from "../auditor-review-renderer";

// Field-renderer-style props (mirrors EmailDraftsReviewRenderer pattern):
// { value, onChange, disabled, context, schema }
function renderRenderer(overrides: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  const props: Record<string, unknown> = {
    fieldName: "auditorReview",
    value: { runId: "r1", agentPackageName: "@a" },
    onChange,
    disabled: false,
    context: {
      runId: "r1",
      sessionUserId: "u1",
      runOwnerId: "u1",
      ...((overrides.context as Record<string, unknown>) ?? {}),
    },
    schema: { "x-renderer": "@cinatra-ai/auditor-agent:review" },
    ...overrides,
  };
  const Renderer = AuditorReviewRenderer as unknown as React.ComponentType<Record<string, unknown>>;
  return { onChange, ...render(<Renderer {...props} />) };
}

describe("AuditorReviewRenderer HITL review surface", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("AUD-02 (migrated, AUD-203): fetches drawer data via getAuditDrawerDataAction and shows guidance + preview", async () => {
    renderRenderer();
    await waitFor(() => expect(screen.queryByText("guidance text")).toBeTruthy());
    expect(screen.getByText("PREVIEW_MD")).toBeTruthy();
    expect(screen.getByText("step1")).toBeTruthy();
  });

  it("AUD-03 (migrated, AUD-204): clicking Accept emits userResponse JSON containing acceptedIds and toast.success", async () => {
    const { onChange } = renderRenderer();
    await waitFor(() => expect(screen.queryByRole("button", { name: /accept/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    const { toast } = await import("@/lib/cinatra-toast");
    expect(toast.success).toHaveBeenCalled();

    // Payload is { userResponse: <json> }; decode to inspect.
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as
      | { userResponse?: string }
      | undefined;
    expect(typeof lastCall?.userResponse).toBe("string");
    const decoded = JSON.parse(lastCall!.userResponse!) as { acceptedIds: string[] };
    expect(decoded.acceptedIds).toEqual(expect.arrayContaining(["p1"]));
  });

  it("AUD-04 (migrated, AUD-205): clicking Dismiss calls dismissAuditPromptsAction and emits userResponse JSON with dismissedIds", async () => {
    const { onChange } = renderRenderer();
    await waitFor(() => expect(screen.queryByRole("button", { name: /dismiss/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    const mod = await import("../server-actions");
    await waitFor(() =>
      expect(mod.dismissAuditPromptsAction).toHaveBeenCalledWith("r1", "@a"),
    );

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as
      | { userResponse?: string }
      | undefined;
    expect(typeof lastCall?.userResponse).toBe("string");
    const decoded = JSON.parse(lastCall!.userResponse!) as {
      acceptedIds: string[];
      dismissedIds: string[];
    };
    expect(decoded.acceptedIds).toEqual([]);
    expect(decoded.dismissedIds).toEqual(expect.arrayContaining(["p1"]));
  });

  it("AUD-203: ownership-guard rejects when sessionUserId !== runOwnerId (renders nothing or guard message; never the drawer body)", async () => {
    renderRenderer({
      context: {
        runId: "r1",
        sessionUserId: "u1",
        runOwnerId: "different-user",
      },
    });
    // Drawer body must not be exposed to a non-owner.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("PREVIEW_MD")).toBeNull();
    expect(screen.queryByText("guidance text")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Single string-output contract (renderer-host payload key)
//
// The renderer emits exactly ONE key on `onChange` — `{ userResponse:
// "<json-string>" }` whose `JSON.parse` is `{ acceptedIds, dismissedIds }`.
// The two top-level keys (`acceptedIds`, `dismissedIds`) must NOT appear on
// the emitted payload.
//
// Note: this asserts the renderer→host envelope key on the WayFlow resume
// channel (read by `approveReviewTask` at `review-task-actions.ts:282`),
// which is `userResponse`. The auditor OAS's InputMessageNode output title
// + `/api/auditor/apply` body field are separately named `reviewResult` (a
// downstream OAS-graph variable). The renderer's documented `userResponse`
// emit is the canonical resume-text channel and is what this test verifies.
// ---------------------------------------------------------------------------
describe("AuditorReviewRenderer — single string-output contract", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("Accept emits a single `userResponse` JSON-string keyed payload", async () => {
    const { onChange } = renderRenderer();
    await waitFor(() => expect(screen.queryByRole("button", { name: /accept/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const payload = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as Record<
      string,
      unknown
    >;

    // Exactly one key, named `userResponse`, value is a JSON string.
    expect(Object.keys(payload)).toEqual(["userResponse"]);
    expect(typeof payload.userResponse).toBe("string");

    // Old multi-output keys MUST NOT leak.
    expect((payload as { acceptedIds?: unknown }).acceptedIds).toBeUndefined();
    expect((payload as { dismissedIds?: unknown }).dismissedIds).toBeUndefined();

    // Round-trip: JSON.parse → { acceptedIds, dismissedIds }.
    const decoded = JSON.parse(payload.userResponse as string) as {
      acceptedIds: string[];
      dismissedIds: string[];
    };
    expect(decoded.acceptedIds).toEqual(expect.arrayContaining(["p1"]));
    expect(Array.isArray(decoded.dismissedIds)).toBe(true);
  });

  it("Dismiss emits a single `userResponse` JSON-string keyed payload", async () => {
    const { onChange } = renderRenderer();
    await waitFor(() => expect(screen.queryByRole("button", { name: /dismiss/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const payload = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as Record<
      string,
      unknown
    >;

    expect(Object.keys(payload)).toEqual(["userResponse"]);
    expect(typeof payload.userResponse).toBe("string");
    expect((payload as { acceptedIds?: unknown }).acceptedIds).toBeUndefined();
    expect((payload as { dismissedIds?: unknown }).dismissedIds).toBeUndefined();

    const decoded = JSON.parse(payload.userResponse as string) as {
      acceptedIds: string[];
      dismissedIds: string[];
    };
    expect(decoded.acceptedIds).toEqual([]);
    expect(decoded.dismissedIds).toEqual(expect.arrayContaining(["p1"]));
  });
});

// @vitest-environment jsdom
/**
 * AiReviewPanelRenderer error-toast contract.
 *
 * In a Next.js production build, a Server Action that throws has its real
 * `Error.message` replaced by the framework's generic masking blurb before it
 * reaches the client `catch`. The panel's mutation toasts must therefore show
 * short, friendly, operation-specific copy — never the caught
 * `error.message` — or production users see the masking paragraph in a toast.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// The renderer calls the shared toast wrapper. Spy at the wrapper module so
// the test can assert exactly what the user-visible toast receives.
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Mock the server-action module BEFORE importing the renderer so the mocked
// actions are the ones the panel calls.
vi.mock("../email-outreach-stage-actions", () => ({
  getReviewCheckState: vi.fn(),
  runReviewCheck: vi.fn(),
  dismissReviewRecommendation: vi.fn(),
  applyReviewRecommendation: vi.fn(),
}));

import { AiReviewPanelRenderer } from "../ai-review-panel-renderer";
import * as actions from "../email-outreach-stage-actions";
import { toast } from "@/lib/cinatra-toast";
import type { FieldRendererProps } from "../field-renderer-registry";

// Shape of what the client receives from a rejected Server Action in a
// production build: an Error instance carrying the masking text instead of
// the original server-side message.
const PROD_MASKED_MESSAGE =
  "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.";

function makeProps(
  overrides: Partial<FieldRendererProps> = {},
): FieldRendererProps {
  return {
    fieldName: "review",
    schema: {
      "x-renderer": "ai-review-panel",
      "x-service-id": "svc-1",
    } as Record<string, unknown>,
    value: { campaignId: "c-1" },
    onChange: () => {},
    disabled: false,
    required: false,
    error: null,
    label: "AI review",
    description: undefined,
    context: { connectedApps: [] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(actions.getReviewCheckState).mockResolvedValue({
    status: "idle",
    recommendations: [],
  });
});

afterEach(() => {
  cleanup();
});

describe("AiReviewPanelRenderer server-action rejection toasts", () => {
  it("shows friendly operation-specific copy when runReviewCheck rejects with a prod-masked Error", async () => {
    vi.mocked(actions.runReviewCheck).mockRejectedValueOnce(
      new Error(PROD_MASKED_MESSAGE),
    );

    render(<AiReviewPanelRenderer {...makeProps()} />);
    await waitFor(() =>
      expect(actions.getReviewCheckState).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByRole("button", { name: /run review/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const message = String(vi.mocked(toast.error).mock.calls[0][0]);
    expect(message).toBe("Could not run the review check.");
    expect(message).not.toContain("omitted in production");
    expect(message).not.toContain(PROD_MASKED_MESSAGE);
  });

  it("shows friendly operation-specific copy when applyReviewRecommendation rejects", async () => {
    vi.mocked(actions.getReviewCheckState).mockResolvedValue({
      status: "done",
      recommendations: [
        { id: "rec-1", severity: "warn", title: "Tighten subject line" },
      ],
    });
    vi.mocked(actions.applyReviewRecommendation).mockRejectedValueOnce(
      new Error(PROD_MASKED_MESSAGE),
    );

    render(<AiReviewPanelRenderer {...makeProps()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^apply$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const message = String(vi.mocked(toast.error).mock.calls[0][0]);
    expect(message).toBe("Could not apply the recommendation.");
    expect(message).not.toContain("omitted in production");
  });
});

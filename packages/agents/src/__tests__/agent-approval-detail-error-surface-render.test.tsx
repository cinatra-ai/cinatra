// @vitest-environment jsdom
/**
 * DOM-render proof that a decision outcome surfaces as a TOAST via the codes-only
 * <SearchParamToast> island (cinatra#391 → #1109), not a silent reload.
 *
 * The decision island is mounted at the host PAGE
 * (src/app/configuration/agents/approvals/[id]/page.tsx) with the co-located
 * APPROVAL_DECISION_TOASTS map (approval-decision-flash.ts) — NOT inside the
 * async server screen, which the server API routes reach. The sibling
 * source-invariant test pins that page mount + the co-located codes. This test
 * renders the REAL island (from sdk-ui) with a representative slice of that
 * config and mocked next/navigation + toast, and asserts the mapped STATIC
 * message toasts — never the raw URL value.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

// vi.mock factories are hoisted above the module body, so any variable they
// reference EAGERLY must be created via vi.hoisted (also hoisted).
const { replace, toastError, toastSuccess } = vi.hoisted(() => ({
  replace: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
let currentParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  // `currentParams` is read lazily (per call) so its top-level reassignment
  // between tests is observed without hoisting.
  useSearchParams: () => currentParams,
  usePathname: () => "/configuration/agents/approvals/req-1",
  useRouter: () => ({ replace }),
}));

vi.mock("@cinatra-ai/sdk-ui/toast", () => {
  const t = Object.assign(vi.fn(), {
    error: toastError,
    success: toastSuccess,
    warning: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  });
  return { toast: t, cinatraToast: t };
});

import { SearchParamToast } from "@cinatra-ai/sdk-ui/search-param-toast";

// A representative slice of screens.tsx's APPROVAL_DECISION_TOASTS (the sibling
// source test pins the full set).
const DECISION_TOASTS = [
  {
    param: "status",
    value: "approved",
    message: "The proposal was approved and published (private-scoped).",
    variant: "success" as const,
  },
  {
    param: "error",
    value: "decision-failed",
    message: "The decision could not be recorded. See server logs for details.",
    variant: "error" as const,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentParams = new URLSearchParams();
});

describe("AgentApprovalDetailScreen decision toast render (#391 → #1109)", () => {
  it("toasts the mapped STATIC error message for a failed decision (?error=<code>)", () => {
    currentParams = new URLSearchParams("error=decision-failed");
    render(<SearchParamToast toasts={DECISION_TOASTS} />);
    expect(toastError).toHaveBeenCalledWith(
      "The decision could not be recorded. See server logs for details.",
      expect.anything(),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("NEVER toasts the raw URL value — only the server-trusted static message", () => {
    currentParams = new URLSearchParams("error=decision-failed");
    render(<SearchParamToast toasts={DECISION_TOASTS} />);
    expect(toastError).not.toHaveBeenCalledWith("decision-failed", expect.anything());
  });

  it("toasts the success message for a recorded decision (?status=approved)", () => {
    currentParams = new URLSearchParams("status=approved");
    render(<SearchParamToast toasts={DECISION_TOASTS} />);
    expect(toastSuccess).toHaveBeenCalledWith(
      "The proposal was approved and published (private-scoped).",
      expect.anything(),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("fires no toast when no decision param is present (clean page)", () => {
    render(<SearchParamToast toasts={DECISION_TOASTS} />);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("fires no toast for an unknown ?status= value", () => {
    currentParams = new URLSearchParams("status=bogus");
    render(<SearchParamToast toasts={DECISION_TOASTS} />);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

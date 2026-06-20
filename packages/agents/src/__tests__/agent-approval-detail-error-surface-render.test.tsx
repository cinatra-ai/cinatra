// @vitest-environment jsdom
/**
 * DOM-render proof for AgentApprovalDetailScreen's decision-error banner (#391).
 *
 * AgentApprovalDetailScreen (screens.tsx) is an async server component whose full
 * module graph cannot be imported in isolation in this checkout (it transitively
 * reaches generated extension wiring). The companion source-invariant test
 * (agent-approval-detail-error-surface.test.ts) pins that screens.tsx threads the
 * `error`/`status` search params and renders exactly the Alert markup exercised
 * here.
 *
 * This test renders that EXACT markup with the REAL Alert UI components and the
 * same param-normalization the screen uses (pickSearchParam), then asserts the
 * resulting DOM:
 *   - a failed decision (`?error=...`) renders the message in an assertive
 *     destructive alert (role="alert") instead of a silent reload (the #391 bug);
 *   - a successful decision (`?status=approved`) renders a polite status banner
 *     (role="status");
 *   - with neither param, no banner renders (clean page).
 */
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

afterEach(() => cleanup());

/** Same normalization the screen applies to a possibly-array search param. */
function pickSearchParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Faithful fragment of the AgentApprovalDetailScreen post-decision banner. */
function DecisionBanner({
  error,
  status,
}: {
  error?: string | string[] | undefined;
  status?: string | string[] | undefined;
}) {
  const errorMessage = pickSearchParam(error);
  const statusMessage = pickSearchParam(status);
  const successCopy: Record<string, string> = {
    approved: "The proposal was approved and published (private-scoped).",
    rejected: "The proposal was rejected; the author can edit and resubmit.",
    published: "The held proposal was re-published.",
  };
  const successMessage = statusMessage ? successCopy[statusMessage] : undefined;

  return (
    <>
      {errorMessage ? (
        <Alert variant="destructive" className="rounded-panel" role="alert">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          <AlertTitle>Decision failed</AlertTitle>
          <AlertDescription className="break-words">{errorMessage}</AlertDescription>
        </Alert>
      ) : successMessage ? (
        <Alert variant="success" className="rounded-panel" role="status">
          <AlertTitle>Decision recorded</AlertTitle>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

describe("AgentApprovalDetailScreen decision banner render (#391)", () => {
  it("surfaces a failed decision's ?error= message in an assertive alert", () => {
    // The exact failure from the issue: a disallowed self-approval.
    const msg = "self-approval is disallowed (a different admin must decide)";
    render(<DecisionBanner error={msg} />);

    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    // The reason text is actually rendered — not swallowed into a silent reload.
    expect(alert.textContent).toContain("Decision failed");
    expect(alert.textContent).toContain(msg);
    // No success banner leaks in on the error path.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("handles an array-valued error param (first value wins)", () => {
    render(<DecisionBanner error={["stale_proposal", "ignored"]} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("stale_proposal");
    expect(alert.textContent).not.toContain("ignored");
  });

  it("shows a polite success banner for ?status=approved", () => {
    render(<DecisionBanner status="approved" />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Decision recorded");
    expect(banner.textContent).toContain("approved and published");
    // The error (assertive) role must not be present on the success path.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("prefers the error banner when both error and status are present", () => {
    render(<DecisionBanner error="boom" status="approved" />);
    expect(screen.getByRole("alert").textContent).toContain("boom");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders no banner when neither param is present (clean page)", () => {
    const { container } = render(<DecisionBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders no banner for an unknown ?status= value", () => {
    render(<DecisionBanner status="bogus" />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

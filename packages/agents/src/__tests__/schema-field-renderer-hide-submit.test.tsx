// @vitest-environment jsdom
/**
 * Regression coverage for the `hideSubmit` field renderer prop.
 *
 * `SchemaFieldRenderer` and `FollowUpCadenceFieldRenderer` must omit their
 * per-field "Continue" button when `hideSubmit` is true. The grouped form owns
 * the sole "Save & start run" button for the full form.
 *
 *   pnpm --filter @cinatra/agent-builder exec vitest run \
 *     src/__tests__/schema-field-renderer-hide-submit.test.tsx
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Stub lucide-react so jsdom does not hit React-version mismatches.
// (Same pattern as tests/orchestrator-run-panel.test.tsx.)
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

import { SchemaFieldRenderer } from "../schema-field-renderer";
import { FollowUpCadenceFieldRenderer } from "../follow-up-cadence-renderer";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Minimal FieldRendererContext — connectedApps=[] is the default.
const BASE_CONTEXT = { connectedApps: [] as string[] };

describe("SchemaFieldRenderer hideSubmit", () => {
  beforeEach(() => {
    // No-op — render cleanup happens in afterEach.
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the Continue button by default (hideSubmit !== true) in SchemaFieldRenderer", () => {
    render(
      <SchemaFieldRenderer
        fieldName="website"
        schema={{ type: "string", title: "Website" }}
        value=""
        onChange={() => {}}
        context={BASE_CONTEXT}
      />,
    );

    // Baseline invariant: default render emits a Continue button.
    const btn = screen.queryByRole("button", { name: /Continue/i });
    expect(btn).not.toBeNull();
  });

  it("hides the Continue button when hideSubmit={true} in SchemaFieldRenderer", () => {
    // Cast to any so this test still compiles when the renderer prop type has
    // not yet exposed hideSubmit.
    // TODO: remove the `as any` cast once FieldRendererProps.hideSubmit lands.
    const extraProps = { hideSubmit: true } as any;

    render(
      <SchemaFieldRenderer
        fieldName="website"
        schema={{ type: "string", title: "Website" }}
        value=""
        onChange={() => {}}
        context={BASE_CONTEXT}
        {...extraProps}
      />,
    );

    // SchemaFieldRenderer must skip the Continue button when hideSubmit is true.
    const btn = screen.queryByRole("button", { name: /Continue/i });
    expect(btn).toBeNull();
  });
});

describe("FollowUpCadenceFieldRenderer hideSubmit", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the Continue button by default (hideSubmit !== true) in FollowUpCadenceFieldRenderer", () => {
    render(
      <FollowUpCadenceFieldRenderer
        fieldName="followUpDays"
        schema={{ type: "array" }}
        value={[4, 11, 25]}
        onChange={() => {}}
        label="Follow-up cadence"
        context={BASE_CONTEXT}
      />,
    );

    const btn = screen.queryByRole("button", { name: /Continue/i });
    expect(btn).not.toBeNull();
  });

  it("hides the Continue button when hideSubmit={true} in FollowUpCadenceFieldRenderer", () => {
    // TODO: remove the `as any` cast once FieldRendererProps.hideSubmit lands.
    const extraProps = { hideSubmit: true } as any;

    render(
      <FollowUpCadenceFieldRenderer
        fieldName="followUpDays"
        schema={{ type: "array" }}
        value={[4, 11, 25]}
        onChange={() => {}}
        label="Follow-up cadence"
        context={BASE_CONTEXT}
        {...extraProps}
      />,
    );

    // FollowUpCadenceFieldRenderer must gate the Continue button on hideSubmit.
    const btn = screen.queryByRole("button", { name: /Continue/i });
    expect(btn).toBeNull();
  });
});

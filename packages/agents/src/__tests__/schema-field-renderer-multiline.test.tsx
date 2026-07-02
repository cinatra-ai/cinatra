// @vitest-environment jsdom
/**
 * Regression coverage for multiline detection in SchemaFieldRenderer
 * (issue #815 — the `brief` setup field must render as a textarea).
 *
 * `isLikelyMultiline` decides textarea vs single-line input for plain string
 * fields. Contract under test:
 *   - explicit `x-multiline: boolean` wins over everything (existing hint)
 *   - `format: "multiline"` opts in (OAS-authorable — both inputSchema
 *     pipelines propagate `format` verbatim from StartNode inputs)
 *   - description > 80 chars keeps the existing heuristic
 *   - bare string schema stays a single-line input
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/schema-field-renderer-multiline.test.tsx
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Stub lucide-react so jsdom does not hit React-version mismatches.
// (Same pattern as schema-field-renderer-hide-submit.test.tsx.)
// ---------------------------------------------------------------------------
vi.mock("lucide-react", () => ({
  LinkIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "link", className }),
  MailIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "mail", className }),
  ChevronDown: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "chevron-down", className }),
  ChevronUp: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "chevron-up", className }),
  Check: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "check", className }),
}));

import { SchemaFieldRenderer } from "../schema-field-renderer";

// Minimal FieldRendererContext — connectedApps=[] is the default.
const BASE_CONTEXT = { connectedApps: [] as string[] };

function renderField(schema: Record<string, unknown>) {
  return render(
    <SchemaFieldRenderer
      fieldName="brief"
      schema={schema}
      value=""
      onChange={() => {}}
      context={BASE_CONTEXT}
    />,
  );
}

describe("SchemaFieldRenderer multiline detection", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a bare string schema as a single-line input (baseline)", () => {
    const { container } = renderField({ type: "string", title: "brief" });
    expect(container.querySelector("textarea#field-brief")).toBeNull();
    expect(container.querySelector("input#field-brief")).not.toBeNull();
  });

  it('renders format: "multiline" as a textarea', () => {
    const { container } = renderField({
      type: "string",
      title: "brief",
      format: "multiline",
    });
    expect(container.querySelector("textarea#field-brief")).not.toBeNull();
    expect(container.querySelector("input#field-brief")).toBeNull();
  });

  it("still renders x-multiline: true as a textarea (existing hint)", () => {
    const { container } = renderField({
      type: "string",
      title: "brief",
      "x-multiline": true,
    });
    expect(container.querySelector("textarea#field-brief")).not.toBeNull();
  });

  it('explicit x-multiline: false overrides format: "multiline"', () => {
    const { container } = renderField({
      type: "string",
      title: "brief",
      "x-multiline": false,
      format: "multiline",
    });
    expect(container.querySelector("textarea#field-brief")).toBeNull();
    expect(container.querySelector("input#field-brief")).not.toBeNull();
  });

  it("still renders a >80-char description as a textarea (existing heuristic)", () => {
    const { container } = renderField({
      type: "string",
      title: "brief",
      description: "x".repeat(81),
    });
    expect(container.querySelector("textarea#field-brief")).not.toBeNull();
  });

  it('does not hijack recognized string formats — format: "uri" keeps the URL input', () => {
    const { container } = renderField({
      type: "string",
      title: "brief",
      format: "uri",
    });
    expect(container.querySelector("textarea#field-brief")).toBeNull();
    expect(container.querySelector("input#field-brief")).not.toBeNull();
  });
});

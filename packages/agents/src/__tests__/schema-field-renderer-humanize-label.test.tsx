// @vitest-environment jsdom
/**
 * Real-DOM coverage for issue #1162: setup / HITL field labels must be
 * humanized even when the agent OAS emits `title === fieldName` (the raw
 * camelCase key). #844 humanized the *no-title* fallback, but a title equal to
 * the key slipped past it — the explicit (camelCase) title won and the
 * humanizer never ran. The label now routes through `resolveFieldLabel`, which
 * treats a title equal to the field key as absent and humanizes it.
 *
 * This renders the REAL SchemaFieldRenderer to a jsdom DOM and asserts the
 * visible label text — the same component grouped-setup-form-renderer and the
 * HITL panels delegate their basic fields to.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/schema-field-renderer-humanize-label.test.tsx
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Stub lucide-react so jsdom does not hit React-version mismatches.
// (Same pattern as schema-field-renderer-multiline.test.tsx.)
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

function renderField(fieldName: string, schema: Record<string, unknown>) {
  return render(
    <SchemaFieldRenderer
      fieldName={fieldName}
      schema={schema}
      value=""
      onChange={() => {}}
      context={BASE_CONTEXT}
    />,
  );
}

describe("SchemaFieldRenderer — label humanization when title === fieldName (issue #1162)", () => {
  afterEach(() => {
    cleanup();
  });

  it("humanizes a camelCase key whose schema title equals the key", () => {
    renderField("companyUrl", { type: "string", title: "companyUrl" });
    // The humanized measure is shown …
    expect(screen.getByText(/Company URL/)).toBeTruthy();
    // … and the raw camelCase key never appears verbatim as a label.
    expect(screen.queryByText("companyUrl")).toBeNull();
  });

  it("humanizes referenceContent (title === key)", () => {
    renderField("referenceContent", {
      type: "string",
      title: "referenceContent",
    });
    expect(screen.getByText(/Reference Content/)).toBeTruthy();
    expect(screen.queryByText("referenceContent")).toBeNull();
  });

  it("humanizes a numeric field whose title equals the key (imageCount)", () => {
    renderField("imageCount", { type: "number", title: "imageCount" });
    expect(screen.getByText(/Image Count/)).toBeTruthy();
    expect(screen.queryByText("imageCount")).toBeNull();
  });

  it("humanizes a bare lowercase key whose title equals it (brief)", () => {
    renderField("brief", { type: "string", title: "brief" });
    expect(screen.getByText(/Brief/)).toBeTruthy();
  });

  it("still shows a genuinely meaningful title verbatim (title !== key)", () => {
    renderField("companyUrl", { type: "string", title: "Company Website" });
    expect(screen.getByText(/Company Website/)).toBeTruthy();
  });
});

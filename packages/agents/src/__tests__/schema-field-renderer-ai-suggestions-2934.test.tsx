// @vitest-environment jsdom
/**
 * THE FLOOR HONOURS THE SHARED `aiSuggestions` CONTRACT FOR ITS OWN FIELD
 * (cinatra#2934, fix leg 13).
 *
 * The shared props contract (`@cinatra-ai/sdk-ui` field-renderer-props):
 * "Stable AI-suggestion payload from the parent's sticky-bottom PromptField.
 * Renderers use `useEffect([aiSuggestions])` to sync local state". Both setup
 * surfaces pass it; the schema-field floor did not read it, and for a string
 * field the panels' `value` is the whole envelope — so a window fill never
 * reached the field the person was looking at.
 *
 * S1 pins the reading of the payload; S2 pins what it must NOT do: a payload
 * without this field's key, and a re-render with a new envelope but the SAME
 * payload object, leave a typed edit alone.
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/schema-field-renderer-ai-suggestions-2934.test.tsx
 */
import React from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  ArrowRight: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "arrow-right", className }),
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

/** The round's own words. */
const W = "Why self-hosted upgrades take longer than planned";

const IDEA_SCHEMA = {
  type: "string",
  "x-multiline": true,
  "x-placeholder": "Paste one idea, or type what this post should be about",
};

const BASE_CONTEXT = { connectedApps: [] as string[] };

type FloorProps = React.ComponentProps<typeof SchemaFieldRenderer>;

function floor(extra: Partial<FloorProps>) {
  return (
    <SchemaFieldRenderer
      fieldName="idea"
      schema={IDEA_SCHEMA}
      // The per-field panels hand a string field the whole values envelope.
      value={{ runName: "Run 1" }}
      onChange={() => {}}
      context={BASE_CONTEXT}
      bypassRegistry
      {...extra}
    />
  );
}

const textarea = (container: HTMLElement) =>
  container.querySelector("textarea#field-idea") as HTMLTextAreaElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  vi.doUnmock("lucide-react");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("SchemaFieldRenderer reads its own field from aiSuggestions (cinatra#2934)", () => {
  it("S1 — an envelope `value` without the field, and aiSuggestions naming it: the textarea shows the suggestion", () => {
    const { container } = render(floor({ aiSuggestions: { idea: W } }));
    expect(textarea(container)).not.toBeNull();
    expect(textarea(container).value).toBe(W);
  });

  it("S2 — a payload without this field's key, or the SAME payload on a new envelope, leaves a typed edit alone", () => {
    const { container, rerender } = render(floor({}));
    fireEvent.change(textarea(container), { target: { value: "my own words" } });
    expect(textarea(container).value).toBe("my own words");

    // A payload that names another field only.
    rerender(floor({ aiSuggestions: { audience: "Operators" } }));
    expect(textarea(container).value).toBe("my own words");

    // The SAME payload object — here one that DOES name this field —
    // re-rendered under a NEW envelope `value` (the panels rebuild it on every
    // poll tick) after the person edited the field: the edit is not overwritten.
    const sameSuggestions = { idea: W };
    rerender(floor({ aiSuggestions: sameSuggestions }));
    fireEvent.change(textarea(container), { target: { value: "edited again" } });
    rerender(floor({ value: { runName: "Run 1", other: 2 }, aiSuggestions: sameSuggestions }));
    expect(textarea(container).value).toBe("edited again");
  });
});

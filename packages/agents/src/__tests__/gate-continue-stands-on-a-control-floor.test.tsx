// @vitest-environment jsdom
/**
 * THE GATE'S CONTINUE STANDS ON THE CONTROL FLOOR (cinatra#3047, fix leg 8).
 *
 * The ratified drawing, `specs/app-artifact-review.html` section I:
 *
 *   "the primary Continue, right-aligned over a hairline floor: the same
 *    control floor every gate page draws"
 *
 * and the drawing's own markup for that floor is a right-aligned row over a
 * one-pixel line rule, with the arrow glyph after the word.
 *
 * THE REGRESSION THE EIGHTH PROOF ROUND PHOTOGRAPHED: on the run page's input
 * step the gate's Continue was drawn in a bare box — left-aligned, no rule
 * above it and no glyph — because every single-field branch of the schema
 * renderer wrapped its own button in a plain `div`. The card-level floor the
 * approval card draws (`flex justify-end pt-2 border-t border-line`, arrow
 * after the word) is the one the drawing fixes, and it is the same floor
 * "every gate page draws", so the renderer's own submit takes it too.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/gate-continue-stands-on-a-control-floor.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const StubIcon = ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "stub", className });
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
  });
});

import { SchemaFieldRenderer } from "../schema-field-renderer";

const BASE_CONTEXT = { connectedApps: [] as string[] };

afterEach(() => cleanup());

function floorOfTheContinue(): HTMLElement {
  const button = screen.getByRole("button", { name: /Continue/i });
  const floor = button.parentElement;
  expect(floor).not.toBeNull();
  return floor as HTMLElement;
}

function renderField(schema: Record<string, unknown>, value: unknown = "") {
  return render(
    <SchemaFieldRenderer
      fieldName="spec"
      schema={schema}
      value={value}
      onChange={() => {}}
      context={BASE_CONTEXT}
      bypassRegistry
    />,
  );
}

const FIELDS: Array<[string, Record<string, unknown>, unknown]> = [
  ["a plain string field", { type: "string", title: "Spec" }, ""],
  ["a multiline string field", { type: "string", title: "Spec", "x-multiline": true }, ""],
  ["a number field", { type: "number", title: "Count" }, 1],
  ["an integer field", { type: "integer", title: "Count" }, 1],
  ["an array field", { type: "array", title: "Lines" }, []],
  ["a url field", { type: "string", format: "uri", title: "Site" }, ""],
  ["an email field", { type: "string", format: "email", title: "Mail" }, ""],
  [
    "an object field",
    { type: "object", title: "Payload", properties: {} },
    {},
  ],
];

describe("every gate page draws the same control floor", () => {
  for (const [name, schema, value] of FIELDS) {
    it(`right-aligns the Continue over a hairline rule on ${name}`, () => {
      renderField(schema, value);
      const floor = floorOfTheContinue();
      expect(floor.className).toContain("justify-end");
      expect(floor.className).toContain("border-t");
    });

    it(`draws the glyph after the word on ${name}`, () => {
      renderField(schema, value);
      const button = screen.getByRole("button", { name: /Continue/i });
      expect(button.querySelector("[data-icon]")).not.toBeNull();
    });
  }

  it("draws no floor at all where the submit is hidden — the form owns one control", () => {
    render(
      <SchemaFieldRenderer
        fieldName="spec"
        schema={{ type: "string", title: "Spec" }}
        value=""
        onChange={() => {}}
        context={BASE_CONTEXT}
        bypassRegistry
        hideSubmit
      />,
    );
    expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
  });
});

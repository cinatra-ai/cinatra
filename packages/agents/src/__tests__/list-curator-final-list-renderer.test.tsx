// @vitest-environment jsdom
/**
 * Vitest coverage for ListCuratorFinalListRenderer.
 *
 * Asserts:
 *   - The strict-equality predicate matches ONLY final-list-review.
 *   - Mounts render the listName Input, the memberRefs preview, and the
 *     Approve list + Cancel buttons.
 *   - Approve emits onChange({approved: true, listName}).
 *   - Cancel emits onChange({approved: false}).
 *   - Approve is disabled when listName is empty.
 *   - Failures section renders when failures.length > 0.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/list-curator-final-list-renderer.test.tsx
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { ListCuratorFinalListRenderer } from "../list-curator-final-list-renderer";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import type { FieldRendererContext } from "../field-renderer-registry";

const MINIMAL_CONTEXT: FieldRendererContext = { connectedApps: [] };

const BASE_VALUE = {
  listName: "YC W24 Founders",
  memberRefs: [
    {
      objectType: "@cinatra-ai/entity-accounts:account",
      objectId: "acc_1",
      displayName: "Acme Corp",
    },
    {
      objectType: "@cinatra-ai/entity-contacts:contact",
      objectId: "ct_1",
      displayName: "Jane Founder",
      accountId: "acc_1",
    },
  ],
  memberCount: 2,
  accountsCreated: 1,
  contactsCreated: 1,
  failures: [],
};

function renderField(overrides: { value?: unknown } = {}) {
  const onChange = vi.fn();
  return {
    onChange,
    ...render(
      <ListCuratorFinalListRenderer
        fieldName="finalList"
        schema={{ "x-renderer": "@cinatra-ai/list-curator-agent:final-list-review" }}
        value={overrides.value ?? BASE_VALUE}
        onChange={onChange}
        context={MINIMAL_CONTEXT}
      />,
    ),
  };
}

describe("ListCuratorFinalListRenderer", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("the registry resolves only the exact final-list-review id to this renderer", () => {
    // Registry-driven condition (cinatra#151 Stage 5): the id comes from the
    // list-curator-agent's manifest binding (kind "final-list-review").
    ensureDefaultFieldRenderersRegistered();
    const resolveFor = (schema: Record<string, unknown>) =>
      fieldRendererRegistry.resolve("", schema, MINIMAL_CONTEXT)?.renderer ?? null;
    expect(
      resolveFor({ "x-renderer": "@cinatra-ai/list-curator-agent:final-list-review" }),
    ).toBe(ListCuratorFinalListRenderer);
    expect(
      resolveFor({ "x-renderer": "@cinatra-ai/list-curator-agent:scrape-schema-review" }),
    ).not.toBe(ListCuratorFinalListRenderer);
    expect(resolveFor({})).not.toBe(ListCuratorFinalListRenderer);
  });

  it("renders List name input, memberRefs preview, Approve list + Cancel buttons", () => {
    renderField();
    expect(screen.getByLabelText(/list name/i)).toBeDefined();
    expect(screen.getByDisplayValue("YC W24 Founders")).toBeDefined();
    expect(screen.getByText("Acme Corp")).toBeDefined();
    expect(screen.getByText("Jane Founder")).toBeDefined();
    expect(screen.getByRole("button", { name: /approve list/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDefined();
  });

  it("Approve list calls onChange with approved:true + listName", () => {
    const { onChange } = renderField();
    fireEvent.click(screen.getByRole("button", { name: /approve list/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({
      approved: true,
      listName: "YC W24 Founders",
    });
  });

  it("Cancel button calls onChange with approved:false", () => {
    const { onChange } = renderField();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ approved: false });
  });

  it("Approve list is disabled when listName is empty", () => {
    renderField({ value: { ...BASE_VALUE, listName: "" } });
    const btn = screen.getByRole("button", {
      name: /approve list/i,
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("renders failures section when failures.length > 0", () => {
    renderField({
      value: {
        ...BASE_VALUE,
        failures: [
          { rowIndex: 2, stage: "company-discovery", error: "no_domain" },
        ],
      },
    });
    expect(screen.getByText(/company-discovery/i)).toBeDefined();
    expect(screen.getByText(/no_domain/i)).toBeDefined();
    expect(screen.getByText(/failures \(1\)/i)).toBeDefined();
  });
});

// @vitest-environment jsdom
/**
 * Vitest coverage for BlogWordpressDraftConfirmRenderer.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { BlogWordpressDraftConfirmRenderer } from "../blog-wordpress-draft-confirm-renderer";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import type { FieldRendererContext } from "../field-renderer-registry";

const MINIMAL_CONTEXT: FieldRendererContext = { connectedApps: [] };

const BASE_VALUE = {
  wordpressDraftId: "wp-99",
  wordpressAdminUrl: "https://wp.example.com/wp-admin/post.php?post=12&action=edit",
  wordpressInstanceId: "wp-instance-1",
};

function renderField(overrides: { value?: unknown } = {}) {
  const onChange = vi.fn();
  return {
    onChange,
    ...render(
      <BlogWordpressDraftConfirmRenderer
        fieldName="draftConfirm"
        schema={{ "x-renderer": "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm" }}
        value={overrides.value ?? BASE_VALUE}
        onChange={onChange}
        context={MINIMAL_CONTEXT}
      />,
    ),
  };
}

afterEach(() => {
  cleanup();
});

describe("wordpress draft-confirm registry resolution", () => {
  // Registry-driven condition (cinatra#151 Stage 5): the id comes from the
  // blog-wordpress-publish-agent's manifest binding.
  const resolveFor = (schema: Record<string, unknown>) =>
    fieldRendererRegistry.resolve("draftConfirm", schema, MINIMAL_CONTEXT)?.renderer ?? null;
  it("matches strict equality on the renderer key", () => {
    ensureDefaultFieldRenderersRegistered();
    expect(
      resolveFor({ "x-renderer": "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm" }),
    ).toBe(BlogWordpressDraftConfirmRenderer);
  });

  it("rejects other renderer keys", () => {
    ensureDefaultFieldRenderersRegistered();
    expect(
      resolveFor({ "x-renderer": "@cinatra-ai/blog-linkedin-publish-agent:draft-review" }),
    ).not.toBe(BlogWordpressDraftConfirmRenderer);
  });
});

describe("BlogWordpressDraftConfirmRenderer", () => {
  it("renders the admin URL as a clickable link", () => {
    renderField();
    const link = screen.getByRole("link", { name: /open wordpress draft/i });
    expect(link.getAttribute("href")).toBe(BASE_VALUE.wordpressAdminUrl);
  });

  it("Confirm emits approved:true with wordpressDraftId", () => {
    const { onChange } = renderField();
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(onChange).toHaveBeenLastCalledWith({
      approved: true,
      wordpressDraftId: "wp-99",
    });
  });

  it("Reject emits approved:false with wordpressDraftId (agent then calls delete with deleteInWordPress=true)", () => {
    const { onChange } = renderField();
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(onChange).toHaveBeenLastCalledWith({
      approved: false,
      wordpressDraftId: "wp-99",
    });
  });

  it("shows the instanceId when present", () => {
    renderField();
    expect(screen.getByText(/wp-instance-1/)).toBeTruthy();
  });

  // Guard against a mount race where the field snapshot arrives without a
  // wordpressDraftId. Buttons stay disabled and clicks
  // do not emit a `{ wordpressDraftId: "" }` payload.
  it("Confirm and Reject buttons stay disabled when wordpressDraftId is empty", () => {
    const { onChange } = renderField({
      value: { ...BASE_VALUE, wordpressDraftId: "" },
    });
    const confirm = screen.getByRole("button", { name: /^confirm$/i }) as HTMLButtonElement;
    const reject = screen.getByRole("button", { name: /reject/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    fireEvent.click(reject);
    expect(onChange).not.toHaveBeenCalled();
  });
});

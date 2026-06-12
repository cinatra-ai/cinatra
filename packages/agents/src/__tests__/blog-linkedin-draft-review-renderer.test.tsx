// @vitest-environment jsdom
/**
 * Vitest coverage for BlogLinkedinDraftReviewRenderer.
 *
 * Asserts:
 *   - Predicate matches ONLY blog-linkedin-publish-agent:draft-review
 *   - Mounts render the textarea pre-filled with the proposed content +
 *     Approve + Reject buttons.
 *   - Approve emits onChange({ approved: true, linkedinDraftId, content })
 *     with the current textarea contents (so operator edits flow through).
 *   - Reject emits onChange({ approved: false, linkedinDraftId })
 *   - Approve is disabled when content is empty.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { BlogLinkedinDraftReviewRenderer } from "../blog-linkedin-draft-review-renderer";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import type { FieldRendererContext } from "../field-renderer-registry";

const MINIMAL_CONTEXT: FieldRendererContext = { connectedApps: [] };

const BASE_VALUE = {
  linkedinDraftId: "lkd-42",
  content: "Proposed LinkedIn post copy. https://example.com/blog/post",
  linkedinAccountName: "Cinatra",
  destinationName: "Cinatra Page",
  destinationType: "organization" as const,
  blogPostUrl: "https://example.com/blog/post",
};

function renderField(overrides: { value?: unknown } = {}) {
  const onChange = vi.fn();
  return {
    onChange,
    ...render(
      <BlogLinkedinDraftReviewRenderer
        fieldName="draftReview"
        schema={{ "x-renderer": "@cinatra-ai/blog-linkedin-publish-agent:draft-review" }}
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

describe("linkedin draft-review registry resolution", () => {
  // Registry-driven condition (cinatra#151 Stage 5): the id comes from the
  // blog-linkedin-publish-agent's manifest binding.
  const resolveFor = (schema: Record<string, unknown>) =>
    fieldRendererRegistry.resolve("draftReview", schema, MINIMAL_CONTEXT)?.renderer ?? null;
  it("matches strict equality on the renderer key", () => {
    ensureDefaultFieldRenderersRegistered();
    expect(
      resolveFor({ "x-renderer": "@cinatra-ai/blog-linkedin-publish-agent:draft-review" }),
    ).toBe(BlogLinkedinDraftReviewRenderer);
  });

  it("rejects other renderer keys", () => {
    ensureDefaultFieldRenderersRegistered();
    expect(
      resolveFor({ "x-renderer": "@cinatra-ai/list-curator-agent:final-list-review" }),
    ).not.toBe(BlogLinkedinDraftReviewRenderer);
    expect(resolveFor({})).not.toBe(BlogLinkedinDraftReviewRenderer);
  });
});

describe("BlogLinkedinDraftReviewRenderer", () => {
  it("renders the textarea pre-filled with proposed content", () => {
    renderField();
    const textarea = screen.getByLabelText("LinkedIn post content") as HTMLTextAreaElement;
    expect(textarea.value).toBe(BASE_VALUE.content);
  });

  it("Approve emits operator-edited content via onChange", () => {
    const { onChange } = renderField();
    const textarea = screen.getByLabelText("LinkedIn post content") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Edited LinkedIn copy by operator." } });
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onChange).toHaveBeenLastCalledWith({
      approved: true,
      linkedinDraftId: "lkd-42",
      content: "Edited LinkedIn copy by operator.",
    });
  });

  it("Reject emits approved:false with linkedinDraftId", () => {
    const { onChange } = renderField();
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(onChange).toHaveBeenLastCalledWith({
      approved: false,
      linkedinDraftId: "lkd-42",
    });
  });

  it("Approve button is disabled when content is empty", () => {
    renderField({ value: { ...BASE_VALUE, content: "" } });
    const approve = screen.getByRole("button", { name: /approve/i }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
  });

  it("shows context (account, destination, blogPostUrl) when present", () => {
    renderField();
    expect(screen.getByText(/Cinatra Page/)).toBeTruthy();
    expect(screen.getByText(/Account:/)).toBeTruthy();
    const link = screen.getByRole("link", {
      name: "https://example.com/blog/post",
    });
    expect(link.getAttribute("href")).toBe("https://example.com/blog/post");
  });

  // Guard against mount-race where the field-snapshot arrives without a
  // linkedinDraftId. Buttons must stay disabled and clicks must not emit a
  // `{ linkedinDraftId: "" }` payload.
  it("Approve and Reject buttons stay disabled when linkedinDraftId is empty", () => {
    const { onChange } = renderField({
      value: {
        ...BASE_VALUE,
        linkedinDraftId: "",
      },
    });
    const approve = screen.getByRole("button", { name: /approve/i }) as HTMLButtonElement;
    const reject = screen.getByRole("button", { name: /reject/i }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    // Even if the click somehow fires (e.g. assistive tech), the handler
    // must early-return rather than emit an empty draftId.
    fireEvent.click(reject);
    expect(onChange).not.toHaveBeenCalled();
  });
});

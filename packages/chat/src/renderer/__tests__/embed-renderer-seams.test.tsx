// @vitest-environment jsdom
// S5 (cinatra#1221) Lane B — the renderer trust-boundary seams the embed adds:
//   §6h: scheme-allowlist the reducer-fed citation Link href (CitationsList).
//   §6e: the apply-intent gesture seam on the content_change_proposal card —
//        emitted ONLY on an explicit click, NEVER auto-emitted on render.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import { CitationsList } from "../ag-ui-interactive";
import { ContentChangeProposalCard } from "../../renderable-views/index";
import type { ContentChangeProposalView } from "@cinatra-ai/agent-ui-protocol/renderable-views";

afterEach(cleanup);

describe("§6h — CitationsList scheme allowlist", () => {
  it("renders a safe https citation as an active link", () => {
    const { container } = render(
      <CitationsList citations={[{ url: "https://good.example.com/x", title: "Good", index: 0 }]} />,
    );
    const a = container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("https://good.example.com/x");
  });

  it("renders a javascript: citation as INERT text — never an active href", () => {
    const { container, getByText } = render(
      // eslint-disable-next-line no-script-url
      <CitationsList citations={[{ url: "javascript:alert(1)", title: "Evil", index: 0 }]} />,
    );
    // No anchor carrying the dangerous scheme.
    const anchors = Array.from(container.querySelectorAll("a"));
    expect(anchors.some((a) => (a.getAttribute("href") ?? "").includes("javascript:"))).toBe(false);
    // The label still shows (as text).
    expect(getByText("Evil")).toBeTruthy();
  });

  it("drops a protocol-relative citation to inert text", () => {
    const { container } = render(
      <CitationsList citations={[{ url: "//evil.example.com/x", title: "PR", index: 0 }]} />,
    );
    expect(container.querySelector("a")).toBeNull();
  });
});

function proposalView(overrides: Partial<ContentChangeProposalView> = {}): ContentChangeProposalView {
  return {
    viewType: "content_change_proposal",
    fields: [],
    ...overrides,
  } as ContentChangeProposalView;
}

describe("§6e — content_change_proposal apply-intent gesture seam", () => {
  it("with NO handler the card is DISPLAY-ONLY (no apply button)", () => {
    const { container } = render(
      <ContentChangeProposalCard view={proposalView({ proposalId: "p1" })} />,
    );
    expect(container.querySelector("[data-apply-intent]")).toBeNull();
  });

  it("does NOT auto-emit on render — only an explicit click fires onApplyIntent", () => {
    const onApplyIntent = vi.fn();
    const { container } = render(
      <ContentChangeProposalCard view={proposalView({ proposalId: "p1" })} onApplyIntent={onApplyIntent} />,
    );
    expect(onApplyIntent).not.toHaveBeenCalled(); // no auto-emit
    const btn = container.querySelector("[data-apply-intent]") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(onApplyIntent).toHaveBeenCalledWith({
      proposalId: "p1",
      viewType: "content_change_proposal",
    });
  });

  it("prefers a changeSetId selector when there is no proposalId", () => {
    const onApplyIntent = vi.fn();
    const { container } = render(
      <ContentChangeProposalCard view={proposalView({ changeSetId: "cs1" })} onApplyIntent={onApplyIntent} />,
    );
    fireEvent.click(container.querySelector("[data-apply-intent]") as HTMLButtonElement);
    expect(onApplyIntent).toHaveBeenCalledWith({
      changeSetId: "cs1",
      viewType: "content_change_proposal",
    });
  });

  it("a display-only card (no correlation id) shows no apply affordance even with a handler", () => {
    const onApplyIntent = vi.fn();
    const { container } = render(
      <ContentChangeProposalCard view={proposalView()} onApplyIntent={onApplyIntent} />,
    );
    expect(container.querySelector("[data-apply-intent]")).toBeNull();
  });
});

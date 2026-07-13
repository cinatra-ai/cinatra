// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

// Unmount between tests: repeated renders of the same fixture otherwise pile
// up in the shared jsdom body and text queries match duplicates.
afterEach(cleanup);

// Import through the reusable renderer barrel (S3 #1219 boundary) so the S4
// views are pinned as part of the PUBLIC embed entry every surface consumes.
import {
  RenderableViewCard,
  ContentChangeProposalCard,
  ArtifactPreviewCard,
  CitationGroupCard,
  ChangeHistoryCard,
} from "../renderer";
import {
  validRenderableViewFixtures as valid,
  hostileRenderableViewFixtures as hostile,
} from "../renderable-views/fixtures";
import { parseRenderableView } from "@cinatra-ai/agent-ui-protocol/renderable-views";

// Helper: parse a fixture into its typed view (fixtures are raw wire payloads).
function parsedOr<T>(raw: unknown): T {
  const p = parseRenderableView(raw);
  if (p === null) throw new Error("fixture expected to be valid");
  return p as T;
}

describe("per-view render (each registered renderable renders its content)", () => {
  it("content_change_proposal — renders field diff + target", () => {
    const { container, getByText } = render(
      <ContentChangeProposalCard view={parsedOr(valid.content_change_proposal)} />,
    );
    expect(container.querySelector('[data-view-type="content_change_proposal"]')).toBeTruthy();
    expect(getByText("New title")).toBeTruthy();
    expect(getByText("Old title")).toBeTruthy();
    expect(getByText("post #42")).toBeTruthy();
  });

  it("content_change_proposal — draft-correlated payload renders the applied/refresh affordance (Option A)", () => {
    const { container, getByText } = render(
      <ContentChangeProposalCard view={parsedOr(valid.content_change_proposal)} />,
    );
    const affordance = container.querySelector('[data-affordance="applied-refresh"]');
    expect(affordance).toBeTruthy();
    // The correlation ids ride as data attributes for the S5 editor-patch
    // consumer to key on.
    expect(affordance?.getAttribute("data-proposal-id")).toBe("wp-42-prop-1");
    expect(affordance?.getAttribute("data-change-set-id")).toBe("rev-311");
    expect(getByText("draft saved")).toBeTruthy();
    expect(getByText(/applying refreshes the editor/i)).toBeTruthy();
    // DISPLAY-ONLY on this surface: no interactive control is wired (the
    // refresh executor is the S5 CMS-widget consumer).
    expect(affordance?.querySelector("button")).toBeNull();
    expect(affordance?.querySelector("a")).toBeNull();
  });

  it("content_change_proposal — no applied/refresh affordance without correlation ids", () => {
    const { container } = render(
      <ContentChangeProposalCard view={parsedOr(valid.content_change_proposal_rich)} />,
    );
    expect(container.querySelector('[data-affordance="applied-refresh"]')).toBeNull();
  });

  it("content_change_proposal (rich, no fields) — shows the rich-edit note", () => {
    const { getByText } = render(
      <ContentChangeProposalCard view={parsedOr(valid.content_change_proposal_rich)} />,
    );
    expect(getByText(/Rich content edit/i)).toBeTruthy();
  });

  it("artifact_preview — renders name as a safe link", () => {
    const { getByText } = render(
      <ArtifactPreviewCard view={parsedOr(valid.artifact_preview)} />,
    );
    const link = getByText("quarterly-report.pdf") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://example.com/quarterly-report.pdf");
  });

  it("citation_group — renders sources; unlinked source has no anchor", () => {
    const { getByText } = render(
      <CitationGroupCard view={parsedOr(valid.citation_group)} />,
    );
    expect((getByText("Cinatra docs") as HTMLElement).tagName).toBe("A");
    expect((getByText("An unlinked source") as HTMLElement).tagName).not.toBe("A");
  });

  it("change_history — renders entries + undoable badge", () => {
    const { getByText, getAllByText } = render(
      <ChangeHistoryCard view={parsedOr(valid.change_history)} />,
    );
    expect(getByText("Updated the page title")).toBeTruthy();
    expect(getAllByText("undoable").length).toBe(1);
  });
});

describe("dispatcher (RenderableViewCard) validates + dispatches + falls back", () => {
  it("dispatches a valid payload to its registered component", () => {
    const { container } = render(<RenderableViewCard data={valid.artifact_preview} />);
    expect(container.querySelector('[data-view-type="artifact_preview"]')).toBeTruthy();
  });

  it("renders the fallback for an unknown viewType (names it)", () => {
    const { container, getByText } = render(
      <RenderableViewCard data={hostile.unknown_view} />,
    );
    expect(container.querySelector('[data-view-type="__fallback__"]')).toBeTruthy();
    expect(getByText(/some_future_view_v9/)).toBeTruthy();
  });

  it("renders the fallback for a forward-incompatible schemaVersion of a known view", () => {
    const { container } = render(
      <RenderableViewCard data={hostile.future_version_change_proposal} />,
    );
    expect(container.querySelector('[data-view-type="__fallback__"]')).toBeTruthy();
  });

  it("renders the fallback for a plain (non-view) data part, no rawViewType leak", () => {
    const { container } = render(<RenderableViewCard data={hostile.plain_data_part} />);
    expect(container.querySelector('[data-view-type="__fallback__"]')).toBeTruthy();
  });

  it("does not throw on null / primitive / array payloads", () => {
    for (const bad of [null, undefined, 5, "s", [], true]) {
      expect(() => render(<RenderableViewCard data={bad} />)).not.toThrow();
    }
  });
});

describe("XSS hardening (hostile payloads render inert)", () => {
  it("a <script>-bearing change field renders as text, not a live element", () => {
    const { container } = render(
      <RenderableViewCard data={hostile.script_in_change_field} />,
    );
    // No live <script> node injected…
    expect(container.querySelector("script")).toBeNull();
    // …and the payload survives as visible text.
    expect(container.textContent).toContain("<script>alert('xss')</script>");
  });

  it("a javascript: artifact href is dropped (no anchor href) and name text is inert", () => {
    const { container } = render(
      <RenderableViewCard data={hostile.javascript_href_artifact} />,
    );
    // Sanitized to undefined at parse → the name is plain text, no anchor.
    expect(container.querySelector("a")).toBeNull();
    // The <img ...> name string is a text node, not an injected element.
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

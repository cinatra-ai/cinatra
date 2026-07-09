/**
 * DOM render proof (server markup) for the per-source section — the spec-
 * critical rendering the unified approvals surface depends on:
 *   - a ready-but-empty envelope renders the design-system `Empty` FAMILY (the
 *     inconsistency this epic fixes), never plain text;
 *   - a source that THROWS is isolated into an inline error card with a retry
 *     affordance (Suspense does NOT isolate async RSC throws — the safe loader
 *     does), so one source failing never blanks the page;
 *   - an explicit `availability:'error'` envelope renders inline the same way;
 *   - a Next control-flow signal (redirect/notFound) is RE-THROWN untouched;
 *   - rows render through the source's own rowRenderer under a titled, anchored
 *     section with an optional "View all" drill-down.
 *
 * Rendered with react-dom/server so it needs neither a browser nor the full app
 * build (which requires the systemExtension workspace packages) — the live
 * browser floor is the CI render-smoke suite over every static route.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    createElement("a", { href, ...(rest as object) }, children as never),
}));

import { SourceSection } from "../source-section";
import type {
  ApprovalSource,
  ApprovalEnvelope,
  ApprovalViewer,
  Direction,
} from "../sources/types";

const viewer: ApprovalViewer = { userId: "u", orgId: "o", isAdmin: true };

function fakeSource(
  loader: ApprovalEnvelope | (() => Promise<ApprovalEnvelope>),
  over: Partial<ApprovalSource> = {},
): ApprovalSource {
  const fetcher = typeof loader === "function" ? loader : async () => loader;
  return {
    id: "fake",
    title: "Fake source",
    availability: () => "ready",
    appliesTo: () => true,
    fetchInbox: fetcher,
    fetchMine: fetcher,
    counts: async () => ({ inbox: 0, mine: 0 }),
    rowRenderer: (row) => createElement("div", { className: "row" }, row.title),
    actions: { decide: async () => ({ ok: true }) },
    ...over,
  };
}

async function render(source: ApprovalSource, direction: Direction = "inbox"): Promise<string> {
  const el = await SourceSection({ source, viewer, direction });
  return renderToStaticMarkup(el);
}

describe("SourceSection render — spec anatomy", () => {
  it("renders rows via the source rowRenderer under a titled, anchored section with View all", async () => {
    const src = fakeSource(
      {
        availability: "ready",
        rows: [
          {
            id: "a",
            sourceId: "fake",
            title: "Row A",
            status: "proposed",
            createdAt: new Date().toISOString(),
          },
        ],
        actions: [],
      },
      { viewAllHref: () => "/all" },
    );
    const html = await render(src);
    expect(html).toContain('id="fake"'); // section anchor for legacy ?tab= deep links
    expect(html).toContain("Fake source"); // section header title
    expect(html).toContain("Row A"); // rowRenderer output
    expect(html).toContain("View all");
    expect(html).toContain('href="/all"');
  });

  it("renders the Empty FAMILY (not plain text) for a ready-but-zero-rows envelope", async () => {
    const html = await render(fakeSource({ availability: "ready", rows: [], actions: [] }), "inbox");
    expect(html).toContain("Nothing awaiting your decision");
    expect(html.toLowerCase()).toContain("fake source");
  });

  it("ISOLATES a thrown source failure into an inline error card with retry", async () => {
    const boom = fakeSource(async () => {
      throw new Error("kaboom upstream");
    });
    const html = await render(boom, "inbox");
    expect(html).toContain("kaboom upstream");
    expect(html).toContain("Try again");
  });

  it("renders an explicit availability:'error' envelope inline", async () => {
    const src = fakeSource({
      availability: "error",
      rows: [],
      actions: [],
      error: { message: "creds rejected", retryable: true },
    });
    const html = await render(src, "inbox");
    expect(html).toContain("creds rejected");
    expect(html).toContain("Try again");
  });

  it("RE-THROWS a Next control-flow (redirect) signal untouched", async () => {
    const redirectErr = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/x;307;",
    });
    const src = fakeSource(async () => {
      throw redirectErr;
    });
    await expect(SourceSection({ source: src, viewer, direction: "inbox" })).rejects.toBe(
      redirectErr,
    );
  });
});

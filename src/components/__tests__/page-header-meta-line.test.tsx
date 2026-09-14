/**
 * THE HEADER'S MONO META LINE — wave 3 of `PLAN: Agents Lifecycle (D) — Review`
 * (cinatra#3091), fix leg, convergence round.
 *
 * The artifact page's own suite measures the MODEL and reads the page source to
 * see the model handed over. Neither renders `PageHeader`, so a header that
 * silently stopped drawing the line it was handed would still read green. This
 * renders it.
 *
 * The drawing (artifact-review §IV) puts "the artifact's display title over a
 * mono meta line" — so the line is drawn, it is mono, and it sits under the
 * title. A page that hands over no meta keeps exactly the header it had.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/page-header-title-sync", () => ({
  PageHeaderTitleSync: () => null,
}));

import { PageHeader } from "@/components/page-header";

const withMeta = renderToStaticMarkup(
  <PageHeader
    title="quarterly-chart.png"
    meta="@cinatra-ai/image-artifact:image · revision rev_11b8… · Team · Private · image/png · 2.4 MB · updated 8 minutes ago"
  />,
);
const withoutMeta = renderToStaticMarkup(<PageHeader title="quarterly-chart.png" />);

describe("the header draws the meta line it is handed", () => {
  it("draws every cell of the line, in one line", () => {
    expect(withMeta).toContain("@cinatra-ai/image-artifact:image");
    expect(withMeta).toContain("revision rev_11b8…");
    expect(withMeta).toContain("Team");
    expect(withMeta).toContain("Private");
    expect(withMeta).toContain("2.4 MB");
    expect(withMeta).not.toContain("bytes");
  });

  it("draws it mono, as the drawing draws it", () => {
    const line = withMeta.match(/<[a-z]+ class="([^"]*)"[^>]*>@cinatra-ai/);
    expect(line?.[1] ?? "").toContain("font-mono");
  });

  it("draws it beneath the title", () => {
    expect(withMeta.indexOf("quarterly-chart.png")).toBeLessThan(
      withMeta.indexOf("@cinatra-ai/image-artifact:image"),
    );
  });

  it("leaves a header that was handed none exactly as it was", () => {
    expect(withoutMeta).not.toContain("font-mono");
  });
});

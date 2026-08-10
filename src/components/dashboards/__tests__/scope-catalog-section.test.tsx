// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { ScopeCatalogSection } from "@/components/dashboards/scope-catalog-section";
import type { CatalogTemplateView } from "@/lib/dashboards/installed-catalog-contract";

// ---------------------------------------------------------------------------
// Concept B's section (cinatra#2474 PR4) — RENDER assertions, not source text.
// What it must show, and just as importantly what it must NOT: PR4 has no
// instantiate action (that is PR5), so the section may not offer one, and it may
// not link a row to a surface this actor is not guaranteed to be able to open.
// ---------------------------------------------------------------------------

const rows: CatalogTemplateView[] = [
  { templateId: "t1", name: "Pipeline health", packageName: "@cinatra-ai/a-artifact" },
  { templateId: "t2", name: "Revenue", packageName: "@cinatra-ai/b-artifact" },
];

afterEach(cleanup);

describe("<ScopeCatalogSection>", () => {
  it("renders every row with its name and its providing package", () => {
    render(<ScopeCatalogSection templates={rows} />);
    const section = screen.getByRole("region", {
      name: "Add from the installed catalog",
    });
    expect(within(section).getByText("Pipeline health")).toBeTruthy();
    expect(within(section).getByText("@cinatra-ai/a-artifact")).toBeTruthy();
    expect(within(section).getByText("Revenue")).toBeTruthy();
    expect(within(section).getByText("@cinatra-ai/b-artifact")).toBeTruthy();
    expect(section.querySelectorAll('[data-slot="catalog-row"]')).toHaveLength(2);
  });

  it("offers NO action and NO link — nothing that could be pressed to no effect", () => {
    const { container } = render(<ScopeCatalogSection templates={rows} />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelectorAll("input")).toHaveLength(0);
    // …and specifically not a DISABLED control standing in for one, which would
    // advertise the capability while refusing it.
    expect(container.querySelectorAll("[disabled]")).toHaveLength(0);
    expect(container.querySelectorAll('[aria-disabled="true"]')).toHaveLength(0);
  });

  it("states plainly that adding is unavailable, and promises nothing about when", () => {
    render(<ScopeCatalogSection templates={rows} />);
    const section = screen.getByRole("region", {
      name: "Add from the installed catalog",
    });
    expect(section.textContent).toContain("Adding one isn’t available yet");
    // No roadmap language: the section reports a fact, it does not advertise.
    expect(section.textContent).not.toMatch(/coming soon|shortly|next release/i);
    // …and no PRESENT-TENSE currentness claim: the read proves these were
    // materialized by a live extension and are still published, not that the
    // extension still ships them right now (codex convergence r1).
    expect(section.textContent).toContain("have added to this workspace");
    expect(section.textContent).not.toMatch(/what.s installed|provide to this/i);
  });

  it("renders NOTHING for an empty list — the landing passes null instead", () => {
    const { container } = render(<ScopeCatalogSection templates={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

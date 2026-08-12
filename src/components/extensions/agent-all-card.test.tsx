// @vitest-environment jsdom
/**
 * AgentAllCard — the RENDERED primary action (cinatra#2605, cinatra#2679).
 *
 * The defect this pins is a rendering lie: `/agents` offered a Run button for an
 * agent that cannot run because one of its required dependencies is not
 * installed. (The sibling case — the agent itself not installed — is no longer
 * rendered at all: cinatra#2679 removed such rows from the listing rather than
 * giving them an Install button.) The server derives the verdict; THIS card
 * renders it. So the
 * assertions here are on the produced markup — the CTA's href and accessible
 * name, the absence of the Run link and of its play glyph — not on the source
 * text that produced them.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The generated extension catalog is irrelevant to the action slot and pulls
// the whole loader map in; stub it (same convention as the other component
// suites under src/**).
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: {} }));

// next/link → a plain anchor so the rendered href is assertable.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    React.createElement("a", { href, ...rest }, children),
}));

import { AgentAllCard, type AgentAllCardRow } from "./agent-all-card";

const BASE: AgentAllCardRow = {
  key: "local:1",
  name: "Blog Draft Writer Agent",
  description: "Writes a blog draft.",
  host: "local",
  runHref: "/agents/cinatra-ai/blog-draft-writer-agent/new",
  // The listing (and its modal) is exercised by the sibling suites; this one
  // isolates the primary action slot.
  packageName: null,
  detailHref: null,
};

const render = (row: AgentAllCardRow) =>
  renderToStaticMarkup(React.createElement(AgentAllCard, { row }));

describe("AgentAllCard primary action", () => {
  it("a runnable agent renders the Run link (unchanged)", () => {
    const html = render(BASE);
    expect(html).toContain('href="/agents/cinatra-ai/blog-draft-writer-agent/new"');
    expect(html).toContain("Run");
  });

  // cinatra#2679 removed the Install variant of this slot at its ONLY producer:
  // NewAgentPage no longer lists a not-installed agent, so it never builds an
  // "Install" unavailable model. The rendering invariants that case pinned (the
  // run affordance and its solid play glyph are GONE, not relabelled) are
  // asserted here on the one verdict a listed row can still carry.
  it("a MISSING-DEPENDENCY agent renders the requirements CTA instead of Run — no run href, no play glyph", () => {
    const html = render({
      ...BASE,
      unavailable: {
        reason:
          "This agent cannot run: Context Selection Agent is not installed.",
        ctaLabel: "View requirements",
        ctaHref: "/configuration/marketplace/cinatra-ai/blog-draft-writer-agent",
        ctaAriaLabel:
          "Blog Draft Writer Agent cannot run — Context Selection Agent not installed. View requirements",
      },
    });
    expect(html).toContain('href="/configuration/marketplace/cinatra-ai/blog-draft-writer-agent"');
    expect(html).toContain("View requirements");
    expect(html).toContain(
      'aria-label="Blog Draft Writer Agent cannot run — Context Selection Agent not installed. View requirements"',
    );
    expect(html).toContain(
      'title="This agent cannot run: Context Selection Agent is not installed."',
    );
    expect(html).not.toContain("/agents/cinatra-ai/blog-draft-writer-agent/new");
    expect(html).not.toContain("lucide-play");
    expect(html).not.toContain("fill-current");
  });
});

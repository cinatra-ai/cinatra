/**
 * THE /agents "All Agents" CARD KEEPS THE RATIFIED DRAWING (cinatra#2808).
 *
 *   pnpm vitest run --config vitest.config.ts src/components/__tests__/agents-all-agents-card-keeps-the-drawing-2808.test.tsx
 *
 * The drawing rules this surface is the Installed-extensions card "but without
 * the version and the Active / Archived indicator". The per-scope Agents tabs
 * of cinatra#2808 need both, so the SHARED card learned them BY NAME — and the
 * /agents row model has carried a `version` of its own all along. Handing the
 * whole row to the card would therefore have started rendering a version here.
 *
 * This is the BEHAVIOURAL guard for that: a row shaped exactly as
 * `NewAgentPage` builds it (version and all) is rendered through the real
 * client, and the drawing's two negatives are read off the MARKUP — not off the
 * source text, which cannot see a value forwarded inside a row object.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/marketplace-detail-actions", () => ({
  getAgentMarketplaceDetailAction: async () => ({ status: "error", message: "stub" }),
}));

// Imported by path: the /agents client is not a published subpath of the
// agents package, and this suite must render the REAL renderer rather than a
// restatement of it.
import {
  AgentRunClient,
  type AgentRunRowModel,
} from "../../../packages/agents/src/agent-run-client";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

/** Exactly the shape `NewAgentPage` maps a local template to. */
const ROW: AgentRunRowModel = {
  key: "local:t1",
  name: "Research Assistant",
  description: "Gathers sources, summarises, and cites answers.",
  version: "1.4.0",
  skills: ["research"],
  host: "local",
  runHref: "/agents/acme/research-assistant/new",
  packageName: "@acme/research-assistant",
  detailHref: "/configuration/marketplace/acme/research-assistant",
  unavailable: null,
};

describe("/agents All Agents card", () => {
  it("renders NO version, even though the row model carries one", () => {
    const html = renderToStaticMarkup(<AgentRunClient rows={[ROW]} />);
    expect(html).toContain("Research Assistant");
    expect(html).not.toContain("1.4.0");
    expect(html).not.toContain("v1.4.0");
  });

  it("renders NO Active / Archived indicator and NO per-entry Settings control", () => {
    const html = renderToStaticMarkup(<AgentRunClient rows={[ROW]} />);
    expect(html).not.toContain('data-slot="installed-status-indicator"');
    expect(html).not.toContain('data-slot="agent-card-settings"');
  });

  it("keeps Run as the primary action", () => {
    const html = renderToStaticMarkup(<AgentRunClient rows={[ROW]} />);
    expect(html).toContain('href="/agents/acme/research-assistant/new"');
    expect(html).toContain(">Run<");
  });
});

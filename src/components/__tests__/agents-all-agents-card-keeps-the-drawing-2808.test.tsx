/**
 * THE /agents "All Agents" CARD KEEPS THE RATIFIED DRAWING (cinatra#2808).
 *
 *   pnpm vitest run --config vitest.config.ts src/components/__tests__/agents-all-agents-card-keeps-the-drawing-2808.test.tsx
 *
 * The drawing rules this surface is the Installed-extensions card "but without
 * the version and the Active / Archived indicator". The card carried both BY
 * NAME for a while, so a row could hand them in and start rendering them here.
 * design#156 removed that possibility at the source: the §IV card has no
 * version and no status indicator AT ALL, on any surface that draws it.
 *
 * This is the BEHAVIOURAL guard for that: rows are rendered through the real
 * client (and, for the smuggling case, through the real card), and the
 * drawing's two negatives are read off the MARKUP — not off the source text,
 * which cannot see a value forwarded inside a row object.
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
import { AgentAllCard, type AgentAllCardRow } from "@/components/extensions/agent-all-card";

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

/**
 * A row that SMUGGLES the two removed fields past the type (design#156 took
 * `version` and `status` off the card, so no caller can pass them any more).
 * The card must render neither even when they arrive anyway — that is what
 * "the card carries NO version and NO status indicator" means in the markup.
 */
const SMUGGLED_ROW = {
  key: "@acme/research-assistant",
  name: "Research Assistant",
  description: "Gathers sources, summarises, and cites answers.",
  host: "local",
  runHref: "/agents/acme/research-assistant/new",
  packageName: "@acme/research-assistant",
  detailHref: null,
  version: "v9.9.9",
  status: "locked",
} as unknown as AgentAllCardRow;

describe("/agents All Agents card", () => {
  it("renders NO version, even though the row model carries one", () => {
    const html = renderToStaticMarkup(<AgentRunClient rows={[ROW]} />);
    expect(html).toContain("Research Assistant");
    expect(html).not.toContain("1.4.0");
    expect(html).not.toContain("v1.4.0");
  });

  it("renders NO Active / Archived indicator", () => {
    const html = renderToStaticMarkup(<AgentRunClient rows={[ROW]} />);
    expect(html).not.toContain('data-slot="installed-status-indicator"');
  });

  it("keeps Run as the primary action", () => {
    const html = renderToStaticMarkup(<AgentRunClient rows={[ROW]} />);
    expect(html).toContain('href="/agents/acme/research-assistant/new"');
    expect(html).toContain(">Run<");
  });

  it("renders neither field even when a row still carries version and status", () => {
    const html = renderToStaticMarkup(<AgentAllCard row={SMUGGLED_ROW} />);
    expect(html).toContain("Research Assistant");
    expect(html).not.toContain("9.9.9");
    expect(html).not.toContain('data-slot="installed-status-indicator"');
  });
});

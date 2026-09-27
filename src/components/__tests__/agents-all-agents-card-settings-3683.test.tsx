// @vitest-environment jsdom
/**
 * THE /agents "ALL AGENTS" CARD OPENS ITS SETTINGS AT THE WORKSPACE SCOPE
 * (cinatra#3683).
 *
 *   pnpm vitest run --config vitest.config.ts src/components/__tests__/agents-all-agents-card-settings-3683.test.tsx
 *
 * design specs/app-extensions.html §IV: "The right panel drops to a single
 * primary action, Run, plus Settings (the §VII assignment page at the card's
 * scope) and More details (the §II detail modal)", and: "The /agents "All
 * Agents" card, whose page carries no scope base, opens its Settings at the
 * workspace scope — /workspace/agents/<vendor>/<slug>/settings?tab=skills —
 * because the All Agents list is the workspace-wide list."
 *
 * The /agents rows are rendered through the REAL client and the scoped
 * Agents-tab rows through the REAL row builder and card, and the Settings link
 * is read off the rendered markup.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/marketplace-detail-actions", () => ({
  getAgentMarketplaceDetailAction: async () => ({ status: "error", message: "stub" }),
}));

// Imported by path: the /agents client is not a published subpath of the
// agents package, and this suite must render the REAL renderer.
import {
  AgentRunClient,
  type AgentRunRowModel,
} from "../../../packages/agents/src/agent-run-client";
import { AgentAllCard } from "@/components/extensions/agent-all-card";
import type { ScopeSurfaceEligibilityRow } from "@/lib/scope-surface-eligibility";
import { buildScopeSurfaceAgentRows } from "@/lib/scope-surface-rows";
import {
  scopeSurfaceAgentSettingsHref,
  scopeSurfaceBase,
  type ScopeSurfaceRef,
} from "@/lib/scope-surfaces";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

/** Exactly the shape `NewAgentPage` maps a local, scoped template to. */
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

/** An external A2A row: no listing, so no package name and no detail route. */
const EXTERNAL_ROW: AgentRunRowModel = {
  key: "a2a:remote-helper",
  name: "Remote Helper",
  description: "An external agent reached over A2A.",
  version: "0.1.0",
  skills: [],
  host: "remote-site",
  runHref: "/agents/a2a/remote-helper/new",
  packageName: null,
  detailHref: null,
  unavailable: null,
};

function parse(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

function moreDetails(root: HTMLElement): Element {
  const found = Array.from(root.querySelectorAll("a, button")).filter(
    (el) => el.textContent?.trim() === "More details",
  );
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("/agents All Agents card — Settings at the workspace scope", () => {
  it("the /agents All Agents card for a scoped agent opens its Settings at /workspace/agents/acme/research-assistant/settings?tab=skills", () => {
    const root = parse(renderToStaticMarkup(<AgentRunClient rows={[ROW]} />));
    const settings = root.querySelectorAll('a[data-slot="agent-card-settings"]');
    expect(settings).toHaveLength(1);
    const link = settings[0]!;
    expect(link.textContent?.trim()).toBe("Settings");
    expect(link.getAttribute("href")).toBe(
      "/workspace/agents/acme/research-assistant/settings?tab=skills",
    );
    // Settings sits to the LEFT of More details, inside the same wrapper.
    const more = moreDetails(root);
    const wrapper = link.parentElement!;
    expect(wrapper.contains(more)).toBe(true);
    expect(link.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Run stays the primary action.
    expect(root.querySelector('a[href="/agents/acme/research-assistant/new"]')?.textContent).toContain("Run");
  });

  it("an /agents row with no package name (an external A2A agent) draws no Settings link", () => {
    const root = parse(renderToStaticMarkup(<AgentRunClient rows={[EXTERNAL_ROW]} />));
    expect(root.querySelectorAll('[data-slot="agent-card-settings"]')).toHaveLength(0);
    expect(root.querySelector('a[href="/agents/a2a/remote-helper/new"]')?.textContent).toContain("Run");
  });
});

describe("scoped Agents tabs keep their scope's Settings address", () => {
  const PKG = "@acme/research-assistant";
  const ELIGIBLE: ScopeSurfaceEligibilityRow = {
    packageName: PKG,
    displayName: "Research Assistant",
    description: "Gathers sources, summarises, and cites answers.",
    version: "1.4.0",
    status: "active",
    installId: "install-1",
    executionOrgIds: ["org-1"],
  };
  const SCOPES: ScopeSurfaceRef[] = [
    { kind: "workspace" },
    { kind: "personal" },
    { kind: "organization", id: "org-1" },
    { kind: "team", id: "team-1" },
    { kind: "project", id: "proj-1" },
  ];

  for (const scope of SCOPES) {
    it(`the ${scope.kind} Agents tab card links Settings at its own scope`, () => {
      const [row] = buildScopeSurfaceAgentRows(scope, [ELIGIBLE]);
      const root = parse(renderToStaticMarkup(<AgentAllCard row={row!} />));
      const settings = root.querySelectorAll('a[data-slot="agent-card-settings"]');
      expect(settings).toHaveLength(1);
      const href = settings[0]!.getAttribute("href");
      expect(href).toBe(scopeSurfaceAgentSettingsHref(scope, PKG));
      expect(href!.startsWith(`${scopeSurfaceBase(scope)}/agents/`)).toBe(true);
    });
  }
});

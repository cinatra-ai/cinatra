// @vitest-environment jsdom
/**
 * cinatra#3719 — the All Agents card and the installed card of one extension
 * draw the same accent ground.
 *
 *   pnpm exec vitest run --config vitest.config.ts src/components/extensions/__tests__/all-agents-card-accent-by-package-name-3719.test.tsx
 *
 * THE DRAWING. specs/app-extensions.html §IV derives the All Agents card from
 * the §III Installed-extensions card — "the same coloured logo + name panel
 * (with the {Kind} by {Vendor} byline beneath the name)". One extension wears
 * one accent ground on both cards.
 *
 * THE DEFECT. The installed list seeds `deriveExtensionAccent` with the row's
 * package name; the All Agents card seeded it with its row key (`local:<id>`,
 * the loader's shape), so the same pack drew two different grounds.
 *
 * THE ROAD. The installed half is drawn through `renderInstalledRowCard` — the
 * list's own per-row composition — and the All Agents half through
 * `AgentAllCard`; both carry the accent as `data-accent` on the shared
 * `[data-slot="installed-extension-card"]` element. The seed hash can collide,
 * so the chosen pair's precondition (key and package name give different
 * accents) is asserted before the claim.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentAllCard, type AgentAllCardRow } from "@/components/extensions/agent-all-card";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { InstalledStatusIndicator } from "../installed-extension-card";
import type { InstalledCardRow } from "@cinatra-ai/extensions/screens/installed-rows";
import { renderInstalledRowCard } from "../../../../packages/extensions/src/screens/registry-catalog-screen";

// The screen module's server-side reads run only in the async screen body,
// never in the per-row composition under test; the §V detail modal is not
// under test either. All are replaced here and given back afterwards so the
// full run is unaffected by this file's presence.
const MOCKED_MODULES = [
  "@/components/extensions/agent-detail-modal",
  "@/lib/auth-session",
  "@/lib/connector-readiness.server",
  "@/lib/configuration-needs.server",
  "@/lib/agent-configuration-needs-notifications",
  "@/lib/extension-install-batch-ops",
  "@/lib/extension-update-read-model-store",
  "@/lib/generated/extensions.server",
  "@/lib/extensions",
] as const;
vi.mock("@/components/extensions/agent-detail-modal", () => ({
  AgentDetailModal: () => null,
}));
vi.mock("@/lib/auth-session", () => ({ requireAdminSession: vi.fn() }));
vi.mock("@/lib/connector-readiness.server", () => ({}));
vi.mock("@/lib/configuration-needs.server", () => ({
  resolveConfigurationNeedsForAgents: vi.fn(),
}));
vi.mock("@/lib/agent-configuration-needs-notifications", () => ({
  syncAgentConfigurationNeedsNotifications: vi.fn(),
}));
vi.mock("@/lib/extension-install-batch-ops", () => ({ listRecentInstallBatches: vi.fn() }));
vi.mock("@/lib/extension-update-read-model-store", () => ({
  readInstalledUpdateReadouts: vi.fn(),
}));
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: {} }));
vi.mock("@/lib/extensions", () => ({}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

afterAll(() => {
  for (const id of MOCKED_MODULES) vi.doUnmock(id);
  vi.resetModules();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures — one agent pack, as the installed list and the All Agents loader
// each hand it to their card.
// ---------------------------------------------------------------------------

const PACKAGE_NAME = "@cinatra-ai/research-assistant";
/** The All Agents loader keys a local row as `local:${id}` (packages/agents/src/pages.tsx). */
const ROW_KEY = "local:research-assistant-1";

const LIST_SCOPE = {
  renderStatus: (row: InstalledCardRow) => <InstalledStatusIndicator status={row.status} />,
  updateAffordanceFor: () => ({}),
  renderCardActions: () => null,
  configurationNeedsByPackage: {},
};

const INSTALLED_ROW: InstalledCardRow = {
  kind: "agent",
  packageName: PACKAGE_NAME,
  displayName: "Research Assistant",
  description: "Gathers sources, summarises, and cites answers grounded in your team's own documents.",
  versionLabel: "0.4.2",
  rawVersion: "0.4.2",
  vendor: "Cinatra",
  canonical: null,
  status: "active",
  requiredInProd: false,
  settingsHref: `/configuration/extensions/${PACKAGE_NAME}/settings`,
  visibility: "public",
};

function allAgentsRow(overrides: Partial<AgentAllCardRow> = {}): AgentAllCardRow {
  return {
    key: ROW_KEY,
    name: "Research Assistant",
    description: "Gathers sources, summarises, and cites answers grounded in your team's own documents.",
    host: "local",
    runHref: "/agents/research-assistant/new",
    packageName: PACKAGE_NAME,
    detailHref: `/configuration/marketplace/${PACKAGE_NAME}`,
    settingsHref: "/workspace/agents/cinatra-ai/research-assistant/settings?tab=skills",
    unavailable: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reading the drawn cards
// ---------------------------------------------------------------------------

function cardAccent(root: ParentNode): string | null {
  const cards = root.querySelectorAll('[data-slot="installed-extension-card"]');
  expect(cards).toHaveLength(1);
  return cards[0].getAttribute("data-accent");
}

function installedCardAccent(target: InstalledCardRow): string | null {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(renderInstalledRowCard(target, false, LIST_SCOPE));
  return cardAccent(host);
}

function allAgentsCardAccent(target: AgentAllCardRow): string | null {
  const { container } = render(<AgentAllCard row={target} />);
  return cardAccent(container);
}

describe("cinatra#3719 — one extension, one accent ground on the installed card and the All Agents card", () => {
  it("precondition: the chosen row key and package name seed different accents", () => {
    expect(deriveExtensionAccent(ROW_KEY)).not.toBe(deriveExtensionAccent(PACKAGE_NAME));
  });

  it("the All Agents card carries the installed card's data-accent, the package name's accent", () => {
    const installed = installedCardAccent(INSTALLED_ROW);
    expect(installed).toBe(deriveExtensionAccent(PACKAGE_NAME));

    const allAgents = allAgentsCardAccent(allAgentsRow());
    expect(allAgents).toBe(installed);
  });

  it("a row with no package name (external A2A / unscoped) keeps its row key's accent", () => {
    const key = "ext:acme-a2a:remote-7";
    const accent = allAgentsCardAccent(
      allAgentsRow({ key, host: "acme-a2a", packageName: null, detailHref: null, settingsHref: null }),
    );
    expect(accent).toBe(deriveExtensionAccent(key));
  });
});

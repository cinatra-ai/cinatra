// @vitest-environment jsdom
/**
 * cinatra#3682 — the installed extensions list card's byline reads
 * "{Type} by {Vendor}" and carries no source label.
 *
 *   pnpm exec vitest run --config vitest.config.ts src/components/extensions/__tests__/installed-card-byline-3682.test.tsx
 *
 * THE DRAWING. specs/app-extensions.html §III draws each installed card as a
 * logo + name panel "with the {Type} by {Vendor} line beneath the name"; its
 * worked example reads "Research Assistant / Agent by Cinatra" — a byline of
 * two parts and no third. No sentence of the drawing puts a source label on
 * this card.
 *
 * THE DEFECT. The list's own card composition classified each row's install
 * record and appended the result after the vendor (" · in-tree build", " · from
 * marketplace", " · source unknown"). An agent pack uploaded through the File
 * tab is recorded as a local source, so its card read "Agent by Cinatra ·
 * in-tree build" — a third element the drawing does not have, and untrue for an
 * upload besides.
 *
 * THE ROAD. The screen is an async server component wired to auth and the
 * canonical store, so these cases drive `renderInstalledRowCard` — the per-row
 * card composition the screen's `renderCard` calls — with the list's per-row
 * helpers passed in. A card composed by hand in the test could not see the
 * screen's props, so it would prove nothing about the list.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { InstalledStatusIndicator } from "../installed-extension-card";
import type { InstalledCardRow } from "@cinatra-ai/extensions/screens/installed-rows";
import type {
  ExtensionSource,
  InstalledExtension,
} from "@cinatra-ai/extensions/canonical-types";
import { renderInstalledRowCard } from "../../../../packages/extensions/src/screens/registry-catalog-screen";

// The screen module's server-side reads (session, install batches, update read
// model, configuration needs, the generated extension manifest) run only in the
// async screen body, never in the per-row composition under test. They are
// replaced so the module loads at the unit tier, and given back afterwards so
// the package's full run is unaffected by this file's presence.
const MOCKED_MODULES = [
  "@/lib/auth-session",
  "@/lib/connector-readiness.server",
  "@/lib/configuration-needs.server",
  "@/lib/agent-configuration-needs-notifications",
  "@/lib/extension-install-batch-ops",
  "@/lib/extension-update-read-model-store",
  "@/lib/generated/extensions.server",
  "@/lib/extensions",
] as const;
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
  document.body.innerHTML = "";
});

afterAll(() => {
  for (const id of MOCKED_MODULES) vi.doUnmock(id);
  vi.resetModules();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MARKETPLACE_URL = "https://marketplace.example";

/** The list's per-row helpers, as the screen hands them to the composition.
 *  The configured registry identities are real inputs of the old source
 *  classifier: a marketplace row below matches one, so a byline that still
 *  drew a source would draw "from marketplace" for it. */
const LIST_SCOPE = {
  registryIdentities: { marketplaceUrl: MARKETPLACE_URL, instanceUrl: "http://127.0.0.1:4873" },
  renderStatus: (row: InstalledCardRow) => <InstalledStatusIndicator status={row.status} />,
  updateAffordanceFor: () => ({}),
  renderCardActions: () => null,
  configurationNeedsByPackage: {},
};

function canonical(packageName: string, source: ExtensionSource): InstalledExtension {
  return {
    id: `row-${packageName}`,
    packageName,
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "agent",
    status: "active",
    source,
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const FIXTURE_VERSION = "v0.4.2";

function row(overrides: Partial<InstalledCardRow> & Pick<InstalledCardRow, "kind" | "packageName">): InstalledCardRow {
  return {
    displayName: "Research Assistant",
    description: "Gathers sources, summarises, and cites answers grounded in your team's own documents.",
    versionLabel: FIXTURE_VERSION,
    rawVersion: "0.4.2",
    vendor: "Cinatra",
    canonical: null,
    status: "active",
    requiredInProd: false,
    settingsHref: `/configuration/extensions/${overrides.packageName}/settings`,
    visibility: "public",
    ...overrides,
  };
}

/** An agent pack uploaded through the File tab: its install record is a local source. */
const UPLOADED_AGENT = row({
  kind: "agent",
  packageName: "@cinatra-ai/research-assistant",
  vendor: "Cinatra",
  canonical: canonical("@cinatra-ai/research-assistant", {
    type: "local",
    path: "/uploads/research-assistant",
    resolvedCommitOrTreeHash: "deadbeef",
  }),
});

/** A skill installed from the configured marketplace registry. */
const MARKETPLACE_SKILL = row({
  kind: "skill",
  packageName: "@acme/web-search",
  displayName: "Web Search",
  vendor: "Acme",
  canonical: canonical("@acme/web-search", {
    type: "verdaccio",
    registryUrl: MARKETPLACE_URL,
    packageName: "@acme/web-search",
    version: "1.0.0",
    integrity: "sha512-x",
  }),
});

/** A connector with no install record (the classifier's "source unknown"). */
const UNRECORDED_CONNECTOR = row({
  kind: "connector",
  packageName: "@acme/crm",
  displayName: "CRM",
  vendor: "Acme",
  canonical: null,
});

// ---------------------------------------------------------------------------
// Reading the drawn card
// ---------------------------------------------------------------------------

function drawCard(target: InstalledCardRow): HTMLElement {
  document.body.innerHTML = renderToStaticMarkup(
    renderInstalledRowCard(target, target.status === "archived", LIST_SCOPE),
  );
  return document.body;
}

/** The byline element's text with whitespace runs folded to one space. */
function bylineText(card: HTMLElement): string {
  const bylines = card.querySelectorAll('[data-slot="installed-extension-byline"]');
  expect(bylines).toHaveLength(1);
  return (bylines[0].textContent ?? "").replace(/\s+/g, " ").trim();
}

function expectNoSourceLabel(card: HTMLElement): void {
  expect(card.querySelector('[data-slot="installed-extension-source-label"]')).toBeNull();
  expect(card.querySelector("[data-source-kind]")).toBeNull();
}

// ---------------------------------------------------------------------------
// The byline reads {Type} by {Vendor} and carries no source label
// ---------------------------------------------------------------------------

describe("cinatra#3682 — the installed card's byline is {Type} by {Vendor}, as drawn", () => {
  it("the installed list's card for a local-build agent row by Cinatra reads Agent by Cinatra and draws no source label", () => {
    const card = drawCard(UPLOADED_AGENT);
    expect(bylineText(card)).toBe("Agent by Cinatra");
    expectNoSourceLabel(card);
    expect(card.textContent).not.toContain("in-tree build");
  });

  it("the installed list's card for a marketplace skill row by Acme reads Skill by Acme and draws no source label", () => {
    const card = drawCard(MARKETPLACE_SKILL);
    expect(bylineText(card)).toBe("Skill by Acme");
    expectNoSourceLabel(card);
    expect(card.textContent).not.toContain("from marketplace");
  });

  it("the installed list's card for a connector row with no install record reads Connector by Acme and draws no source label", () => {
    const card = drawCard(UNRECORDED_CONNECTOR);
    expect(bylineText(card)).toBe("Connector by Acme");
    expectNoSourceLabel(card);
    expect(card.textContent).not.toContain("source unknown");
  });
});

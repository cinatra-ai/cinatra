/**
 * @vitest-environment jsdom
 *
 * cinatra#3447: the §V settings page of an installed extension, rendered.
 *
 * The header arm renders the presentational view with the vendor the loader's
 * real resolution chain computes. The Marketplace arms render the LOADER itself
 * (`ExtensionSettingsScreen`) over a seeded installed row, so the group's state
 * comes from the same data the real page reads: the installed row, its kind,
 * and the marketplace vendor status. Only the data seams are stubbed.
 *
 * Section V draws the publish action in exactly three states (live; muted
 * beside "Register for marketplace"; muted beside the visible reason
 * "Marketplace publishing isn't available for this extension yet.") and draws
 * no "already published" state. So no arm here may meet the line "Published on
 * the marketplace.", whatever origin the row carries. That includes the public
 * origin the boot schema step stamps on every packaged agent row, which is the
 * row every installed agent's settings page actually reads.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  loadInstalledCardRows: vi.fn(),
  readMarketplaceVendorStatus: vi.fn(),
}));

// The view reads one lookup table from the server-only loader module, and the
// screen reads the installed rows from it. Both come from here.
vi.mock("@cinatra-ai/extensions/screens/installed-rows", () => ({
  KIND_LABEL: {
    agent: "Agent",
    connector: "Connector",
    skill: "Skill",
    artifact: "Artifact",
    workflow: "Workflow",
  },
  settingsHrefFor: (kind: string, packageName: string) =>
    `/configuration/extensions/settings/${kind}/${packageName}`,
  loadInstalledCardRows: (...args: unknown[]) => mocks.loadInstalledCardRows(...args),
}));

// A plain element host for next/link (never a raw anchor: the design-system
// gate rejects one anywhere in the tree), keeping the destination readable.
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <span data-href={typeof href === "string" ? href : "#"}>{children}</span>
  ),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// The screen's data seams. None of them decides the Marketplace group except
// the vendor status, which each arm sets.
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: async () => ({
    user: { id: "admin-1", role: "admin" },
    session: { activeOrganizationId: null },
  }),
  isPlatformAdmin: () => true,
  buildCanDoOptsFromSession: async () => ({ orgRole: null }),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUserActiveOnly: async () => [],
  readProjectsForUser: async () => [],
}));
vi.mock("@/app/configuration/environment/marketplace-publish-actions", () => ({
  readMarketplaceVendorStatus: () => mocks.readMarketplaceVendorStatus(),
}));
vi.mock("@/lib/extension-update-read-model-store", () => ({
  readInstalledUpdateReadouts: async () => [],
}));
vi.mock("@/components/execution/agent-execution-config-section", () => ({
  AgentExecutionConfigSection: () => null,
}));
vi.mock("@cinatra-ai/extensions/permissions-store", () => ({
  readExtensionAccessPolicy: async () => null,
}));
vi.mock("@cinatra-ai/extensions/permissions-actions", () => ({
  saveExtensionAccessPolicy: vi.fn(),
}));
vi.mock("@cinatra-ai/extensions/enforce-extension-access", () => ({
  DEFAULT_EXTENSION_ACCESS_POLICY: {
    runListVisibility: ["workspace_all"],
    runDataVisibility: ["workspace_all"],
    runExecuteVisibility: ["workspace_all"],
    allowRunSharing: false,
  },
}));
vi.mock("@cinatra-ai/extensions/screens/extension-access-control", () => ({
  ExtensionAccessControl: () => null,
}));
vi.mock("@cinatra-ai/extensions/actions", () => ({
  archiveExtensionPackageFormAction: vi.fn(),
  forceDeleteExtensionPackageFormAction: vi.fn(),
  promoteExtensionToPublicAction: vi.fn(),
  reinstallLatestFormAction: vi.fn(),
  retryExtensionActivationFormAction: vi.fn(),
  rollBackExtensionToBundledFormAction: vi.fn(),
  restoreExtensionPackageFormAction: vi.fn(),
}));
vi.mock("@cinatra-ai/extensions/lifecycle-target-resolver", () => {
  const allowed = (op: string) => ({ op, allowed: true, code: "ok", reason: null });
  return {
    describeLifecycleCapabilities: async (packageName: string) => ({
      resolution: { ok: false, code: "no_addressable_row", packageName, scope: "platform" },
      lockedRow: null,
      byOp: {
        archive: allowed("archive"),
        activate: allowed("activate"),
        uninstall: allowed("uninstall"),
        force_delete: allowed("force_delete"),
      },
    }),
    lifecycleRowSelectorFor: () => null,
  };
});
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: async () => [],
}));
vi.mock("@cinatra-ai/extensions/dependency-closure", () => ({
  listArchiveClosureBlockers: () => [],
}));

import {
  ExtensionSettingsView,
  type ExtensionSettingsActions,
  type ExtensionSettingsViewProps,
} from "@cinatra-ai/extensions/screens/extension-settings-view";
import { ExtensionSettingsScreen } from "@cinatra-ai/extensions/screens/extension-settings-screen";
import type { InstalledCardRow } from "@cinatra-ai/extensions/screens/installed-rows";
import { resolveInstalledRowVisibility } from "@cinatra-ai/extensions/screens/installed-visibility";
import { declaredVendorNameForScope, resolveInstalledVendorName } from "@cinatra-ai/registries";

const ACTIONS: ExtensionSettingsActions = {
  archive: vi.fn(),
  activate: vi.fn(),
  retryActivation: vi.fn(),
  rollBackToBundled: vi.fn(),
  reinstall: vi.fn(),
  publish: vi.fn(),
  forceDelete: vi.fn(),
};

const PUBLISHED_LINE = "Published on the marketplace.";
const REGISTER_REASON = "Register this instance as a marketplace vendor to publish.";
const UNAVAILABLE_REASON = "Marketplace publishing isn't available for this extension yet.";
const REGISTRIES_HREF = "/configuration/environment?tab=registries";

/**
 * The generated static manifest as the loader reads it: the first-party AGENT
 * entry declares no vendor of its own, its scope siblings declare the vendor
 * identity.
 */
const MANIFEST_ENTRIES = [
  { packageName: "@cinatra-ai/deep-research-agent", vendor: null },
  { packageName: "@cinatra-ai/apify-connector", vendor: { key: "cinatra-ai", name: "Cinatra" } },
];

const AGENT_PACKAGE = "@cinatra-ai/deep-research-agent";

/** The vendor the loader resolves for that row (`vendorFor`'s chain). */
function loaderVendor(): string | null {
  return resolveInstalledVendorName({
    manifestVendorName: null,
    author: null,
    scopeVendorName: declaredVendorNameForScope(MANIFEST_ENTRIES, AGENT_PACKAGE),
  });
}

function viewProps(overrides: Partial<ExtensionSettingsViewProps> = {}): ExtensionSettingsViewProps {
  return {
    kind: "agent",
    packageName: AGENT_PACKAGE,
    displayName: "Deep Research Agent",
    vendor: loaderVendor(),
    recovery: { showRetryActivation: false, showRollBackToBundled: false },
    updateRow: {
      enabled: false,
      description: "Currently on version 0.5.0 — up to date.",
      disabledReason: "Already on the newest version.",
    },
    archiveDisabled: null,
    activateDisabled: null,
    reinstallDisabled: null,
    forceDeleteDisabled: null,
    isRegisteredVendor: false,
    canPublish: false,
    permissions: <p data-slot="seeded-permissions">Seeded permissions control</p>,
    actions: ACTIONS,
    ...overrides,
  } as ExtensionSettingsViewProps;
}

/**
 * The installed row `loadInstalledCardRows` assembles, with its `visibility`
 * resolved by the SAME leaf the row assembly calls (installed-rows.ts).
 */
function installedRow(input: {
  kind: InstalledCardRow["kind"];
  packageName: string;
  displayName: string;
  rawVersion?: string | null;
  visibility: InstalledCardRow["visibility"];
}): InstalledCardRow {
  const rawVersion = input.rawVersion === undefined ? "0.5.0" : input.rawVersion;
  return {
    kind: input.kind,
    packageName: input.packageName,
    displayName: input.displayName,
    description: null,
    versionLabel: rawVersion ? `v${rawVersion}` : null,
    rawVersion,
    vendor: "Cinatra",
    canonical: null,
    status: "active",
    requiredInProd: false,
    settingsHref: `/configuration/extensions/settings/${input.kind}/${input.packageName}`,
    visibility: input.visibility,
  };
}

/**
 * An installed agent's row as a booted installation holds it: the boot schema
 * step stamps `origin.visibility = "public"` on every packaged agent template
 * (src/lib/drizzle-store.ts, the grandfather backfill), and the row assembly
 * reads the agent's native verdict from that origin first.
 */
function grandfatheredAgentRow(): InstalledCardRow {
  return installedRow({
    kind: "agent",
    packageName: AGENT_PACKAGE,
    displayName: "Deep Research Agent",
    visibility: resolveInstalledRowVisibility({
      nativeVisibility: "public",
      origin: null,
      hasCatalogSummary: false,
    }),
  });
}

/** Render the real settings loader for one installed row. */
async function renderSettingsPage(
  row: InstalledCardRow,
  vendorStatus: (() => Promise<unknown>) | { state: string } | null,
) {
  mocks.loadInstalledCardRows.mockResolvedValue({ active: [row], archived: [] });
  mocks.readMarketplaceVendorStatus.mockImplementation(
    typeof vendorStatus === "function" ? vendorStatus : async () => vendorStatus,
  );
  const page = await ExtensionSettingsScreen({ kind: row.kind, packageName: row.packageName });
  return render(page);
}

function marketplaceGroup(container: HTMLElement): HTMLElement {
  const group = container.querySelector<HTMLElement>('[data-slot="settings-marketplace"]');
  expect(group).not.toBeNull();
  return group!;
}

/** The drawn state "muted beside a Register for marketplace link". */
function expectRegisterState(group: HTMLElement) {
  expect(group.textContent).not.toContain(PUBLISHED_LINE);
  const action = group.querySelector<HTMLButtonElement>('[data-slot="disabled-action"]');
  expect(action).not.toBeNull();
  expect(action!.textContent).toContain("Publish on marketplace");
  expect(action!.disabled).toBe(true);
  expect(action!.getAttribute("data-disabled-reason")).toBe(REGISTER_REASON);
  expect(within(group).getByText("Register for marketplace")).toBeTruthy();
  expect(group.querySelector("[data-href]")?.getAttribute("data-href")).toBe(REGISTRIES_HREF);
  expect(group.textContent).not.toContain(UNAVAILABLE_REASON);
}

/** The drawn state "muted beside the visible reason". */
function expectUnavailableState(group: HTMLElement) {
  expect(group.textContent).not.toContain(PUBLISHED_LINE);
  expect(group.textContent).not.toContain("Register for marketplace");
  const action = group.querySelector<HTMLButtonElement>('[data-slot="disabled-action"]');
  expect(action).not.toBeNull();
  expect(action!.textContent).toContain("Publish on marketplace");
  expect(action!.disabled).toBe(true);
  // The attribute stays for a browser walk…
  expect(action!.getAttribute("data-disabled-reason")).toBe(UNAVAILABLE_REASON);
  // …and the reason is TEXT on the page beside the button, as §V draws it,
  // not only a hover title. getByText never matches an attribute.
  const reason = within(group).getByText(UNAVAILABLE_REASON);
  expect(reason.closest("button")).toBeNull();
  expect(reason.parentElement).toBe(action!.parentElement);
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.loadInstalledCardRows.mockReset();
  mocks.readMarketplaceVendorStatus.mockReset();
});

describe("§V settings header — the byline names the vendor (cinatra#3447)", () => {
  it("reads '{Kind} by {Vendor}' for an installed first-party agent", () => {
    const { container } = render(<ExtensionSettingsView {...viewProps()} />);

    const name = container.querySelector('[data-slot="extension-settings-name"]');
    expect(name).not.toBeNull();
    const byline = name!.parentElement!.querySelector("p");
    expect(byline).not.toBeNull();
    expect(byline!.textContent?.replace(/\s+/g, " ").trim()).toBe("Agent by Cinatra");
  });
});

describe("§V Marketplace group: one of the three drawn states, on the real loader (cinatra#3447)", () => {
  it("an installed agent whose row carries the stamped public origin, on an instance that is no registered vendor: muted action beside 'Register for marketplace'", async () => {
    const { container } = await renderSettingsPage(grandfatheredAgentRow(), null);
    expectRegisterState(marketplaceGroup(container));
  });

  it("an installed LEGACY published row (a catalog summary with no origin block, grandfathered public): the same Register state, no published line", async () => {
    const row = installedRow({
      kind: "agent",
      packageName: AGENT_PACKAGE,
      displayName: "Deep Research Agent",
      visibility: resolveInstalledRowVisibility({
        nativeVisibility: null,
        origin: null,
        hasCatalogSummary: true,
      }),
    });
    expect(row.visibility).toBe("public");
    const { container } = await renderSettingsPage(row, null);
    expectRegisterState(marketplaceGroup(container));
  });

  it("a runtime-installed connector (no catalog summary, so its row still defaults public): the Register state, no published line", async () => {
    const row = installedRow({
      kind: "connector",
      packageName: "@cinatra-ai/apify-connector",
      displayName: "Apify",
      visibility: "public",
    });
    const { container } = await renderSettingsPage(row, null);
    expectRegisterState(marketplaceGroup(container));
  });

  it("the vendor-status read failing: the page still draws the Register state", async () => {
    const { container } = await renderSettingsPage(grandfatheredAgentRow(), async () => {
      throw new Error("marketplace unreachable");
    });
    expectRegisterState(marketplaceGroup(container));
  });

  it("a registered vendor viewing a kind that can't be published yet: muted action beside the VISIBLE reason", async () => {
    const row = installedRow({
      kind: "connector",
      packageName: "@cinatra-ai/apify-connector",
      displayName: "Apify",
      visibility: "private",
    });
    const { container } = await renderSettingsPage(row, { state: "approved" });
    expectUnavailableState(marketplaceGroup(container));
  });

  it("a registered vendor viewing an installed agent the promote path refuses (its stored origin is already public): muted beside the visible reason, never a live action that the server refuses", async () => {
    const { container } = await renderSettingsPage(grandfatheredAgentRow(), { state: "approved" });
    const group = marketplaceGroup(container);
    expectUnavailableState(group);
    expect(within(group).getAllByRole("button")).toHaveLength(1);
  });

  it("a registered vendor viewing a private agent with a known version: the live action", async () => {
    const row = installedRow({
      kind: "agent",
      packageName: "@acme/research-agent",
      displayName: "Research Agent",
      visibility: "private",
    });
    const { container } = await renderSettingsPage(row, { state: "approved" });
    const group = marketplaceGroup(container);

    expect(group.textContent).not.toContain(PUBLISHED_LINE);
    expect(group.querySelector('[data-slot="disabled-action"]')).toBeNull();
    const live = within(group).getByRole("button", { name: /Publish on marketplace/ });
    expect((live as HTMLButtonElement).disabled).toBe(false);
    expect(group.textContent).not.toContain("Register for marketplace");
    expect(group.textContent).not.toContain(UNAVAILABLE_REASON);
  });
});

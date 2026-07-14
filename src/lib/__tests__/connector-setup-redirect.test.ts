import { describe, it, expect, vi } from "vitest";
import {
  buildMarketplaceRedirectTarget,
  decideConnectorSetupRedirect,
  resolveConnectorSetupRedirect,
  type ConnectorSetupRedirectSignals,
  type ConnectorSetupRedirectDeps,
} from "@/lib/connector-setup-redirect";
import type { MarketplaceBrowseResult } from "@/lib/marketplace-browse";
import type { MarketplaceCardData } from "@cinatra-ai/extensions/screens";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import type { ActorContext } from "@/lib/authz/actor-context";

const PKG = "@vendor-x/some-connector";
const ORG = "org-1";
const OTHER_ORG = "org-2";

// A platform admin (the only actor who can browse `/configuration/marketplace`).
function adminActor(p: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    authSource: "ui",
    policyVersion: "1",
    platformRole: "platform_admin",
    organizationId: ORG,
    ...p,
  } as ActorContext;
}

function memberActor(p: Partial<ActorContext> = {}): ActorContext {
  return adminActor({ platformRole: "member", ...p });
}

// A browse card — only `packageName`, `kindSlug`, `sdkAbiRange` are read by the
// resolver. Defaults to a connector (the redirect only fires for connectors).
function card(
  packageName: string,
  sdkAbiRange: string | null = null,
  kindSlug = "connector",
): MarketplaceCardData {
  return { packageName, kindSlug, sdkAbiRange } as unknown as MarketplaceCardData;
}

function browse(cards: MarketplaceCardData[]): MarketplaceBrowseResult {
  return { kind: "storefront", cards, registryConnected: true };
}

// An install row — only `organizationId` + `isDefault` are read by the resolver.
function installRow(p: Partial<InstalledExtension>): InstalledExtension {
  return {
    id: "inst-1",
    status: "active",
    organizationId: ORG,
    ownerId: null,
    ownerLevel: "organization",
    isDefault: true,
    ...p,
  } as unknown as InstalledExtension;
}

const REDIRECT_TARGET = buildMarketplaceRedirectTarget(PKG);

// All-pass signals: discoverable + installable + genuinely-absent + setup + admin.
function passSignals(
  p: Partial<ConnectorSetupRedirectSignals> = {},
): ConnectorSetupRedirectSignals {
  return {
    isSetupSubroute: true,
    actorCanBrowseMarketplace: true,
    discoverableInstallable: true,
    hasOrgScopedInstall: false,
    ...p,
  };
}

// ---------------------------------------------------------------------------
// buildMarketplaceRedirectTarget (AC4 — URLSearchParams, canonical @-name, no
// hand-asserted %2F, not a claimed unique deep link).
// ---------------------------------------------------------------------------
describe("buildMarketplaceRedirectTarget", () => {
  it("targets the marketplace browse path with a q param derived from the package name", () => {
    const url = new URL(REDIRECT_TARGET, "https://app.example");
    expect(url.pathname).toBe("/configuration/marketplace");
    // URLSearchParams decodes back to the EXACT canonical package name (leading
    // @ and the scope slash included) — we never hand-assert the %2F/%40 bytes.
    expect(url.searchParams.get("q")).toBe(PKG);
  });

  it("percent-encodes the @ and / through URLSearchParams (round-trips exactly)", () => {
    // Encoded form carries %40 and %2F rather than raw @ // — proof the value was
    // encoded, without the test hand-writing the encoding.
    expect(REDIRECT_TARGET).toContain("q=%40vendor-x%2Fsome-connector");
    const roundTrip = new URLSearchParams(REDIRECT_TARGET.split("?")[1]).get("q");
    expect(roundTrip).toBe(PKG);
  });
});

// ---------------------------------------------------------------------------
// decideConnectorSetupRedirect — the PURE matrix (AC1). Every row is pinned,
// including the two 404-preserving oracle-prevention rows (fail-closed).
// ---------------------------------------------------------------------------
describe("decideConnectorSetupRedirect (pure matrix)", () => {
  it("REDIRECT: discoverable + installable + genuinely-absent install, on setup, as admin", () => {
    expect(decideConnectorSetupRedirect(PKG, passSignals())).toEqual({
      kind: "redirect",
      target: REDIRECT_TARGET,
    });
  });

  it("404 (unchanged): unknown / not-discoverable → discoverableInstallable=false", () => {
    // Oracle-prevention rows 1 & 2 collapse to this signal: a package the actor's
    // own browse catalog does not carry never redirects.
    expect(
      decideConnectorSetupRedirect(PKG, passSignals({ discoverableInstallable: false })),
    ).toEqual({ kind: "none" });
  });

  it("404 (unchanged): policy/discovery-denied actor cannot browse the marketplace", () => {
    // A non-admin cannot reach the redirect target — redirecting would be a
    // useless bounce and a potential existence oracle. Fail closed.
    expect(
      decideConnectorSetupRedirect(PKG, passSignals({ actorCanBrowseMarketplace: false })),
    ).toEqual({ kind: "none" });
  });

  it("NOT a redirect: an install exists in the actor's org (any status) → management case", () => {
    expect(
      decideConnectorSetupRedirect(PKG, passSignals({ hasOrgScopedInstall: true })),
    ).toEqual({ kind: "none" });
  });

  it("scope: a non-setup subroute keeps its existing behaviour", () => {
    expect(
      decideConnectorSetupRedirect(PKG, passSignals({ isSetupSubroute: false })),
    ).toEqual({ kind: "none" });
  });
});

// ---------------------------------------------------------------------------
// resolveConnectorSetupRedirect — maps each matrix STATE to signals via DI'd
// catalog/store reads, and proves the fail-closed IO handling + no-oracle fetch
// discipline. The `setup` subroute + admin actor are held constant unless noted.
// ---------------------------------------------------------------------------
describe("resolveConnectorSetupRedirect (state → decision)", () => {
  const setup = (deps: ConnectorSetupRedirectDeps, over: Partial<{ subroute: string; actor: ActorContext | null }> = {}) =>
    resolveConnectorSetupRedirect(
      { packageName: PKG, subroute: over.subroute ?? "setup", actor: over.actor ?? adminActor() },
      deps,
    );

  it("REDIRECT: package listed in the actor's browse catalog + NO install rows", async () => {
    const decision = await setup({
      loadBrowse: async () => browse([card(PKG)]),
      readRows: async () => [],
    });
    expect(decision).toEqual({ kind: "redirect", target: REDIRECT_TARGET });
  });

  it("404: unknown connector — empty browse catalog (oracle-prevention row 1)", async () => {
    const decision = await setup({
      loadBrowse: async () => browse([]),
      readRows: async () => [],
    });
    expect(decision).toEqual({ kind: "none" });
  });

  it("404: known globally but NOT in the actor's browse catalog (oracle-prevention row 2)", async () => {
    // The catalog lists OTHER packages but not this one — a global existence must
    // not leak via a redirect-vs-404 diff.
    const decision = await setup({
      loadBrowse: async () => browse([card("@vendor-x/other-connector"), card("@acme/thing")]),
      readRows: async () => [],
    });
    expect(decision).toEqual({ kind: "none" });
  });

  it("NOT a redirect: discoverable but an ARCHIVED install exists in the actor's org (AC3)", async () => {
    const decision = await setup({
      loadBrowse: async () => browse([card(PKG)]),
      readRows: async () => [installRow({ status: "archived", organizationId: ORG })],
    });
    expect(decision).toEqual({ kind: "none" });
  });

  it("NOT a redirect: discoverable but a workspace-level (org-less) install exists", async () => {
    const decision = await setup({
      loadBrowse: async () => browse([card(PKG)]),
      readRows: async () => [installRow({ organizationId: null, ownerLevel: "organization" })],
    });
    expect(decision).toEqual({ kind: "none" });
  });

  it("REDIRECT: an install exists only in ANOTHER org — genuinely absent for this actor's org (AC3)", async () => {
    const decision = await setup({
      loadBrowse: async () => browse([card(PKG)]),
      readRows: async () => [installRow({ status: "active", organizationId: OTHER_ORG })],
    });
    expect(decision).toEqual({ kind: "redirect", target: REDIRECT_TARGET });
  });

  it("NOT a redirect: a non-default install row in the actor's org is ignored, so a genuinely-absent default redirects", async () => {
    // A non-default (isDefault === false) row does NOT own the package's global
    // identity — it is filtered out, so an org with only a non-default row still
    // redirects (mirrors isConnectorInstalledForActor).
    const decision = await setup({
      loadBrowse: async () => browse([card(PKG)]),
      readRows: async () => [installRow({ isDefault: false, organizationId: ORG })],
    });
    expect(decision).toEqual({ kind: "redirect", target: REDIRECT_TARGET });
  });

  it("404: the name resolves to a NON-connector listing (agent) — connector is unknown to this route", async () => {
    // Package names are globally unique across kinds; a name that is an agent
    // means there is no connector by that name → stay 404, never redirect a
    // connector setup URL to a non-connector marketplace listing.
    const decision = await setup({
      loadBrowse: async () => browse([card(PKG, null, "agent")]),
      readRows: async () => [],
    });
    expect(decision).toEqual({ kind: "none" });
  });

  it("404: discoverable but ABI-INCOMPATIBLE listing keeps the existing response (matrix)", async () => {
    const decision = await setup({
      loadBrowse: async () => browse([card(PKG, ">=1000.0.0")]),
      readRows: async () => [],
    });
    expect(decision).toEqual({ kind: "none" });
  });

  it("404 + NO catalog fetch: a non-admin actor never triggers a marketplace probe (no oracle)", async () => {
    const loadBrowse = vi.fn(async () => browse([card(PKG)]));
    const readRows = vi.fn(async () => [] as InstalledExtension[]);
    const decision = await setup({ loadBrowse, readRows }, { actor: memberActor() });
    expect(decision).toEqual({ kind: "none" });
    expect(loadBrowse).not.toHaveBeenCalled();
    expect(readRows).not.toHaveBeenCalled();
  });

  it("404 + NO catalog fetch: a non-setup subroute short-circuits before any IO", async () => {
    const loadBrowse = vi.fn(async () => browse([card(PKG)]));
    const readRows = vi.fn(async () => [] as InstalledExtension[]);
    const decision = await setup({ loadBrowse, readRows }, { subroute: "config" });
    expect(decision).toEqual({ kind: "none" });
    expect(loadBrowse).not.toHaveBeenCalled();
    expect(readRows).not.toHaveBeenCalled();
  });

  it("404 + NO catalog fetch: a null actor short-circuits before any IO", async () => {
    const loadBrowse = vi.fn(async () => browse([card(PKG)]));
    // Call directly (the `setup` helper coalesces null → admin); an unauthenticated
    // actor must never trigger a marketplace probe.
    const decision = await resolveConnectorSetupRedirect(
      { packageName: PKG, subroute: "setup", actor: null },
      { loadBrowse },
    );
    expect(decision).toEqual({ kind: "none" });
    expect(loadBrowse).not.toHaveBeenCalled();
  });

  it("fail-closed: a marketplace/browse IO error keeps the existing 404", async () => {
    const decision = await setup({
      loadBrowse: async () => {
        throw new Error("storefront unreachable");
      },
      readRows: async () => [],
    });
    expect(decision).toEqual({ kind: "none" });
  });

  it("fail-closed: a canonical install-store read error keeps the existing 404", async () => {
    const decision = await setup({
      loadBrowse: async () => browse([card(PKG)]),
      readRows: async () => {
        throw new Error("store read failed");
      },
    });
    expect(decision).toEqual({ kind: "none" });
  });

  it("derives q from the CANONICAL catalog package name (matched case-insensitively)", async () => {
    // The route-derived name may differ in case from the catalog's canonical
    // name; the redirect q uses the catalog's canonical value.
    const decision = await resolveConnectorSetupRedirect(
      { packageName: "@Vendor-X/Some-Connector", subroute: "setup", actor: adminActor() },
      { loadBrowse: async () => browse([card(PKG)]), readRows: async () => [] },
    );
    expect(decision).toEqual({ kind: "redirect", target: REDIRECT_TARGET });
  });

  it("NOT a redirect: route casing differs, but the actor's org HAS it installed under the canonical name — the org-scoped lookup uses the canonical (exact-case) name", async () => {
    // The install store read is a case-sensitive `eq()`. The route-derived name
    // (`@vendor-x/...`) differs in case from the catalog's canonical name
    // (`@Vendor-X/...`), under which the actor's org actually holds the install.
    // The org-scoped check must query the CANONICAL name (as the redirect target
    // does), or it misses the install and wrongly redirects a connector the org
    // already has (AC3). `readRows` mimics the real exact-case store read.
    const CANON = "@Vendor-X/Some-Connector";
    const decision = await resolveConnectorSetupRedirect(
      { packageName: "@vendor-x/some-connector", subroute: "setup", actor: adminActor() },
      {
        loadBrowse: async () => browse([card(CANON)]),
        readRows: async (name) =>
          name === CANON ? [installRow({ organizationId: ORG })] : [],
      },
    );
    expect(decision).toEqual({ kind: "none" });
  });
});

// @vitest-environment jsdom
//
// cinatra#3494 — THE REGISTRY-OFFERED LISTING'S "Install now", MOUNTED AND
// CLICKED.
//
// WHAT WAS REPORTED. On /configuration/marketplace a listing the package
// registry offers (CINATRA_AGENT_REGISTRY_URL set; the dev fleet's packs — the
// "Blog Ideas" display under Artifacts, the blog editorial bundle under Skills)
// draws its card WITH an "Install now" control, and pressing it completes
// nothing at all: no dialog, no toast, no non-GET request, no console error and
// no `cinatra.installed_extension` row.
//
// WHY NO EXISTING SUITE SAW IT. `marketplace-install-wiring.test.ts` reads the
// composition's SOURCE TEXT with regexes and never mounts anything;
// `marketplace-payload-weight.test.ts` stubs every "use client" half away so
// flight can be measured. Nothing in the repo mounted the real card and clicked
// its CTA, so the one state that renders a live-looking control and then does
// nothing was invisible to the suites.
//
// WHAT THIS FILE MOUNTS. The real composition the route renders —
// `buildMarketplaceCardNodes` inside the grid-level `InstallPanelScopeProvider`
// — for a registry-offered, NOT-yet-installed listing of both roads: an
// ARTIFACT (an install-access-target kind, so the in-card panel road through
// MarketplaceCardInstallShell / CardFaceSwitcher / ExtensionInstallScopePanel)
// and a SKILL (no access target, so the direct bound-form road through
// MarketplaceInstallForm). The click is a real DOM click.
//
// THE DRAWING it is measured against (design specs/app-extensions.html):
//   §I.1 — "Install now swaps the card's body in place — there is no popup.
//   Clicking Install now keeps the card's header band (icon, name, byline)
//   exactly as it was and replaces only the body — price, rating, description —
//   with the install panel: the access-scope picker, preselected to
//   Workspace: All, and Cancel / Install now actions."
//   `extension-listing-card-incompatible` — a BLOCKED Install now is drawn as a
//   greyed control that still carries its reason
//   (`disabled title="Requires a newer Cinatra version"`) with the verdict
//   readable on the card. A blocked action is never a control that simply does
//   nothing.
//
// Two mocks, both OFF the install road and both file-scoped (vitest gives each
// test file its own module registry, so nothing here reaches another file):
// the detail modal's public-detail server action (its module graph pulls the
// generated server-side extension manifest, which does not resolve in this
// sandbox) and the toast surface (so a dispatched failure is observable instead
// of being painted).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { buildMarketplaceCardNodes } from "../../../packages/extensions/src/screens/marketplace-card-nodes";
import { InstallPanelScopeProvider } from "../../../packages/extensions/src/screens/extension-install-scope-panel";
import type { InstallPanelScopeContextValue } from "../../../packages/extensions/src/screens/extension-install-scope-panel";
import type { MarketplaceCardData } from "../../../packages/extensions/src/screens/marketplace-card-model";

vi.mock("@/lib/marketplace-detail-actions", () => ({
  getPublicMarketplaceDetailAction: vi.fn(async () => ({ ok: false, reason: "not_found" })),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/lib/cinatra-toast", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures — the two dev-fleet packs the report names, shaped as the storefront
// catalog maps them (catalogEntryToCardData): a registry-offered listing is one
// the host does not bundle, so its manifest-derived icon/name tiers are null.
// ---------------------------------------------------------------------------

const REGISTRY_ARTIFACT: MarketplaceCardData = {
  packageName: "@example-vendor/sample-ideas-artifact",
  packageVersion: "0.1.0",
  displayName: "Blog Ideas",
  description: "A display of blog ideas, grouped by campaign.",
  kindSlug: "artifact",
  kindLabel: "Artifact",
  badge: { text: "Free", variant: "free" },
  freshnessAt: "2026-09-01T00:00:00.000Z",
  rating: null,
  detailHref: "/configuration/marketplace/example-vendor/sample-ideas-artifact",
  installCount: null,
  manifestLogoUrl: null,
  iconSlug: null,
  iconUrl: null,
  vendorLogoUrl: null,
  sdkAbiRange: null,
  vendor: null,
};

const REGISTRY_SKILL: MarketplaceCardData = {
  ...REGISTRY_ARTIFACT,
  packageName: "@example-vendor/sample-editorial-skills",
  packageVersion: "0.1.0",
  displayName: "Blog editorial bundle",
  description: "The blog editorial skills, as one bundle.",
  kindSlug: "skill",
  kindLabel: "Skill",
  detailHref: "/configuration/marketplace/example-vendor/sample-editorial-skills",
};

/** A listing the host BUNDLES — same kind, manifest tiers resolved. */
const BUNDLED_ARTIFACT: MarketplaceCardData = {
  ...REGISTRY_ARTIFACT,
  packageName: "@example-vendor/sample-chart-artifact",
  displayName: "Chart",
  manifestLogoUrl: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>",
  iconSlug: "chart-artifact",
  detailHref: "/configuration/marketplace/example-vendor/sample-chart-artifact",
};

const INSTALL_TARGETS: InstallPanelScopeContextValue["installTargets"] = [
  { value: "workspace", label: "Workspace: All", level: "workspace", id: "org-1", disabled: false },
  { value: "admin", label: "Workspace: Admins only", level: "admin", id: "org-1", disabled: false },
  { value: "org:org-1", label: "Acme", level: "organization", id: "org-1", disabled: false },
];

type MountOptions = {
  cards: MarketplaceCardData[];
  registryConnected?: boolean;
  installAction?: InstallPanelScopeContextValue["installAction"];
};

function mountCards({ cards, registryConnected = true, installAction }: MountOptions) {
  const action = installAction ?? (vi.fn(async () => undefined) as never);
  const nodes = buildMarketplaceCardNodes({
    cards,
    installedVersionByName: new Map(),
    registryConnected,
    installAction: action as never,
    updateAction: vi.fn(async () => undefined),
    restoreAction: vi.fn(async () => undefined),
  });
  render(
    <InstallPanelScopeProvider
      value={{
        installTargets: INSTALL_TARGETS,
        ownerEntityNames: { "org:org-1": "Acme" },
        activeOrgId: "org-1",
        availability: { state: "ready", defaultValue: "workspace" },
        installAction: action,
      }}
    >
      <div>
        {nodes.map((n) => (
          <div key={n.meta.packageName}>{n.node}</div>
        ))}
      </div>
    </InstallPanelScopeProvider>,
  );
  return { action };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. THE SILENT GUARD — a state that produces the reported symptom.
//
// `registryConnected` is resolved from the instance's Verdaccio read config
// (src/lib/marketplace-browse.ts `loadInstallableRegistryConfigOrNull`), NOT
// from CINATRA_AGENT_REGISTRY_URL, so an instance that HAS a package registry
// offering the fleet's packs can still resolve it false. In that state the card
// still draws an "Install now" control — and before cinatra#3494 that control
// was a bare disabled Button whose only reason was a native `title` the
// Button primitive's own `disabled:pointer-events-none` made unreachable, with
// nothing on the card body saying a word. Pressing it completed nothing.
//
// HONEST SCOPE (codex convergence): this reproduces the registryConnected=false
// branch, which PRODUCES the reported symptom set; it does not prove the
// reported instance reached this branch rather than an enabled control whose
// dispatch failed downstream. The six open-road arms below fence that other
// road, and they already pass at the base — the real-instance proof with a
// per-lane registry is the only measurement that can settle which one the
// report hit.
// ---------------------------------------------------------------------------

describe("cinatra#3494 — a registry-offered listing whose install road is closed refuses VISIBLY", () => {
  it("names the reason on the card body instead of drawing a control that does nothing", () => {
    mountCards({ cards: [REGISTRY_ARTIFACT], registryConnected: false });

    const cta = screen.getByTestId("extension-card-cta");
    expect(cta.getAttribute("data-cta-state")).toBe("install");
    expect(cta.textContent).toContain("Install now");

    // The refusal is READABLE ON THE CARD — not only in a tooltip nobody can
    // reach. This is the drawing's incompatible card: a blocked Install states
    // why on the card itself.
    const refusal = screen.getByTestId("extension-card-cta-refusal");
    expect(refusal.textContent).toBe("Connect the package registry to install");
  });

  it("keeps the blocked control's own reason reachable, as the drawn incompatible card does", () => {
    mountCards({ cards: [REGISTRY_ARTIFACT], registryConnected: false });

    const button = screen
      .getByTestId("extension-card-cta")
      .querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("Connect the package registry to install");
    // The Button primitive ships `disabled:pointer-events-none`, which swallows
    // the hover that would surface `title`. The drawn incompatible control
    // overrides it; this one must too, or its reason is unreachable.
    expect(button.className).toContain("disabled:pointer-events-auto");
  });

  it("does not split the drawn CTA + More details pair (one flex item, not two)", () => {
    mountCards({ cards: [REGISTRY_ARTIFACT], registryConnected: false });

    // The CTA slot in marketplace-listing-card.tsx is `className="contents"`,
    // so EVERY child this branch returns is a direct child of the
    // `flex flex-row flex-wrap` CTA row, and `detailsControl` ("More details")
    // is the next child of that same row. A full-width sibling between them
    // would push "More details" onto its own line and break the drawn pair
    // (cinatra#2363). The refusal must therefore contribute ONE item that
    // carries both the control and its reason.
    const cta = screen.getByTestId("extension-card-cta");
    expect(cta.children.length).toBe(1);

    const refusal = screen.getByTestId("extension-card-cta-refusal");
    const button = cta.querySelector("button") as HTMLButtonElement;
    expect(refusal.parentElement).toBe(button.parentElement);
    expect(refusal.className).not.toContain("basis-full");

    // The reason is bound to the control it explains — a disabled button is not
    // keyboard-focusable and its native title is hover-only.
    expect(refusal.id).not.toBe("");
    expect(button.getAttribute("aria-describedby")).toBe(refusal.id);
  });

  it("dispatches nothing while the road is closed", () => {
    const { action } = mountCards({ cards: [REGISTRY_ARTIFACT], registryConnected: false });

    const button = screen
      .getByTestId("extension-card-cta")
      .querySelector("button") as HTMLButtonElement;
    fireEvent.click(button);

    expect(action).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.queryByTestId("extension-install-panel-body")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. THE OPEN ROAD — registry-offered and bundled reach the SAME outcome.
// ---------------------------------------------------------------------------

describe("cinatra#3494 — with the road open, a registry-offered listing installs exactly as a bundled one", () => {
  it("ARTIFACT: Install now swaps the card body to the install panel in place, no popup", () => {
    mountCards({ cards: [REGISTRY_ARTIFACT] });

    fireEvent.click(screen.getByTestId("extension-install-panel-open"));

    // The body became the panel…
    const body = screen.getByTestId("extension-install-panel-body");
    expect(body.getAttribute("data-availability")).toBe("ready");
    expect(screen.getByTestId("extension-install-panel-picker")).not.toBeNull();
    expect(screen.getByTestId("extension-install-panel-cancel")).not.toBeNull();
    // …the header band is untouched (§I.1), and no dialog was mounted.
    expect(screen.getByTitle("Blog Ideas").textContent).toBe("Blog Ideas");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("ARTIFACT: the panel's Install now dispatches the install with the chosen audience", async () => {
    const action = vi.fn(async () => undefined) as never;
    mountCards({ cards: [REGISTRY_ARTIFACT], installAction: action });

    fireEvent.click(screen.getByTestId("extension-install-panel-open"));
    const submit = screen.getByTestId("extension-install-panel-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith({
      packageName: "@example-vendor/sample-ideas-artifact",
      packageVersion: "0.1.0",
      accessTarget: { level: "workspace", id: "org-1" },
    });
  });

  it("SKILL: Install now dispatches the bound install action (no access target for this kind)", async () => {
    const action = vi.fn(async () => undefined) as never;
    mountCards({ cards: [REGISTRY_SKILL], installAction: action });

    fireEvent.click(screen.getByTestId("extension-card-cta-submit"));

    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith({
      packageName: "@example-vendor/sample-editorial-skills",
      packageVersion: "0.1.0",
    });
  });

  it("a bundled listing of the same kind reaches the identical DOM outcome on click", () => {
    mountCards({ cards: [BUNDLED_ARTIFACT] });
    fireEvent.click(screen.getByTestId("extension-install-panel-open"));
    const bundled = screen.getByTestId("extension-install-panel-body").getAttribute("data-availability");
    cleanup();

    mountCards({ cards: [REGISTRY_ARTIFACT] });
    fireEvent.click(screen.getByTestId("extension-install-panel-open"));
    const registryOffered = screen
      .getByTestId("extension-install-panel-body")
      .getAttribute("data-availability");

    expect(registryOffered).toBe(bundled);
  });

  it("no refusal line is drawn while the road is open", () => {
    mountCards({ cards: [REGISTRY_ARTIFACT, REGISTRY_SKILL] });
    expect(screen.queryByTestId("extension-card-cta-refusal")).toBeNull();
  });
});

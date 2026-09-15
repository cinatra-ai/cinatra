// @vitest-environment jsdom
//
// The Install now control of a REGISTRY-OFFERED marketplace listing
// (cinatra#3494).
//
// Measured on an instance whose package registry offers the fleet's packs: the
// browse grid lists them, the agent card reads "Installed", and pressing
// "Install now" on an artifact display or a skill completes NOTHING — no
// dialog, no card-face change, no toast, no non-GET request, no console error,
// no install row. Both kinds take different install roads (an artifact is an
// install-access-target kind and swaps the card body to the §I.1 in-card
// install face; a skill submits its bound install form), so a single dead
// control across both is the CTA state they share.
//
// This suite renders the REAL per-card composition — `buildMarketplaceCardNodes`
// over the real listing card, the real card-face switcher and the real in-card
// panel — for a listing that is offered by the registry and has never been
// installed locally, and PRESSES the control:
//
//   - registry connected  → the press must open the install road;
//   - registry NOT connected → the press must refuse WITH A VISIBLE REASON on
//     the card. A control labelled "Install now" that is inert and explains
//     itself only through a `title` tooltip is the silent no-op: the shared
//     Button base sets `disabled:pointer-events-none`, so no hover event ever
//     reaches a disabled button and that tooltip can never be shown.
//
//   pnpm exec vitest run src/components/__tests__/marketplace-install-cta-road.test.tsx

import "./access-picker-jsdom-shims";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

// The generated extension catalog is irrelevant to the card CTA and pulls the
// whole loader map in; stub it (same convention as the other component suites
// under src/**).
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: {} }));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/lib/cinatra-toast", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

import { buildMarketplaceCardNodes } from "../../../packages/extensions/src/screens/marketplace-card-nodes";
import { InstallPanelScopeProvider } from "@cinatra-ai/extensions/screens/extension-install-scope-panel";
import type { InstallPanelScopeContextValue } from "@cinatra-ai/extensions/screens/extension-install-scope-panel";
import type { MarketplaceCardData } from "@cinatra-ai/extensions/screens/marketplace-card-model";

const ORG_ID = "org-acme";

const TARGETS = [
  {
    value: `org:${ORG_ID}`,
    label: "Anyone in Acme Corp",
    level: "organization" as const,
    id: ORG_ID,
    disabled: false,
  },
  {
    value: "workspace",
    label: "Workspace: All",
    level: "workspace" as const,
    id: "workspace",
    disabled: false,
  },
];

/**
 * A listing the REGISTRY offers and this instance has never installed: the
 * exact shape `catalogEntryToCardData` produces for a fleet pack — a real
 * install identity, and no declared `sdkAbiRange` (the fleet's display and
 * skill packs declare none), so the compat verdict is the neutral "unknown"
 * that stays installable.
 */
function registryOfferedCard(over: Partial<MarketplaceCardData>): MarketplaceCardData {
  return {
    packageName: "@acme/blog-idea-artifact",
    packageVersion: "0.1.1",
    displayName: "Blog Ideas",
    description: "The blog-idea display.",
    kindSlug: "artifact",
    kindLabel: "Artifact",
    badge: null,
    freshnessAt: null,
    rating: null,
    detailHref: "/configuration/marketplace/@acme/blog-idea-artifact",
    installCount: null,
    manifestLogoUrl: null,
    iconSlug: "blog-idea-artifact",
    iconUrl: null,
    vendorLogoUrl: null,
    sdkAbiRange: null,
    vendor: null,
    ...over,
  } as MarketplaceCardData;
}

const SKILL = registryOfferedCard({
  packageName: "@acme/blog-skills",
  packageVersion: "0.1.1",
  displayName: "Blog Skills",
  kindSlug: "skill",
  kindLabel: "Skill",
  detailHref: "/configuration/marketplace/@acme/blog-skills",
  iconSlug: "blog-skills",
});

const DISPLAY = registryOfferedCard({});

type Rendered = {
  installAction: ReturnType<typeof vi.fn>;
  cardFor: (packageName: string) => HTMLElement;
  ctaFor: (packageName: string) => HTMLElement;
  controlFor: (packageName: string) => HTMLButtonElement;
};

/** Render the real grid composition for `cards` at the given registry state. */
function renderGrid(cards: MarketplaceCardData[], registryConnected: boolean): Rendered {
  const installAction = vi.fn(async () => undefined);
  const nodes = buildMarketplaceCardNodes({
    cards,
    // Never installed here — the registry is where these come from.
    installedVersionByName: new Map(),
    registryConnected,
    installAction: installAction as unknown as never,
    updateAction: (async () => undefined) as unknown as never,
    restoreAction: (async () => undefined) as unknown as never,
  });
  const scope: InstallPanelScopeContextValue = {
    installTargets: TARGETS,
    ownerEntityNames: { [`org:${ORG_ID}`]: "Acme Corp" },
    activeOrgId: ORG_ID,
    availability: { state: "ready", defaultValue: "workspace" },
    installAction: installAction as unknown as never,
  };
  render(
    <InstallPanelScopeProvider value={scope}>
      <div>
        {nodes.map((node) => (
          <div key={node.meta.packageName} data-package={node.meta.packageName}>
            {node.node}
          </div>
        ))}
      </div>
    </InstallPanelScopeProvider>,
  );
  const cardFor = (packageName: string) => {
    const host = document.querySelector<HTMLElement>(`[data-package="${packageName}"]`);
    if (!host) throw new Error(`no card rendered for ${packageName}`);
    return host;
  };
  const ctaFor = (packageName: string) =>
    within(cardFor(packageName)).getByTestId("extension-card-cta");
  const controlFor = (packageName: string) =>
    within(ctaFor(packageName)).getByRole("button") as HTMLButtonElement;
  return { installAction, cardFor, ctaFor, controlFor };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterAll(() => {
  // This file mocks two host modules; hand the package's full run back exactly
  // as it was found (new test files restore what they mock).
  vi.doUnmock("@/lib/generated/extensions.server");
  vi.doUnmock("@/lib/cinatra-toast");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("a registry-offered listing whose registry IS connected", () => {
  it("opens the §I.1 in-card install road when Install now is pressed on a display", () => {
    const grid = renderGrid([DISPLAY], true);
    const control = grid.controlFor(DISPLAY.packageName);
    expect(control.disabled).toBe(false);

    fireEvent.click(control);

    const panel = screen.getByTestId("extension-install-panel-body");
    expect(panel).toBeTruthy();
    expect(within(panel).getByTestId("extension-install-panel-picker")).toBeTruthy();
    expect(within(panel).getByTestId("extension-install-panel-submit")).toBeTruthy();
  });

  it("submits the bound install action when Install now is pressed on a skill", async () => {
    const grid = renderGrid([SKILL], true);
    const control = grid.controlFor(SKILL.packageName);
    expect(control.disabled).toBe(false);

    fireEvent.click(control);

    await vi.waitFor(() => expect(grid.installAction).toHaveBeenCalledTimes(1));
    // …bound to THIS listing's install identity (the per-row .bind), not to
    // some other card's package: a fired action with the wrong identity would
    // install the wrong pack.
    expect(grid.installAction.mock.calls[0]?.[0]).toEqual({
      packageName: SKILL.packageName,
      packageVersion: SKILL.packageVersion,
    });
  });
});

describe("a registry-offered listing whose registry is NOT connected", () => {
  for (const card of [DISPLAY, SKILL]) {
    it(`refuses on the card with a reason a viewer can read — ${card.kindSlug}`, async () => {
      const grid = renderGrid([card], false);
      const control = grid.controlFor(card.packageName);

      // It cannot install: the tarball comes from the registry.
      expect(control.disabled).toBe(true);

      fireEvent.click(control);

      // …and the press does exactly nothing — no install face, no action.
      expect(document.querySelector('[data-testid="extension-install-panel-body"]')).toBeNull();
      expect(grid.installAction).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();

      // So the REASON has to be on the card, in text, not in a tooltip the
      // browser can never show on a `disabled:pointer-events-none` button.
      const ctaText = (grid.ctaFor(card.packageName).textContent ?? "").trim();
      expect(
        ctaText,
        "an inert install control must SAY why it is inert — a bare 'Install now' that does nothing is the silent no-op",
      ).toBe("Registry not connected");
      // …and the actionable instruction is kept on the control itself.
      expect(control.getAttribute("title")).toBe("Connect the package registry to install");
      expect(
        control.className,
        "the control's own title must at least be reachable — the shared Button base disables pointer events on a disabled button",
      ).toMatch(/disabled:pointer-events-auto/);
    });
  }
});

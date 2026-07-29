// @vitest-environment jsdom
/**
 * Development → Tunnel tab contract (cinatra#2173).
 *
 * Two defects are pinned here:
 *
 *   1. DEAD LINKS. Both calls-to-action ("connect Tailscale" / "manage the
 *      connector") pointed at `/connectors/tailscale`, which is not a route —
 *      the tab's only remediation path 404'd. The live dispatch route is
 *      `/connectors/<vendor>/<slug>/setup`. The tab now resolves it through
 *      `getConnectorSetupHref`, and this suite asserts the RENDERED href
 *      against the literal route (not against the helper that produced it), so
 *      a vendor/slug/subroute change that breaks the link fails here.
 *
 *   2. SAVE-vs-RESTART AGREEMENT. Saving a public base URL does NOT take full
 *      effect live: the OAuth `validAudiences` are frozen at module eval (see
 *      ../actions.ts, and the mechanism pin in
 *      packages/mcp-server/src/__tests__/auth-plugins.test.ts). The surface and
 *      its documentation must both say so — a "no restart needed" note
 *      misdiagnoses seam tests as broken tunnels.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// The saved public base URL is irrelevant to both contracts; keep it empty so
// the tab renders without a DB.
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getMcpPublicBaseUrl: () => ({ publicBaseUrl: null, publicBaseUrlSource: "unknown" }),
}));

const getDevTunnelStatus = vi.fn<() => { connected: boolean; funnelUrlPreview: string | null }>();
vi.mock("@/lib/dev-tunnel-status", () => ({
  getDevTunnelStatus: () => getDevTunnelStatus(),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@/lib/cinatra-toast", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

const setMcpPublicBaseUrlAction =
  vi.fn<(input: { url: string | null }) => Promise<{ ok: true }>>();
vi.mock("../actions", () => ({
  setMcpPublicBaseUrlAction: (input: { url: string | null }) =>
    setMcpPublicBaseUrlAction(input),
}));

// The generated extension manifest carries per-package dynamic `import()`s that
// the vitest sandbox cannot resolve (the stubbed extension packages expose no
// `/register` subpath), so the registry's manifest input is stubbed — same
// approach as src/lib/__tests__/connectors-registry-schema-config.test.ts. Only
// the vendor scope matters here; the slug + setup subroute still come from the
// REAL connector catalog.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {
    "@cinatra-ai/tailscale-connector": {
      packageName: "@cinatra-ai/tailscale-connector",
      scope: "cinatra-ai",
      uiSurface: "schema-config",
      configSchema: { fields: [{ kind: "secret", key: "apiKey", label: "API key" }] },
      requestedHostPorts: ["ui", "secrets"],
    },
  },
}));

// NOT mocked — the real catalog + the real registry must produce the real
// dispatch route.
import {
  CONNECTOR_PACKAGE_SCOPE,
  getConnectorDescriptorBySlug,
} from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { getConnectorSetupHref } from "@/lib/connectors-registry.server";
import { PublicBaseUrlForm } from "../public-base-url-form";
import { TunnelTabContent } from "../tunnel-tab";

/**
 * The live connector-setup dispatch route for the Tailscale connector, spelled
 * out. `/connectors/tailscale` (the old value) is not a route.
 */
const TAILSCALE_SETUP_ROUTE = "/connectors/cinatra-ai/tailscale-connector/setup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function renderTunnelTab(overrides: {
  connected: boolean;
  isDevMode?: boolean;
}): HTMLElement {
  getDevTunnelStatus.mockReturnValue({
    connected: overrides.connected,
    funnelUrlPreview: overrides.connected ? "https://dev-instance.example.ts.net" : null,
  });
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <TunnelTabContent isDevMode={overrides.isDevMode ?? true} />,
  );
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  setMcpPublicBaseUrlAction.mockResolvedValue({ ok: true });
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

describe("tunnel tab — connector remediation links (#2173)", () => {
  it("spells the dispatch route the real catalog descriptor implies", () => {
    // Grounds the literal above in the REAL catalog data (slug + setup
    // subroute + package scope), so it cannot drift into a fiction.
    const descriptor = getConnectorDescriptorBySlug("tailscale-connector");
    if (!descriptor) throw new Error("tailscale-connector is not in the catalog");
    const vendor = CONNECTOR_PACKAGE_SCOPE.replace(/^@/, "");
    expect(
      `/connectors/${vendor}/${descriptor.slug}/${descriptor.setupSubroute}`,
    ).toBe(TAILSCALE_SETUP_ROUTE);
  });

  it("resolves the Tailscale setup href to the live dispatch route", () => {
    // The tab renders whatever the registry resolves; assert the registry
    // itself still yields the vendor/slug/subroute route the tab needs.
    expect(getConnectorSetupHref("tailscale-connector")).toBe(TAILSCALE_SETUP_ROUTE);
  });

  for (const connected of [true, false]) {
    it(`links the call-to-action at the setup route (tailscaleConnected=${connected})`, () => {
      const container = renderTunnelTab({ connected });
      const anchors = Array.from(container.querySelectorAll("a"));
      const setupLinks = anchors.filter(
        (a) => a.getAttribute("href") === TAILSCALE_SETUP_ROUTE,
      );
      expect(setupLinks).toHaveLength(1);
      expect(setupLinks[0]?.textContent).toBe(
        connected ? "manage the connector" : "connect Tailscale",
      );
    });

    it(`renders no dead /connectors/tailscale link (tailscaleConnected=${connected})`, () => {
      const container = renderTunnelTab({ connected });
      for (const anchor of Array.from(container.querySelectorAll("a"))) {
        // The old href, and any other link that stops short of the
        // vendor/slug/subroute dispatch shape.
        expect(anchor.getAttribute("href")).not.toBe("/connectors/tailscale");
      }
      expect(container.innerHTML).not.toContain('href="/connectors/tailscale"');
    });
  }
});

describe("tunnel tab — save requires a restart (#2173)", () => {
  for (const connected of [true, false]) {
    it(`states the restart requirement on the surface (tailscaleConnected=${connected})`, () => {
      const container = renderTunnelTab({ connected });
      const text = container.textContent ?? "";
      expect(text).toMatch(/[Rr]estart the app/);
      // The reason + BOTH consequences must be stated, not just the word
      // "restart", and each has to be the one that actually happens:
      //   - a request naming the NEW url is REJECTED (the provider's resource
      //     check throws before any token is minted — it is not an opaque
      //     token, and not a token bound to the old url);
      //   - the PREVIOUS audience stays in the boot allowlist, so clearing the
      //     field is not a revocation.
      expect(text).toMatch(/derived\s+once\s+at\s+startup/);
      expect(text).toMatch(/rejected/);
      expect(text).toMatch(/previous\s+URL\s+stays\s+accepted/);
      expect(text).toMatch(/not\s+a\s+revocation/);
    });
  }

  it("tells the operator on save that a restart is still needed", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        <PublicBaseUrlForm
          initialUrl=""
          tailscaleConnected={false}
          tailscaleUrl={null}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>("#publicBaseUrl");
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "https://dev-instance.example.ts.net");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const save = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Save",
    );
    expect(save, "Save button not rendered").toBeDefined();
    expect(save?.disabled).toBe(false);

    await act(async () => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(setMcpPublicBaseUrlAction).toHaveBeenCalledWith({
      url: "https://dev-instance.example.ts.net",
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    const message = String(toastSuccess.mock.calls[0]?.[0] ?? "");
    expect(message).toMatch(/[Rr]estart the app/);
    // Direction-neutral: the same sentence has to hold for a clear as for a set.
    expect(message).toMatch(/previous URL/);
  });

  it("documents the restart requirement on the server action", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/configuration/development/actions.ts"),
      "utf8",
    );
    // The retired claim: the save was documented as taking effect live.
    expect(source).not.toMatch(/without a dev-server restart/);
    expect(source).toMatch(/RESTART REQUIRED/);
    // …and it must name WHY, so the note survives a careless re-edit.
    expect(source).toMatch(/validAudiences/);
    expect(source).toMatch(/MODULE EVAL/);
    // …and cover the CLEAR direction, which is the security-relevant half:
    // clearing the field leaves the previous audience in the boot allowlist.
    expect(source).toMatch(/CLEAR \/ REPLACE/);
    expect(source).toMatch(/not, on its own, a\s+\*?\s*revocation/);
  });
});

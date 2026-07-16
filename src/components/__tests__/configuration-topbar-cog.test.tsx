/**
 * ConfigurationTopbarCog — the admin-only top-bar cog that replaced the sidebar
 * Configuration entry (cinatra#1563). Covers:
 *   - admin-only visibility (discoverability gate — NOT the security boundary)
 *   - link semantics + accessible name → /configuration
 *   - aria-current="page" on /configuration and its descendants, absent elsewhere
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const pathnameMock = vi.fn<() => string>(() => "/chat");
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
}));

import {
  ConfigurationTopbarCog,
  isConfigurationActive,
} from "../configuration-topbar-cog";

afterEach(() => {
  pathnameMock.mockReturnValue("/chat");
});

describe("isConfigurationActive", () => {
  it("matches the exact /configuration route", () => {
    expect(isConfigurationActive("/configuration")).toBe(true);
  });
  it.each([
    "/configuration/environment",
    "/configuration/webhooks",
    "/configuration/agents/approvals/abc123",
  ])("matches the descendant %s", (path) => {
    expect(isConfigurationActive(path)).toBe(true);
  });
  it.each(["/chat", "/configurations", "/config", "/notifications"])(
    "does not match unrelated path %s",
    (path) => {
      expect(isConfigurationActive(path)).toBe(false);
    },
  );
});

describe("ConfigurationTopbarCog", () => {
  it("renders nothing for a non-admin (discoverability gate)", () => {
    pathnameMock.mockReturnValue("/configuration");
    const html = renderToStaticMarkup(<ConfigurationTopbarCog isAdmin={false} />);
    expect(html).toBe("");
  });

  it("renders a link to /configuration with an accessible name for an admin", () => {
    pathnameMock.mockReturnValue("/chat");
    const html = renderToStaticMarkup(<ConfigurationTopbarCog isAdmin={true} />);
    expect(html).toContain('href="/configuration"');
    expect(html).toContain('aria-label="Configuration"');
    expect(html).toContain('data-testid="topbar-configuration-cog"');
  });

  it("marks aria-current=page on the exact /configuration route", () => {
    pathnameMock.mockReturnValue("/configuration");
    const html = renderToStaticMarkup(<ConfigurationTopbarCog isAdmin={true} />);
    expect(html).toContain('aria-current="page"');
  });

  it("marks aria-current=page on a /configuration descendant", () => {
    pathnameMock.mockReturnValue("/configuration/webhooks");
    const html = renderToStaticMarkup(<ConfigurationTopbarCog isAdmin={true} />);
    expect(html).toContain('aria-current="page"');
  });

  it("omits aria-current on an unrelated route", () => {
    pathnameMock.mockReturnValue("/chat");
    const html = renderToStaticMarkup(<ConfigurationTopbarCog isAdmin={true} />);
    expect(html).not.toContain("aria-current");
  });
});

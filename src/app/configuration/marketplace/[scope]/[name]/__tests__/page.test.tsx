/**
 * The in-app extension-detail PAGE is retired (cinatra#2736).
 *
 *   pnpm exec vitest run "src/app/configuration/marketplace/[scope]/[name]/__tests__/page.test.tsx"
 *
 * Owner ruling (2026-08-14): "The in-app route
 * `/configuration/marketplace/[scope]/[name]` is retired outright. Old in-app
 * URLs redirect to the in-app marketplace grid — plain, WITHOUT auto-opening
 * the modal: a URL that opens the modal would itself be a linkable in-app
 * detail view, which this ruling excludes."
 *
 * This file replaces the render suite of the full detail page it describes —
 * the breadcrumbed hero, the kind branches, the README body — because none of
 * those surfaces exist any more. What is pinned instead is the whole of the
 * route's remaining behaviour: the admin gate, the plain redirect, and the
 * absence of any detail render on this path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const { redirectMock, requireAdminSessionMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    const error = new Error(`NEXT_REDIRECT;${url}`);
    (error as { digest?: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  }),
  requireAdminSessionMock: vi.fn(async () => ({ user: { id: "admin" } })),
}));

vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@/lib/auth-session", () => ({ requireAdminSession: requireAdminSessionMock }));

const SOURCE = readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");
const GRID = "/configuration/marketplace";

/**
 * Invoke the route the way Next would, and report where it sent the request.
 * The module is imported lazily and per call so a route that still pulls a
 * detail-render graph fails THIS arm, rather than collapsing the whole file.
 */
async function visit() {
  const { default: RetiredExtensionMarketplaceEntryPage } = await import("../page");
  try {
    await RetiredExtensionMarketplaceEntryPage();
  } catch (error) {
    if (String((error as Error).message).startsWith("NEXT_REDIRECT")) return "redirected";
    throw error;
  }
  return "rendered";
}

beforeEach(() => {
  redirectMock.mockClear();
  requireAdminSessionMock.mockClear();
});

describe("acceptance 2 — the retired route redirects to the plain grid", () => {
  it("sends an old in-app detail URL to the marketplace grid", async () => {
    expect(await visit()).toBe("redirected");
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith(GRID);
  });

  it("lands PLAIN — no query and no fragment that could auto-open the modal", async () => {
    await visit();
    const [target] = redirectMock.mock.calls.at(-1) ?? [];
    expect(target).toBe(GRID);
    expect(String(target)).not.toContain("?");
    expect(String(target)).not.toContain("#");
  });

  it("cannot vary by package — the route reads no scope/name at all", async () => {
    const { default: page } = await import("../page");
    expect(
      page.length,
      "a retired route that still took `params` could still branch on the package",
    ).toBe(0);
    expect(SOURCE).not.toContain("params");
    expect(await visit()).toBe("redirected");
    expect(await visit()).toBe("redirected");
    expect(redirectMock.mock.calls.every(([t]) => t === GRID)).toBe(true);
  });

  it("keeps the route's pre-existing admin gate ahead of the redirect", async () => {
    await visit();
    expect(requireAdminSessionMock).toHaveBeenCalledTimes(1);
    expect(requireAdminSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
      redirectMock.mock.invocationCallOrder[0],
    );
  });

  it("AWAITS that gate — a refused caller never reaches the redirect", async () => {
    // Invocation ORDER alone would still pass on an un-awaited gate, which
    // would let a refused caller be redirected before the denial resolved.
    requireAdminSessionMock.mockRejectedValueOnce(new Error("NOT_ADMIN"));
    const { default: page } = await import("../page");
    await expect(page()).rejects.toThrow("NOT_ADMIN");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("acceptance 2 — no standalone detail surface is left on this path", () => {
  it("renders no detail chrome: the hero, the sections and the README body are gone", () => {
    for (const gone of [
      "MarketplaceDetailHeader",
      "RegistryEntryDetailSections",
      "MarketplaceReadmeSection",
      "MarketplaceReadmeMarkdownSection",
      "PageContent",
    ]) {
      expect(SOURCE, `${gone} must not be rendered by a retired route`).not.toContain(gone);
    }
  });

  it("reads no marketplace detail at all — the route answers before any fetch", () => {
    expect(SOURCE).not.toContain("fetchPublicMarketplaceExtensionDetail");
    expect(SOURCE).not.toContain("packageName");
  });
});

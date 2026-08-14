// Pins the Environment → Registries tab's existing graceful handling of an
// unconfigured instance namespace — the pattern cinatra#2753 mirrors onto
// /configuration/extensions (see
// ../../extensions/__tests__/page.test.tsx). `RegistriesTabContent` (in
// ../page.tsx) never calls anything that would throw
// `InstanceNamespaceNotConfiguredError`: it reads the instance identity FIRST
// and short-circuits to the shared setup-required card
// (`InstanceSetupRequiredCard`, extracted in this same change) before
// `loadVerdaccioConfigForReads()` / `listExtensionPackages` are ever reached.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
}));
// EnvironmentSettingsPage calls requireAdminSession() before rendering.
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn().mockResolvedValue({ user: { id: "user-1", isAdmin: true, email: "admin@example.com" } }),
  requireAuthSession: vi.fn().mockResolvedValue({ user: { id: "user-1", isAdmin: true } }),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
  readInstanceIdentityCacheEntry: vi.fn(() => null),
  storeInstanceIdentityCacheEntry: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({
  listAgentPackages: vi.fn(async () => []),
  listExtensionPackages: vi.fn(async () => []),
}));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForServer: vi.fn(async () => null),
  loadVerdaccioConfigForReads: vi.fn(async () => null),
}));

/** Recursively collect all text strings from a React element tree. */
function collectText(node: unknown): string[] {
  if (node === null || node === undefined || node === false) return [];
  if (typeof node === "string") return [node];
  if (typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (typeof node === "object") {
    const el = node as Record<string, unknown>;
    const results: string[] = [];
    if (el["props"]) {
      const props = el["props"] as Record<string, unknown>;
      if (props["children"]) results.push(...collectText(props["children"]));
    }
    return results;
  }
  return [];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Environment → Registries tab — setup-required card on an unconfigured instance namespace (cinatra#2753)", () => {
  it("renders the setup-required card when no instance identity is configured", async () => {
    const { readInstanceIdentity } = await import("@/lib/instance-identity-store");
    vi.mocked(readInstanceIdentity).mockReturnValue(null);
    const { default: Page } = await import("@/app/configuration/environment/page");

    const tree = await Page({ searchParams: Promise.resolve({ tab: "registries" }) });
    const texts = collectText(tree);

    expect(texts.some((t) => t.includes("Setup required"))).toBe(true);
    expect(texts.some((t) => t.includes("Open instance administration"))).toBe(true);
  });

  it("renders the setup-required card when the identity row has no instanceNamespace", async () => {
    const { readInstanceIdentity } = await import("@/lib/instance-identity-store");
    vi.mocked(readInstanceIdentity).mockReturnValue({ instanceNamespace: "" } as never);
    const { default: Page } = await import("@/app/configuration/environment/page");

    const tree = await Page({ searchParams: Promise.resolve({ tab: "registries" }) });
    const texts = collectText(tree);

    expect(texts.some((t) => t.includes("Setup required"))).toBe(true);
  });
});

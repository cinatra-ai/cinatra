// Tests for firstPublishedAt reconciliation and render behavior.
//
// `@testing-library/react` is NOT a workspace dev-dep, so the pure-render
// tests are marked `it.todo` so the typecheck/run gate stays clean. The
// unit-level helper tests for reconciliation logic and scope-filter behaviour
// run today against the placeholder `reconcileFirstPublishedAt` server-action
// helper.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
  writeInstanceIdentity: vi.fn(),
}));
// InstanceSettingsPage calls requireAdminSession() before rendering. Mock it so
// tests don't call Next.js `headers()` outside a request scope.
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn().mockResolvedValue({ user: { id: "user-1", isAdmin: true } }),
  requireAuthSession: vi.fn().mockResolvedValue({ user: { id: "user-1", isAdmin: true } }),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({
  listAgentPackages: vi.fn(async () => []),
}));
import { reconcileFirstPublishedAt } from "@/app/configuration/instance/actions";
import {
  type InstanceIdentity,
} from "@/lib/instance-identity-store";

const PRE_PUBLISH: InstanceIdentity = {
  instanceNamespace: "vendora",
  instanceDisplayName: "Vendor A",
  tokenCiphertext: "ct",
  tokenIv: "iv",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pwct",
  passwordIv: "pwiv",
  firstPublishedAt: null,
  createdAt: "2026-05-07T12:00:00.000Z",
};

const POST_PUBLISH: InstanceIdentity = {
  ...PRE_PUBLISH,
  firstPublishedAt: "2026-05-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InstanceSettingsPage — firstPublishedAt freeze reconciliation", () => {
  it("sets firstPublishedAt = now when registry shows current-scope packages and local value is null", async () => {
    const result = await reconcileFirstPublishedAt(
      PRE_PUBLISH,
      [{ packageName: "@vendora/something" }],
    );
    expect(result.firstPublishedAt).not.toBeNull();
    expect(typeof result.firstPublishedAt).toBe("string");
    expect(() => new Date(result.firstPublishedAt as string)).not.toThrow();
  });

  it("does NOT change firstPublishedAt when registry shows zero packages", async () => {
    const result = await reconcileFirstPublishedAt(POST_PUBLISH, []);
    expect(result.firstPublishedAt).toBe(POST_PUBLISH.firstPublishedAt);
  });

  it("does NOT reset firstPublishedAt to null when registry shows zero packages but value was set", async () => {
    const result = await reconcileFirstPublishedAt(POST_PUBLISH, []);
    expect(result.firstPublishedAt).not.toBeNull();
  });
});

describe("InstanceSettingsPage — scope filter", () => {
  it("freezes only when at least one package is under @<currentVendor>/", async () => {
    // Mixed list: vendorA package + vendorB package; identity is vendorA.
    // Filter must keep only vendorA -> count = 1 -> freeze fires.
    const result = await reconcileFirstPublishedAt(
      PRE_PUBLISH,
      [
        { packageName: "@vendora/foo" },
        { packageName: "@vendorb/bar" },
      ],
    );
    expect(result.firstPublishedAt).not.toBeNull();
  });

  it("does NOT freeze when no package is under @<currentVendor>/ (different scope only)", async () => {
    const otherVendorIdentity = { ...PRE_PUBLISH, instanceNamespace: "vendorc" };
    // Registry returns only vendorA + vendorB packages; none under @vendorc/.
    // Count under current scope = 0 -> freeze does NOT fire.
    const result = await reconcileFirstPublishedAt(
      otherVendorIdentity,
      [
        { packageName: "@vendora/foo" },
        { packageName: "@vendorb/bar" },
      ],
    );
    expect(result.firstPublishedAt).toBeNull();
  });
});

describe("InstanceSettingsPage — render output", () => {
  it.todo("pre-publish renders enabled <Input name='instanceNamespace'> with editVendorAction form action");
  it.todo("post-freeze renders disabled label + Rename button + freeze-reason copy");
  it.todo(
    "rename form submits a SINGLE input named instanceNamespace (not a disabled visible input AND a hidden input)",
  );
});

// ---------------------------------------------------------------------------
// Administration page Private publish destination subsection tests
// ---------------------------------------------------------------------------
//
// Strategy: call InstanceSettingsPage() (async RSC) directly, get the React
// element tree, and walk it with collectText() to assert locked copy strings.
// `@testing-library/react` is NOT a workspace dev-dep at the root vitest level.
// All render assertions work via recursive element-tree text extraction.

vi.mock("@/lib/deployment-registry-config", () => ({
  loadDeploymentRegistryConfig: vi.fn(() => ({
    publicRegistryUrl: "https://registry.cinatra.ai",
    publicReadToken: "fixture-public-read",
    publicPublishToken: null,
    privateRegistryUrl: null,
    privateReadToken: null,
    privatePublishToken: null,
    privateDestinationConfigured: false,
    privateDestinationId: null,
    routingMode: "shared-acl" as const,
  })),
}));

vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForServer: vi.fn(async () => null),
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

const BASE_IDENTITY_223: InstanceIdentity = {
  instanceNamespace: "vendora",
  instanceDisplayName: "Vendor A",
  tokenCiphertext: "ct",
  tokenIv: "iv",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pwct",
  passwordIv: "pwiv",
  firstPublishedAt: null,
  createdAt: "2026-05-07T12:00:00.000Z",
};

describe("Environment instance tab — registry destination card moved out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render the Private publish destination card on the Instance tab", async () => {
    const { readInstanceIdentity } = await import("@/lib/instance-identity-store");
    vi.mocked(readInstanceIdentity).mockReturnValue(BASE_IDENTITY_223 as never);
    const { default: Page } = await import("@/app/configuration/environment/page");
    const tree = await Page({ searchParams: Promise.resolve({ tab: "instance" }) });
    const texts = collectText(tree);
    expect(texts.some((t) => t.includes("Private publish destination"))).toBe(false);
  });

  it("renders the setup-style instance identity fields", async () => {
    const { readInstanceIdentity } = await import("@/lib/instance-identity-store");
    vi.mocked(readInstanceIdentity).mockReturnValue(BASE_IDENTITY_223 as never);
    const { default: Page } = await import("@/app/configuration/environment/page");
    const tree = await Page({ searchParams: Promise.resolve({ tab: "instance" }) });
    const texts = collectText(tree);
    expect(texts.some((t) => t.includes("Instance display name"))).toBe(true);
    expect(texts.some((t) => t.includes("Instance namespace"))).toBe(true);
  });

  // cinatra#357 — defect #1: a failed Save redirects back with ?error=<msg>,
  // which the instance tab must surface (instead of silently reverting).
  it("renders the ?error= banner so a failed Save is visible, not a silent revert", async () => {
    const { readInstanceIdentity } = await import("@/lib/instance-identity-store");
    vi.mocked(readInstanceIdentity).mockReturnValue(BASE_IDENTITY_223 as never);
    const { default: Page } = await import("@/app/configuration/environment/page");
    const tree = await Page({
      searchParams: Promise.resolve({ tab: "instance", error: "That vendor name is already taken." }),
    });
    const texts = collectText(tree);
    expect(texts.some((t) => t.includes("Could not save instance changes"))).toBe(true);
    expect(texts.some((t) => t.includes("That vendor name is already taken."))).toBe(true);
  });

  it("does not render the error banner when no ?error= param is present", async () => {
    const { readInstanceIdentity } = await import("@/lib/instance-identity-store");
    vi.mocked(readInstanceIdentity).mockReturnValue(BASE_IDENTITY_223 as never);
    const { default: Page } = await import("@/app/configuration/environment/page");
    const tree = await Page({ searchParams: Promise.resolve({ tab: "instance" }) });
    const texts = collectText(tree);
    expect(texts.some((t) => t.includes("Could not save instance changes"))).toBe(false);
  });

  it("renders the ?saved=1 success banner after a successful Save", async () => {
    const { readInstanceIdentity } = await import("@/lib/instance-identity-store");
    vi.mocked(readInstanceIdentity).mockReturnValue(BASE_IDENTITY_223 as never);
    const { default: Page } = await import("@/app/configuration/environment/page");
    const tree = await Page({ searchParams: Promise.resolve({ tab: "instance", saved: "1" }) });
    const texts = collectText(tree);
    expect(texts.some((t) => t.includes("Instance saved"))).toBe(true);
  });
});

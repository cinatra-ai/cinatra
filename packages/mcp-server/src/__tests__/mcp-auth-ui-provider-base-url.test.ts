import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sentinel = { client: "mcp-auth-singleton" };
  const plugins = [{ plugin: "username" }, { plugin: "admin" },
    { plugin: "organization" }, { plugin: "oauth-provider" }];
  return {
    sentinel, plugins,
    createAuthClient: vi.fn(() => sentinel),
    usernameClient: vi.fn(() => plugins[0]),
    adminClient: vi.fn(() => plugins[1]),
    organizationClient: vi.fn(() => plugins[2]),
    oauthProviderClient: vi.fn(() => plugins[3]),
  };
});

vi.mock("better-auth/react", () => ({ createAuthClient: mocks.createAuthClient }));
vi.mock("better-auth/client/plugins", () => ({
  usernameClient: mocks.usernameClient,
  adminClient: mocks.adminClient,
  organizationClient: mocks.organizationClient,
}));
vi.mock("@better-auth/oauth-provider/client", () => ({
  oauthProviderClient: mocks.oauthProviderClient,
}));
vi.mock("@daveyplate/better-auth-ui", () => ({ AuthUIProvider: () => null }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));

const envNames = ["NEXT_PUBLIC_BETTER_AUTH_URL", "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL"] as const;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", undefined);
  for (const name of envNames) vi.stubEnv(name, undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function expectClientOptions(baseURL: string) {
  const provider = await import("../components/mcp-auth-ui-provider");
  expect(mocks.createAuthClient).toHaveBeenCalledExactlyOnceWith({
    baseURL, plugins: mocks.plugins,
  });
  for (const factory of [mocks.usernameClient, mocks.adminClient,
    mocks.organizationClient, mocks.oauthProviderClient]) {
    expect(factory).toHaveBeenCalledExactlyOnceWith();
  }
  expect(provider.mcpAuthClient).toBe(mocks.sentinel);
  expect(provider.McpAuthUiProvider).toBeTypeOf("function");
  return provider;
}

describe("MCP auth client baseURL at actual module initialization", () => {
  it("uses the browser page origin, including its nondefault port, over build-time URLs", async () => {
    vi.stubGlobal("window", { location: { origin: "https://preview.example.test:8443" } });
    vi.stubEnv(envNames[0], "https://auth.example.test");
    vi.stubEnv(envNames[1], "https://app.example.test");
    vi.stubEnv(envNames[2], "https://site.example.test");
    await expectClientOptions("https://preview.example.test:8443");
  });

  it("uses browser origin when every public URL is absent", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:4317" } });
    await expectClientOptions("http://localhost:4317");
  });

  it.each([
    ["BETTER_AUTH precedes APP and SITE", ["https://auth.example.test", "https://app.example.test", "https://site.example.test"], "https://auth.example.test"],
    ["APP precedes SITE", [undefined, "https://app.example.test", "https://site.example.test"], "https://app.example.test"],
    ["SITE is the last environment fallback", [undefined, undefined, "https://site.example.test"], "https://site.example.test"],
    ["localhost is the final fallback", [undefined, undefined, undefined], "http://localhost:3000"],
    ["empty BETTER_AUTH is preserved", ["", "https://app.example.test", "https://site.example.test"], ""],
    ["empty APP is preserved", [undefined, "", "https://site.example.test"], ""],
    ["empty SITE is preserved", [undefined, undefined, ""], ""],
  ] as const)("preserves SSR nullish selection: %s", async (_label, values, expected) => {
    for (const [index, name] of envNames.entries()) vi.stubEnv(name, values[index]);
    await expectClientOptions(expected);
  });

  it("exports the same singleton and initializes its unchanged plugins only once", async () => {
    vi.stubEnv(envNames[0], "https://auth.example.test");
    const first = await expectClientOptions("https://auth.example.test");
    vi.stubGlobal("window", { location: { origin: "https://later.example.test" } });
    vi.stubEnv(envNames[0], "https://later-auth.example.test");
    const second = await import("../components/mcp-auth-ui-provider");
    expect(second).toBe(first);
    expect(second.mcpAuthClient).toBe(mocks.sentinel);
    expect(mocks.createAuthClient).toHaveBeenCalledTimes(1);
  });
});

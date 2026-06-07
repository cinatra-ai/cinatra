// Tests for saveInstanceIdentityAction.
//
// Covers namespace validation, Verdaccio PUT, password generation, email from
// session, CINATRA_ENCRYPTION_KEY pre-check, and instanceDisplayName
// persistence.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-session", () => ({
  // Admin gate.
  requireAdminSession: vi.fn(async () => ({ user: { id: "user-1", email: "operator@example.com" } })),
  requireAuthSession: vi.fn(async () => ({ user: { id: "user-1", email: "operator@example.com" } })),
}));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => null),
  writeInstanceIdentity: vi.fn(),
  buildFreshInstanceIdentityDurableFields: vi.fn(() => ({
    instanceId: "11111111-1111-4111-8111-111111111111",
    instanceAttachSecretCiphertext: "test-attach-ct",
    instanceAttachSecretIv: "test-attach-iv",
    instanceAttachSecretAlgo: "aes-256-gcm",
  })),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
}));
vi.mock("@/lib/instance-secrets", () => ({
  encryptSecret: vi.fn((s: string) => ({ ciphertext: "enc:" + s, iv: "iv-stub" })),
}));
vi.mock("@/lib/marketplace-attach", () => ({
  ensureMarketplaceAttachment: vi.fn(async () => undefined),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    // Capture the redirect target via a thrown sentinel so the action
    // execution stops where the real `redirect()` would.
    const err = new Error("REDIRECT:" + url);
    (err as unknown as { __isRedirect: true }).__isRedirect = true;
    throw err;
  }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { saveInstanceIdentityAction } from "@/app/setup/name/actions";
import { redirect } from "next/navigation";
import { writeInstanceIdentity } from "@/lib/instance-identity-store";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.CINATRA_ENCRYPTION_KEY;

// The action now branches on the pre-provisioned registry env vars. Capture and
// clear them so the self-register (mode b) tests are deterministic regardless of
// the developer's local environment.
const REGISTRY_ENV_VARS = [
  "CINATRA_AGENT_REGISTRY_TOKEN",
  "CINATRA_AGENT_REGISTRY_URL",
  "CINATRA_AGENT_REGISTRY_SCOPE",
  "CINATRA_AGENT_REGISTRY_PASSWORD",
  "MARKETPLACE_INSTANCE_TOKEN",
  "CINATRA_RUNTIME_MODE",
] as const;
const ORIGINAL_REGISTRY_ENV: Record<string, string | undefined> = {};
for (const k of REGISTRY_ENV_VARS) ORIGINAL_REGISTRY_ENV[k] = process.env[k];

function buildFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function buildValidFormData(overrides: Record<string, string> = {}): FormData {
  return buildFormData({
    instanceDisplayName: "Test Display Name",
    instanceNamespace: "example-namespace",
    ...overrides,
  });
}

function mockFetchResponse(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

async function captureRedirect(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
  } catch (err) {
    const e = err as { __isRedirect?: true; message?: string };
    if (e.__isRedirect && typeof e.message === "string" && e.message.startsWith("REDIRECT:")) {
      return e.message.slice("REDIRECT:".length);
    }
    throw err;
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CINATRA_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  for (const k of REGISTRY_ENV_VARS) delete process.env[k];
  mockFetchResponse(201, { token: "verdaccio-token-abc" });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.CINATRA_ENCRYPTION_KEY;
  else process.env.CINATRA_ENCRYPTION_KEY = ORIGINAL_KEY;
  for (const k of REGISTRY_ENV_VARS) {
    const original = ORIGINAL_REGISTRY_ENV[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
  vi.restoreAllMocks();
});

describe("saveInstanceIdentityAction input validation (namespace + display name)", () => {
  it.each([
    ["empty namespace", ""],
    ["single char namespace", "a"],
    ["namespace with underscore", "ab_cd"],
    ["namespace too long (40 chars)", "x".repeat(40)],
    ["namespace leading hyphen", "-vendor"],
    ["namespace with space", "ven dor"],
  ])("rejects invalid namespace (%s) and redirects with error= query param", async (_label, ns) => {
    const url = await captureRedirect(() =>
      saveInstanceIdentityAction(buildFormData({ instanceDisplayName: "Test Name", instanceNamespace: ns })),
    );
    expect(url).not.toBeNull();
    expect(url).toMatch(/error=/);
    expect(vi.mocked(redirect)).toHaveBeenCalled();
  });

  it("canonicalizes uppercase input (lowercased) and accepts it", async () => {
    await captureRedirect(() =>
      saveInstanceIdentityAction(buildFormData({ instanceDisplayName: "Test Name", instanceNamespace: "EXAMPLE-NAMESPACE" })),
    );
    // Self-register path runs; the adduser PUT targets the canonical (lowercased) namespace.
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/-\/user\/org\.couchdb\.user:example-namespace$/);
  });

  it("rejects empty instanceDisplayName and redirects with error= query param", async () => {
    const url = await captureRedirect(() =>
      saveInstanceIdentityAction(buildFormData({ instanceDisplayName: "", instanceNamespace: "example-namespace" })),
    );
    expect(url).not.toBeNull();
    expect(url).toMatch(/error=/);
  });

  it("accepts valid input and proceeds to fetch", async () => {
    await captureRedirect(() => saveInstanceIdentityAction(buildValidFormData()));
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

describe("saveInstanceIdentityAction Verdaccio PUT", () => {
  it("issues PUT /-/user/org.couchdb.user:<instanceNamespace> with the documented body shape", async () => {
    await captureRedirect(() => saveInstanceIdentityAction(buildValidFormData()));
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/-\/user\/org\.couchdb\.user:example-namespace$/);
    expect((init as RequestInit).method).toBe("PUT");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("content-type")?.toLowerCase()).toBe("application/json");
    const parsedBody = JSON.parse(String((init as RequestInit).body));
    expect(parsedBody).toEqual(
      expect.objectContaining({
        _id: "org.couchdb.user:example-namespace",
        name: "example-namespace",
        type: "user",
        roles: [],
      }),
    );
    expect(parsedBody.password).toBeTypeOf("string");
    expect(parsedBody.email).toBeTypeOf("string");
  });

  it("maps a 409 'already registered' response to a friendly error redirect", async () => {
    mockFetchResponse(409, { error: "user oss is already registered" });
    const url = await captureRedirect(() =>
      saveInstanceIdentityAction(buildValidFormData()),
    );
    expect(url).not.toBeNull();
    expect(url).toMatch(/error=/);
    expect(url?.toLowerCase()).toMatch(/already.*taken|already.*registered/);
  });

  it("defers registry provisioning in production when no registry/marketplace env is configured", async () => {
    process.env.CINATRA_RUNTIME_MODE = "production";

    const url = await captureRedirect(() => saveInstanceIdentityAction(buildValidFormData()));

    expect(url).toBe("/setup");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const [payload] = vi.mocked(writeInstanceIdentity).mock.calls[0] ?? [];
    expect(payload?.instanceNamespace).toBe("example-namespace");
    expect(payload?.instanceDisplayName).toBe("Test Display Name");
    expect(payload?.tokenCiphertext).toBeUndefined();
    expect(payload?.tokenIv).toBeUndefined();
    expect(payload?.registries?.remote).toEqual({
      url: "https://registry.cinatra.ai",
      namespace: "example-namespace",
      status: "not_connected",
    });
  });

  it("continues setup with deferred registry state when explicit self-registration is disabled", async () => {
    process.env.CINATRA_AGENT_REGISTRY_URL = "https://registry.cinatra.ai";
    mockFetchResponse(409, { error: "user registration disabled" });

    const url = await captureRedirect(() => saveInstanceIdentityAction(buildValidFormData()));

    expect(url).toBe("/setup");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(writeInstanceIdentity).mock.calls[0] ?? [];
    expect(payload?.instanceNamespace).toBe("example-namespace");
    expect(payload?.tokenCiphertext).toBeUndefined();
    expect(payload?.registries?.remote?.status).toBe("not_connected");
  });
});

describe("saveInstanceIdentityAction password generation", () => {
  it("generated password matches /^[A-Za-z0-9_-]{43}$/ (32 bytes base64url)", async () => {
    await captureRedirect(() => saveInstanceIdentityAction(buildValidFormData()));
    const fetchMock = vi.mocked(globalThis.fetch);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const parsedBody = JSON.parse(String((init as RequestInit).body));
    expect(parsedBody.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("saveInstanceIdentityAction email source", () => {
  it("uses the auth-session email, NOT a competing form field", async () => {
    await captureRedirect(() =>
      saveInstanceIdentityAction(
        buildValidFormData({ email: "attacker@example.org" }),
      ),
    );
    const fetchMock = vi.mocked(globalThis.fetch);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const parsedBody = JSON.parse(String((init as RequestInit).body));
    expect(parsedBody.email).toBe("operator@example.com");
  });
});

describe("saveInstanceIdentityAction CINATRA_ENCRYPTION_KEY pre-check", () => {
  it("redirects with an admin-facing error when CINATRA_ENCRYPTION_KEY is unset at action time", async () => {
    delete process.env.CINATRA_ENCRYPTION_KEY;
    const url = await captureRedirect(() =>
      saveInstanceIdentityAction(buildValidFormData()),
    );
    expect(url).not.toBeNull();
    expect(url).toMatch(/error=/);
    expect(url?.toUpperCase()).toContain("CINATRA_ENCRYPTION_KEY");
  });
});

describe("saveInstanceIdentityAction persistence payload", () => {
  it("persists both instanceDisplayName and instanceNamespace to writeInstanceIdentity", async () => {
    await captureRedirect(() =>
      saveInstanceIdentityAction(buildFormData({
        instanceDisplayName: "My Instance",
        instanceNamespace: "myinstance",
      })),
    );
    const writeMock = vi.mocked(writeInstanceIdentity);
    expect(writeMock).toHaveBeenCalledTimes(1);
    const [payload] = writeMock.mock.calls[0] ?? [];
    expect(payload?.instanceNamespace).toBe("myinstance");
    expect(payload?.instanceDisplayName).toBe("My Instance");
  });

  it("redirects to /setup/name?error=... on validation failure", async () => {
    const url = await captureRedirect(() =>
      saveInstanceIdentityAction(buildFormData({
        instanceDisplayName: "",
        instanceNamespace: "example-namespace",
      })),
    );
    expect(url).toMatch(/\/setup\/name\?error=/);
  });
});

describe("saveInstanceIdentityAction pre-provisioned token path (locked-down registry)", () => {
  // 16+ chars, no whitespace/control chars — passes isPlausibleRegistryToken.
  const VALID_ENV_TOKEN = "preprovisioned-token-1234567890";

  it("uses CINATRA_AGENT_REGISTRY_TOKEN and does NOT call the adduser endpoint", async () => {
    process.env.CINATRA_AGENT_REGISTRY_TOKEN = VALID_ENV_TOKEN;
    process.env.CINATRA_AGENT_REGISTRY_URL = "https://registry.cinatra.ai";
    process.env.CINATRA_AGENT_REGISTRY_SCOPE = "@example-namespace";

    const url = await captureRedirect(() => saveInstanceIdentityAction(buildValidFormData()));

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(url).toBe("/setup");
    const writeMock = vi.mocked(writeInstanceIdentity);
    expect(writeMock).toHaveBeenCalledTimes(1);
    const [payload] = writeMock.mock.calls[0] ?? [];
    // encryptSecret is mocked to prefix "enc:" — confirms the env token is what
    // got persisted (encrypted), not a freshly-minted one.
    expect(payload?.tokenCiphertext).toBe("enc:" + VALID_ENV_TOKEN);
  });

  // Assert the setup-time write persists instanceId + the encrypted
  // attach-secret fields. Boot-time ensureInstanceId() must then be a no-op
  // for fresh installs (post-consumer-split).
  it("persists instanceId + instanceAttachSecret fields on initial setup", async () => {
    process.env.CINATRA_AGENT_REGISTRY_TOKEN = VALID_ENV_TOKEN;
    process.env.CINATRA_AGENT_REGISTRY_URL = "https://registry.cinatra.ai";
    process.env.CINATRA_AGENT_REGISTRY_SCOPE = "@example-namespace";
    await captureRedirect(() => saveInstanceIdentityAction(buildValidFormData()));
    const [payload] = vi.mocked(writeInstanceIdentity).mock.calls[0] ?? [];
    expect(payload?.instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(payload?.instanceAttachSecretCiphertext).toBe("test-attach-ct");
    expect(payload?.instanceAttachSecretIv).toBe("test-attach-iv");
    expect(payload?.instanceAttachSecretAlgo).toBe("aes-256-gcm");
  });

  it("stores CINATRA_AGENT_REGISTRY_PASSWORD when supplied", async () => {
    process.env.CINATRA_AGENT_REGISTRY_TOKEN = VALID_ENV_TOKEN;
    process.env.CINATRA_AGENT_REGISTRY_URL = "https://registry.cinatra.ai";
    process.env.CINATRA_AGENT_REGISTRY_SCOPE = "@example-namespace";
    process.env.CINATRA_AGENT_REGISTRY_PASSWORD = "operator-supplied-password";

    await captureRedirect(() => saveInstanceIdentityAction(buildValidFormData()));

    const [payload] = vi.mocked(writeInstanceIdentity).mock.calls[0] ?? [];
    expect(payload?.passwordCiphertext).toBe("enc:operator-supplied-password");
  });

  it("rejects when CINATRA_AGENT_REGISTRY_URL is missing", async () => {
    process.env.CINATRA_AGENT_REGISTRY_TOKEN = VALID_ENV_TOKEN;
    process.env.CINATRA_AGENT_REGISTRY_SCOPE = "@example-namespace";

    const url = await captureRedirect(() => saveInstanceIdentityAction(buildValidFormData()));

    expect(url).toMatch(/error=/);
    expect(url).toContain("CINATRA_AGENT_REGISTRY_URL");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("rejects when CINATRA_AGENT_REGISTRY_SCOPE does not match the namespace", async () => {
    process.env.CINATRA_AGENT_REGISTRY_TOKEN = VALID_ENV_TOKEN;
    process.env.CINATRA_AGENT_REGISTRY_URL = "https://registry.cinatra.ai";
    process.env.CINATRA_AGENT_REGISTRY_SCOPE = "@wrong-scope";

    const url = await captureRedirect(() => saveInstanceIdentityAction(buildValidFormData()));

    expect(url).toMatch(/error=/);
    expect(url?.toLowerCase()).toMatch(/scope/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("rejects a malformed token (contains whitespace)", async () => {
    process.env.CINATRA_AGENT_REGISTRY_TOKEN = "bad token with spaces in it";
    process.env.CINATRA_AGENT_REGISTRY_URL = "https://registry.cinatra.ai";
    process.env.CINATRA_AGENT_REGISTRY_SCOPE = "@example-namespace";

    const url = await captureRedirect(() => saveInstanceIdentityAction(buildValidFormData()));

    expect(url).toMatch(/error=/);
    expect(url?.toLowerCase()).toMatch(/malformed|whitespace/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });
});

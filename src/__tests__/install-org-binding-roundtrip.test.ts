// cinatra#274 — multi-tenant install→org binding ({orgId, runBy}) persistence.
//
// Mirrors the blogConnectorId round-trip test: the binding has to survive every
// row-rebuild save path (the constructors build `nextInstance` field-by-field,
// so a field outside the known set silently disappears without explicit
// preservation), and a NEW save must capture it. Covers:
//
//   WordPress:
//     1. saveWordPressInstance — captures a passed {orgId, runBy}; preserves the
//        existing binding on edit-without-binding; never overwrites with
//        undefined.
//     2. saveWordPressInstanceFromNangoConnection — preserves the existing
//        binding across a Nango reconnect (Nango carries no Cinatra identity).
//     3. getWordPressAPISettings normalizer surfaces the binding on re-read.
//
//   Drupal:
//     4. saveDrupalInstance — captures a passed {orgId, runBy}; falls back to
//        the session binding when none is passed; preserves on edit.
//
// I/O-bound helpers are mocked; the constructors run against an in-memory
// connector_config blob.

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- shared in-memory connector_config blobs (per config key) ----------------
vi.mock("@/lib/database", () => {
  const blobs: Record<string, { instances: unknown[]; loggingEnabled?: boolean }> = {};
  return {
    readConnectorConfigFromDatabase: vi.fn((key: string, fallback: unknown) => blobs[key] ?? fallback),
    writeConnectorConfigToDatabase: vi.fn((key: string, v: { instances: unknown[] }) => {
      blobs[key] = v;
    }),
    __getBlob: (key: string) => blobs[key],
    __setBlob: (key: string, v: { instances: unknown[]; loggingEnabled?: boolean }) => {
      blobs[key] = v;
    },
    __reset: () => {
      for (const k of Object.keys(blobs)) delete blobs[k];
    },
  };
});

vi.mock("@/lib/nango-system", () => ({
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: { wordpress: "wordpress-config", drupal: "drupal-config" },
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS_DEFAULT: undefined,
  deleteNangoConnection: vi.fn(),
  removeNangoConnectionRecord: vi.fn(),
  getNangoConnection: vi.fn(),
  ensureNangoIntegration: vi.fn(),
  ensureNangoConnectorIntegration: vi.fn(),
  getNangoCredentials: vi.fn().mockResolvedValue({ apiKey: "drupal-bearer-key-123456" }),
  importNangoConnection: vi.fn(),
  saveNangoConnectionRecord: vi.fn(),
  isNangoConfigured: vi.fn().mockReturnValue(true),
}));

// Drupal capture-from-session helper reads @/lib/auth-session lazily; default to
// "no session" so an explicitly-passed binding (or preservation) is what's tested
// unless a test overrides it.
const getAuthSession = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
}));

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ id: 1, name: "site", url: "https://example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  const dbMod = (await import("@/lib/database")) as unknown as { __reset: () => void };
  dbMod.__reset();
  getAuthSession.mockResolvedValue(null);
  // Re-arm the shared nango credential mock to the Drupal readback shape
  // ({ apiKey }) — a WordPress test below overrides it to { username, password },
  // and the module mock is a file-wide singleton, so reset it every test.
  const nango = (await import("@/lib/nango-system")) as unknown as {
    getNangoCredentials: { mockResolvedValue: (v: unknown) => void };
  };
  nango.getNangoCredentials.mockResolvedValue({ apiKey: "drupal-bearer-key-123456" });
});

// ---------------------------------------------------------------------------
// WordPress
// ---------------------------------------------------------------------------

describe("WordPress install→org binding round-trip (cinatra#274)", () => {
  it("saveWordPressInstance captures a passed {orgId, runBy} on a new row", async () => {
    const { saveWordPressInstance } = await import("@/lib/wordpress-api");
    const saved = await saveWordPressInstance({
      siteUrl: "https://tenant-a.example",
      username: "operator",
      applicationPassword: "app-password",
      orgId: "org_a",
      runBy: "u_a",
    });
    expect(saved.orgId).toBe("org_a");
    expect(saved.runBy).toBe("u_a");
  });

  it("saveWordPressInstance preserves the existing binding on edit-without-binding (never overwrites with undefined)", async () => {
    const { saveWordPressInstance } = await import("@/lib/wordpress-api");
    const dbMod = (await import("@/lib/database")) as unknown as {
      __setBlob: (k: string, v: { instances: unknown[] }) => void;
      __getBlob: (k: string) => { instances: Array<{ orgId?: string; runBy?: string }> };
    };
    dbMod.__setBlob("wordpress", {
      instances: [
        {
          id: "wp-1",
          name: "Existing",
          siteUrl: "https://tenant-a.example",
          username: "operator",
          applicationPassword: "app-password",
          providerConfigKey: "wordpress-config",
          connectionId: "wp-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          orgId: "org_a",
          runBy: "u_a",
        },
      ],
    });
    await saveWordPressInstance({
      id: "wp-1",
      siteUrl: "https://tenant-a.example",
      username: "operator",
      applicationPassword: "app-password",
      // no orgId/runBy passed (session-less re-save)
    });
    const blob = dbMod.__getBlob("wordpress");
    expect(blob.instances[0]?.orgId).toBe("org_a");
    expect(blob.instances[0]?.runBy).toBe("u_a");
  });

  it("saveWordPressInstanceFromNangoConnection preserves the binding across reconnect", async () => {
    const { saveWordPressInstanceFromNangoConnection } = await import("@/lib/wordpress-api");
    const dbMod = (await import("@/lib/database")) as unknown as {
      __setBlob: (k: string, v: { instances: unknown[] }) => void;
      __getBlob: (k: string) => { instances: Array<{ orgId?: string; runBy?: string }> };
    };
    dbMod.__setBlob("wordpress", {
      instances: [
        {
          id: "wp-1",
          name: "Existing",
          siteUrl: "https://tenant-a.example",
          username: "operator",
          applicationPassword: "app-password",
          providerConfigKey: "wordpress-config",
          connectionId: "conn-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          orgId: "org_a",
          runBy: "u_a",
        },
      ],
    });
    // Nango credential resolver: stub the wordpress-api private path via fetch +
    // the getNangoCredentials mock shape (username/password).
    const nango = (await import("@/lib/nango-system")) as unknown as {
      getNangoCredentials: { mockResolvedValue: (v: unknown) => void };
    };
    nango.getNangoCredentials.mockResolvedValue({ username: "operator", password: "app-password" });

    await saveWordPressInstanceFromNangoConnection({
      siteUrl: "https://tenant-a.example",
      providerConfigKey: "wordpress-config",
      connectionId: "conn-1",
    });
    const blob = dbMod.__getBlob("wordpress");
    expect(blob.instances[0]?.orgId).toBe("org_a");
    expect(blob.instances[0]?.runBy).toBe("u_a");
  });

  it("does NOT write a HALF binding on a new row (runBy without orgId)", async () => {
    const { saveWordPressInstance } = await import("@/lib/wordpress-api");
    const saved = await saveWordPressInstance({
      siteUrl: "https://tenant-half.example",
      username: "operator",
      applicationPassword: "app-password",
      // session had no active org → orgId undefined; runBy present. Must NOT
      // persist a Frankenstein binding.
      runBy: "u_a",
    });
    expect(saved.orgId).toBeUndefined();
    expect(saved.runBy).toBeUndefined();
  });

  it("does NOT half-overwrite an existing binding when only runBy is supplied on edit", async () => {
    const { saveWordPressInstance } = await import("@/lib/wordpress-api");
    const dbMod = (await import("@/lib/database")) as unknown as {
      __setBlob: (k: string, v: { instances: unknown[] }) => void;
      __getBlob: (k: string) => { instances: Array<{ orgId?: string; runBy?: string }> };
    };
    dbMod.__setBlob("wordpress", {
      instances: [
        {
          id: "wp-1",
          name: "Existing",
          siteUrl: "https://tenant-a.example",
          username: "operator",
          applicationPassword: "app-password",
          providerConfigKey: "wordpress-config",
          connectionId: "wp-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          orgId: "org_a",
          runBy: "u_a",
        },
      ],
    });
    await saveWordPressInstance({
      id: "wp-1",
      siteUrl: "https://tenant-a.example",
      username: "operator",
      applicationPassword: "app-password",
      // only runBy supplied (no orgId) — must inherit the EXISTING pair intact,
      // never mix new runBy with stale orgId.
      runBy: "u_DIFFERENT",
    });
    const blob = dbMod.__getBlob("wordpress");
    expect(blob.instances[0]?.orgId).toBe("org_a");
    expect(blob.instances[0]?.runBy).toBe("u_a");
  });

  it("getWordPressAPISettings normalizer surfaces the binding on re-read", async () => {
    const { saveWordPressInstance, getWordPressAPISettings } = await import("@/lib/wordpress-api");
    await saveWordPressInstance({
      siteUrl: "https://tenant-a.example",
      username: "operator",
      applicationPassword: "app-password",
      orgId: "org_a",
      runBy: "u_a",
    });
    const settings = getWordPressAPISettings();
    expect(settings.instances[0]?.orgId).toBe("org_a");
    expect(settings.instances[0]?.runBy).toBe("u_a");
  });
});

// ---------------------------------------------------------------------------
// Drupal
// ---------------------------------------------------------------------------

describe("Drupal install→org binding round-trip (cinatra#274)", () => {
  it("saveDrupalInstance captures a passed {orgId, runBy} on a new row", async () => {
    const { saveDrupalInstance } = await import("@/lib/drupal-api");
    const saved = await saveDrupalInstance({
      name: "Tenant A",
      siteUrl: "https://tenant-a.example",
      mcpApiKey: "drupal-bearer-key-123456",
      orgId: "org_a",
      runBy: "u_a",
    });
    expect(saved.orgId).toBe("org_a");
    expect(saved.runBy).toBe("u_a");
  });

  it("saveDrupalInstance captures {orgId, runBy} from the admin session when none is passed", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u_session_admin" },
      session: { activeOrganizationId: "org_session" },
    });
    const { saveDrupalInstance } = await import("@/lib/drupal-api");
    const saved = await saveDrupalInstance({
      name: "Tenant Session",
      siteUrl: "https://tenant-session.example",
      mcpApiKey: "drupal-bearer-key-123456",
      // no orgId/runBy passed — captured from session
    });
    expect(saved.orgId).toBe("org_session");
    expect(saved.runBy).toBe("u_session_admin");
  });

  it("saveDrupalInstance leaves no binding when there is no session and none is passed", async () => {
    const { saveDrupalInstance } = await import("@/lib/drupal-api");
    const saved = await saveDrupalInstance({
      name: "No Session",
      siteUrl: "https://no-session.example",
      mcpApiKey: "drupal-bearer-key-123456",
    });
    expect(saved.orgId).toBeUndefined();
    expect(saved.runBy).toBeUndefined();
  });

  it("saveDrupalInstance preserves the existing binding on edit-without-binding", async () => {
    const dbMod = (await import("@/lib/database")) as unknown as {
      __setBlob: (k: string, v: { instances: unknown[] }) => void;
      __getBlob: (k: string) => { instances: Array<{ orgId?: string; runBy?: string }> };
    };
    dbMod.__setBlob("drupal", {
      instances: [
        {
          id: "d-1",
          name: "Existing",
          siteUrl: "https://tenant-a.example",
          nangoConnectionId: "d-1",
          providerConfigKey: "drupal-config",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          orgId: "org_a",
          runBy: "u_a",
        },
      ],
    });
    const { saveDrupalInstance } = await import("@/lib/drupal-api");
    await saveDrupalInstance({
      id: "d-1",
      name: "Existing renamed",
      siteUrl: "https://tenant-a.example",
      // no key (edit-without-key), no binding, no session
    });
    const blob = dbMod.__getBlob("drupal");
    expect(blob.instances[0]?.orgId).toBe("org_a");
    expect(blob.instances[0]?.runBy).toBe("u_a");
  });
});

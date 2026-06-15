// Verifies saveDrupalInstance, deleteDrupalInstance, and settings filtering.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Stub @/lib/database with deterministic read/write to a local store.
// ---------------------------------------------------------------------------

let CONFIG_STORE: Record<string, unknown> = {};

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(<T>(key: string, fallback: T): T => {
    return (CONFIG_STORE[key] as T) ?? fallback;
  }),
  writeConnectorConfigToDatabase: vi.fn((key: string, value: unknown) => {
    CONFIG_STORE[key] = value;
  }),
}));

// ---------------------------------------------------------------------------
// Mock the @cinatra-ai/nango-connector surface.
// ---------------------------------------------------------------------------

vi.mock("@/lib/nango-system", () => ({
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: { drupal: "cinatra-drupal" },
  deleteNangoConnection: vi.fn(),
  ensureNangoConnectorIntegration: vi.fn(async () => null),
  getNangoCredentials: vi.fn(),
  importNangoConnection: vi.fn(async () => null),
  isNangoConfigured: vi.fn(),
  removeNangoConnectionRecord: vi.fn(async () => undefined),
  saveNangoConnectionRecord: vi.fn(async () => undefined),
}));

import {
  deleteNangoConnection,
  ensureNangoConnectorIntegration,
  getNangoCredentials,
  importNangoConnection,
  isNangoConfigured,
  removeNangoConnectionRecord,
  saveNangoConnectionRecord,
} from "@/lib/nango-system";

import {
  saveDrupalInstance,
  deleteDrupalInstance,
  getDrupalAPISettings,
  persistLocalDevDrupalInstanceUnvalidated,
} from "@/lib/drupal-api";

const KEY = "drush-generated-bearer-token-xyz123";

beforeEach(() => {
  CONFIG_STORE = {};
  vi.clearAllMocks();
  vi.mocked(isNangoConfigured).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saveDrupalInstance credential persistence", () => {
  it("happy path: new instance — ensure → import (no connectorKey) → readback → persist → saveNangoConnectionRecord (in that order)", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: KEY } as never);

    const result = await saveDrupalInstance({
      name: "Site A",
      siteUrl: "https://a.example.com",
      mcpApiKey: KEY,
    });

    expect(vi.mocked(isNangoConfigured)).toHaveBeenCalled();
    expect(vi.mocked(ensureNangoConnectorIntegration)).toHaveBeenCalledWith("drupal");
    // importNangoConnection is called without connectorKey.
    const importArgs = vi.mocked(importNangoConnection).mock.calls[0][0];
    expect(importArgs.connectorKey).toBeUndefined();
    expect(importArgs.providerConfigKey).toBe("cinatra-drupal");
    expect(importArgs.connectionId).toBe(result.id); // UUID == connectionId
    expect(importArgs.credentials).toEqual({ type: "API_KEY", apiKey: KEY });
    expect(importArgs.metadata).toEqual({ siteUrl: "https://a.example.com" });
    // Readback forceRefresh
    expect(vi.mocked(getNangoCredentials)).toHaveBeenCalledWith(
      "cinatra-drupal",
      result.id,
      { forceRefresh: true },
    );
    // saveNangoConnectionRecord runs after readback.
    // Must pass { multiple: true } as the third arg because
    // importNangoConnection is called without connectorKey, bypassing
    // schema-driven multiple inference.
    expect(vi.mocked(saveNangoConnectionRecord)).toHaveBeenCalledWith(
      "drupal",
      expect.objectContaining({
        connectionId: result.id,
        providerConfigKey: "cinatra-drupal",
        metadata: { siteUrl: "https://a.example.com" },
      }),
      { multiple: true },
    );
    // Row persisted without mcpApiKey, with the pointer fields.
    expect(result).toMatchObject({
      name: "Site A",
      siteUrl: "https://a.example.com",
      nangoConnectionId: result.id,
      providerConfigKey: "cinatra-drupal",
    });
    expect((result as Record<string, unknown>).mcpApiKey).toBeUndefined();
  });

  it("throws when Nango is unconfigured (no import / readback called)", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(false);

    await expect(
      saveDrupalInstance({ name: "Site A", siteUrl: "https://a.example.com", mcpApiKey: KEY }),
    ).rejects.toThrow(/Nango is not configured/);

    expect(vi.mocked(importNangoConnection)).not.toHaveBeenCalled();
    expect(vi.mocked(getNangoCredentials)).not.toHaveBeenCalled();
    expect(vi.mocked(saveNangoConnectionRecord)).not.toHaveBeenCalled();
  });

  it("readback mismatch throws generic error and does NOT call saveNangoConnectionRecord — and no plaintext / token in error", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "DIFFERENT_VALUE" } as never);

    try {
      await saveDrupalInstance({
        name: "Site A",
        siteUrl: "https://a.example.com",
        mcpApiKey: KEY,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/Nango credential verification failed/);
      expect(msg).not.toContain(KEY);
      expect(msg).not.toContain("DIFFERENT_VALUE");
    }

    expect(vi.mocked(saveNangoConnectionRecord)).not.toHaveBeenCalled();
  });

  it("readback returns null → treated as mismatch, no persist", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce(null);

    await expect(
      saveDrupalInstance({ name: "Site A", siteUrl: "https://a.example.com", mcpApiKey: KEY }),
    ).rejects.toThrow(/Nango credential verification failed/);

    expect(vi.mocked(saveNangoConnectionRecord)).not.toHaveBeenCalled();
  });

  it("edit-without-key preserves existing Nango credential — skips Nango entirely, rewrites name/URL only", async () => {
    // Pre-seed an instance.
    const existingId = "existing-uuid";
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: existingId,
          name: "Old name",
          siteUrl: "https://old.example.com",
          nangoConnectionId: existingId,
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };

    const result = await saveDrupalInstance({
      id: existingId,
      name: "New name",
      siteUrl: "https://new.example.com",
      // mcpApiKey omitted — edit-without-key
    });

    expect(result.id).toBe(existingId);
    expect(result.name).toBe("New name");
    expect(result.siteUrl).toBe("https://new.example.com");
    expect(result.nangoConnectionId).toBe(existingId);

    // No Nango calls — edit-without-key path
    expect(vi.mocked(ensureNangoConnectorIntegration)).not.toHaveBeenCalled();
    expect(vi.mocked(importNangoConnection)).not.toHaveBeenCalled();
    expect(vi.mocked(getNangoCredentials)).not.toHaveBeenCalled();
    expect(vi.mocked(saveNangoConnectionRecord)).not.toHaveBeenCalled();
  });

  it("edit-with-rotation goes through the full save dance", async () => {
    const existingId = "existing-uuid";
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: existingId,
          name: "Old name",
          siteUrl: "https://old.example.com",
          nangoConnectionId: existingId,
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "NEW_TOKEN_xyz" } as never);

    const result = await saveDrupalInstance({
      id: existingId,
      name: "Old name",
      siteUrl: "https://old.example.com",
      mcpApiKey: "NEW_TOKEN_xyz",
    });

    expect(result.id).toBe(existingId);
    expect(vi.mocked(importNangoConnection)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveNangoConnectionRecord)).toHaveBeenCalledTimes(1);
  });

  it("rejects new instance without a key (key required when adding)", async () => {
    await expect(
      saveDrupalInstance({ name: "Site A", siteUrl: "https://a.example.com" }),
    ).rejects.toThrow(/MCP API key is required/);
    // Nango not called at all.
    expect(vi.mocked(importNangoConnection)).not.toHaveBeenCalled();
  });

  it("rejects a short rotation key (min 8 chars)", async () => {
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: "x",
          name: "x",
          siteUrl: "https://x.example.com",
          nangoConnectionId: "x",
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    await expect(
      saveDrupalInstance({ id: "x", name: "x", siteUrl: "https://x.example.com", mcpApiKey: "short" }),
    ).rejects.toThrow(/at least 8 chars/);
  });
});

describe("deleteDrupalInstance cleanup symmetry", () => {
  it("removes the row + Nango pointer + best-effort Nango connection delete", async () => {
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: "site-1",
          name: "Site 1",
          siteUrl: "https://s.example.com",
          nangoConnectionId: "site-1",
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };

    await deleteDrupalInstance("site-1");

    expect((CONFIG_STORE.drupal as { instances: unknown[] }).instances).toEqual([]);
    expect(vi.mocked(removeNangoConnectionRecord)).toHaveBeenCalledWith("drupal", "site-1");
    expect(vi.mocked(deleteNangoConnection)).toHaveBeenCalledWith("cinatra-drupal", "site-1");
  });

  it("survives a Nango deleteConnection error (swallows + warns)", async () => {
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: "site-1",
          name: "Site 1",
          siteUrl: "https://s.example.com",
          nangoConnectionId: "site-1",
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    vi.mocked(deleteNangoConnection).mockRejectedValueOnce(new Error("nango down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(deleteDrupalInstance("site-1")).resolves.toBeUndefined();

    expect((CONFIG_STORE.drupal as { instances: unknown[] }).instances).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("skips Nango delete when isNangoConfigured() === false (still drops local row + pointer)", async () => {
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: "site-1",
          name: "Site 1",
          siteUrl: "https://s.example.com",
          nangoConnectionId: "site-1",
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    vi.mocked(isNangoConfigured).mockReturnValue(false);

    await deleteDrupalInstance("site-1");

    expect(vi.mocked(deleteNangoConnection)).not.toHaveBeenCalled();
    expect(vi.mocked(removeNangoConnectionRecord)).toHaveBeenCalled();
    expect((CONFIG_STORE.drupal as { instances: unknown[] }).instances).toEqual([]);
  });
});

describe("getDrupalAPISettings filter", () => {
  it("filters out rows that lack nangoConnectionId", () => {
    CONFIG_STORE.drupal = {
      instances: [
        // Row with Nango pointer — included
        {
          id: "migrated",
          name: "ok",
          siteUrl: "https://ok.example.com",
          nangoConnectionId: "migrated",
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        // Row without Nango pointer — filtered out
        {
          id: "legacy",
          name: "legacy",
          siteUrl: "https://legacy.example.com",
          mcpApiKey: "STILL_PLAINTEXT",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const result = getDrupalAPISettings();
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0].id).toBe("migrated");
  });
});

describe("persistLocalDevDrupalInstanceUnvalidated — localhost no-Nango first wire", () => {
  it("lands a COMPLETE row (nangoConnectionId=id, lastValidatedAt UNSET) WITHOUT any Nango side effect", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(false);

    const row = await persistLocalDevDrupalInstanceUnvalidated({
      name: "Local Drupal (dev auto)",
      siteUrl: "http://localhost:8082/",
    });

    // Complete row: id, name, siteUrl (trailing slash trimmed), nangoConnectionId=id.
    expect(row.id).toBeTruthy();
    expect(row.nangoConnectionId).toBe(row.id);
    expect(row.siteUrl).toBe("http://localhost:8082");
    expect(row.providerConfigKey).toBe("cinatra-drupal");
    // NOT validated — no false attribution.
    expect(row.lastValidatedAt).toBeUndefined();
    // Listed by getDrupalAPISettings (its filter requires a non-empty nangoConnectionId).
    expect(getDrupalAPISettings().instances.some((i) => i.id === row.id)).toBe(true);
    // NO Nango pointer / import was written (a pointer with no readback-verified
    // Bearer would dangle).
    expect(importNangoConnection).not.toHaveBeenCalled();
    expect(saveNangoConnectionRecord).not.toHaveBeenCalled();
    expect(ensureNangoConnectorIntegration).not.toHaveBeenCalled();
  });

  it("is idempotent — reuses the existing row id (by siteUrl) and does not duplicate", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(false);
    const first = await persistLocalDevDrupalInstanceUnvalidated({
      name: "Local Drupal (dev auto)",
      siteUrl: "http://localhost:8082",
    });
    const second = await persistLocalDevDrupalInstanceUnvalidated({
      name: "Local Drupal (dev auto)",
      siteUrl: "http://localhost:8082",
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt); // createdAt preserved
    expect(getDrupalAPISettings().instances.filter((i) => i.siteUrl === "http://localhost:8082")).toHaveLength(1);
  });

  it("accepts 127.0.0.1 and the [::1] IPv6 loopback form", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(false);
    await expect(
      persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://127.0.0.1:8082" }),
    ).resolves.toMatchObject({ siteUrl: "http://127.0.0.1:8082" });
    await expect(
      persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://[::1]:8082" }),
    ).resolves.toBeTruthy();
  });

  it("REFUSES a non-local site URL (hard localhost gate; never a production affordance)", async () => {
    await expect(
      persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "https://drupal.example.com" }),
    ).rejects.toThrow(/local-dev only/);
    // Nothing persisted.
    expect(getDrupalAPISettings().instances).toHaveLength(0);
  });

  it("REFUSES a missing instance name", async () => {
    await expect(
      persistLocalDevDrupalInstanceUnvalidated({ name: "  ", siteUrl: "http://localhost:8082" }),
    ).rejects.toThrow(/name is required/i);
  });
});

// Regression pins: the GLOBAL, actor-less
// YouTube mint must read ONLY an app-scoped Nango connection and fail CLOSED
// (no token) when none exists — a per-user saved credential must never leak
// into the global media-feeds runtime, and the legacy default provider/
// connection ids must NOT be minted as a fallback.

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  getConfiguredYouTubeAccessToken,
  getYouTubeAPIStatus,
  clearYouTubeAPISettings,
} from "@/lib/youtube-api";
import { NANGO_SYSTEM_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";

type SavedRecord = {
  connectorKey: string;
  providerConfigKey: string;
  connectionId: string;
  scope?: "app" | "user";
  userId?: string;
  displayName?: string;
};

function buildSurface(records: SavedRecord[]) {
  const calls: Array<{ providerConfigKey: string; connectionId: string }> = [];
  const clearCalls: Array<{ connectorKey: string; options?: { scope?: "app" | "user"; userId?: string } }> = [];
  const deleteCalls: Array<{ providerConfigKey: string; connectionId: string }> = [];
  const impl = {
    isNangoConfigured: () => true,
    getNangoStatus: () => ({ status: "connected" as const, detail: "live" }),
    getNangoSettings: () => ({ secretKey: "sk" }),
    providerConfigKeys: { youtube: "cinatra-youtube" },
    // Honor the scope filter the way the real nango-connector does: with no
    // scope option, ALL records are visible (the pre-fix leak); with
    // { scope: "app" }, only app-scoped records are returned.
    listSavedNangoConnections: (connectorKey: string, options?: { scope?: "app" | "user"; userId?: string }) => {
      let pool = records.filter((r) => r.connectorKey === connectorKey);
      if (options?.scope) {
        pool = pool.filter((r) => (r.scope ?? "app") === options.scope);
        if (options.userId) pool = pool.filter((r) => r.userId === options.userId);
      }
      return pool;
    },
    getPrimarySavedNangoConnection: (connectorKey: string, options?: { scope?: "app" | "user"; userId?: string }) => {
      return impl.listSavedNangoConnections(connectorKey, options)[0] ?? null;
    },
    getNangoConnection: async (providerConfigKey: string, connectionId: string) => {
      calls.push({ providerConfigKey, connectionId });
      return { credentials: { type: "OAUTH2", access_token: `token-for-${connectionId}` } };
    },
    deleteNangoConnection: async (providerConfigKey: string, connectionId: string) => {
      deleteCalls.push({ providerConfigKey, connectionId });
    },
    clearNangoConnectionRecords: async (connectorKey: string, options?: { scope?: "app" | "user"; userId?: string }) => {
      clearCalls.push({ connectorKey, options });
    },
  };
  return { impl, calls, clearCalls, deleteCalls };
}

function register(impl: unknown) {
  registerCapabilityProvider(NANGO_SYSTEM_CAPABILITY, {
    packageName: "@cinatra-ai/nango-connector",
    impl,
  });
}

beforeEach(() => {
  __resetCapabilityRegistry();
});

describe("getConfiguredYouTubeAccessToken — global actor-less mint (#272)", () => {
  it("does NOT return a user-scoped token to the global reader (fails closed)", async () => {
    const { impl, calls } = buildSurface([
      {
        connectorKey: "youtube",
        providerConfigKey: "cinatra-youtube",
        connectionId: "user-alice",
        scope: "user",
        userId: "alice",
      },
    ]);
    register(impl);

    await expect(getConfiguredYouTubeAccessToken()).resolves.toBeNull();
    // Critically: no mint attempt at all — no fallback to default ids.
    expect(calls).toHaveLength(0);
  });

  it("uses an app-scoped saved connection", async () => {
    const { impl, calls } = buildSurface([
      {
        connectorKey: "youtube",
        providerConfigKey: "cinatra-youtube-app",
        connectionId: "app-conn",
        scope: "app",
      },
    ]);
    register(impl);

    await expect(getConfiguredYouTubeAccessToken()).resolves.toBe("token-for-app-conn");
    expect(calls).toEqual([{ providerConfigKey: "cinatra-youtube-app", connectionId: "app-conn" }]);
  });

  it("prefers the app-scoped record even when a user-scoped one is also present", async () => {
    const { impl, calls } = buildSurface([
      {
        connectorKey: "youtube",
        providerConfigKey: "cinatra-youtube",
        connectionId: "user-alice",
        scope: "user",
        userId: "alice",
      },
      {
        connectorKey: "youtube",
        providerConfigKey: "cinatra-youtube-app",
        connectionId: "app-conn",
        scope: "app",
      },
    ]);
    register(impl);

    await expect(getConfiguredYouTubeAccessToken()).resolves.toBe("token-for-app-conn");
    expect(calls).toEqual([{ providerConfigKey: "cinatra-youtube-app", connectionId: "app-conn" }]);
  });

  it("returns null (no fallback default mint) when no saved connection exists", async () => {
    const { impl, calls } = buildSurface([]);
    register(impl);

    await expect(getConfiguredYouTubeAccessToken()).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("getYouTubeAPIStatus — app-scoped view (#272)", () => {
  it("reports not_connected when only a user-scoped record exists", () => {
    const { impl } = buildSurface([
      {
        connectorKey: "youtube",
        providerConfigKey: "cinatra-youtube",
        connectionId: "user-alice",
        scope: "user",
        userId: "alice",
      },
    ]);
    register(impl);

    expect(getYouTubeAPIStatus().status).toBe("not_connected");
  });

  it("reports connected for an app-scoped record", () => {
    const { impl } = buildSurface([
      {
        connectorKey: "youtube",
        providerConfigKey: "cinatra-youtube-app",
        connectionId: "app-conn",
        scope: "app",
        displayName: "Brand Channel",
      },
    ]);
    register(impl);

    const status = getYouTubeAPIStatus();
    expect(status.status).toBe("connected");
    expect(status.detail).toContain("Brand Channel");
  });
});

describe("clearYouTubeAPISettings — app-scoped clear (#272)", () => {
  it("clears records ONLY in the app scope (does not wipe user-scoped pointers)", async () => {
    const { impl, clearCalls } = buildSurface([
      {
        connectorKey: "youtube",
        providerConfigKey: "cinatra-youtube-app",
        connectionId: "app-conn",
        scope: "app",
      },
    ]);
    register(impl);

    await clearYouTubeAPISettings();

    expect(clearCalls).toHaveLength(1);
    expect(clearCalls[0].connectorKey).toBe("youtube");
    expect(clearCalls[0].options).toEqual({ scope: "app" });
  });

  it("deletes only the app-scoped primary connection (a user-scoped record is invisible)", async () => {
    const { impl, deleteCalls } = buildSurface([
      {
        connectorKey: "youtube",
        providerConfigKey: "cinatra-youtube",
        connectionId: "user-alice",
        scope: "user",
        userId: "alice",
      },
    ]);
    register(impl);

    await clearYouTubeAPISettings();

    // No app-scoped connection → nothing deleted; the user record is untouched.
    expect(deleteCalls).toHaveLength(0);
  });
});

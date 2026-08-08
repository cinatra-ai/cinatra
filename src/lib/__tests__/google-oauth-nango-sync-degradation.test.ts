// cinatra#2545 — the Google OAuth save must not be hostage to the connection
// service.
//
// THE DEFECT: `saveGoogleOAuthSettings` called `ensureNangoIntegration` BEFORE
// `writeStoredGoogleOAuthSettings`, so a Nango 401 (a secret key nango-server
// does not accept) threw before the DB write and DISCARDED the client id and
// secret the operator had just typed. The surfaced error was the bare axios
// string "Request failed with status code 401", which named neither the cause
// nor any recourse.
//
// THE CONTRACT PINNED HERE:
//   1. the local values persist FIRST — a failing Nango can never lose them;
//   2. a failed mirror is recorded as a CLASSIFIED code (never provider text);
//   3. `getGoogleOAuthStatus` reports the honest degraded state with copy that
//      names the cause and the recourse;
//   4. a stale marker self-heals once Nango actually holds the client;
//   5. a successful save clears the marker.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { configRows } = vi.hoisted(() => ({ configRows: new Map<string, unknown>() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: (id: string, fallback: unknown) =>
    configRows.has(id) ? configRows.get(id) : fallback,
  writeConnectorConfigToDatabase: (id: string, value: unknown) => {
    configRows.set(id, value);
  },
  deleteConnectorConfig: (id: string) => {
    configRows.delete(id);
  },
}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { NANGO_SYSTEM_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import {
  classifyNangoSyncFailure,
  describeNangoSyncFailure,
  getGoogleOAuthSettings,
  getGoogleOAuthStatus,
  saveGoogleOAuthSettings,
  type GoogleOAuthStoredSettings,
} from "@cinatra-ai/google-oauth-connection";

/** An axios-shaped rejection: the exact shape the Nango SDK throws. */
function axiosError(status: number): Error {
  const err = new Error(`Request failed with status code ${status}`);
  (err as Error & { response?: { status: number } }).response = { status };
  return err;
}

/** A socket-level failure: the Nango server was never reached. */
function socketError(code: string): Error {
  const err = new Error("connect ECONNREFUSED 127.0.0.1:3003");
  (err as Error & { code?: string }).code = code;
  return err;
}

type NangoStubOptions = {
  /** Thrown by `ensureNangoIntegration` — the mirror leg of the save. */
  ensureRejectsWith?: unknown;
  /** `ensureNangoIntegration`'s resolved value (`null` = Nango unconfigured). */
  ensureResolvesWith?: unknown;
  /**
   * What Nango reports it holds for the Google integration. `"mirror"` makes
   * the stub behave like a healthy Nango: whatever the save mirrors is what a
   * later read returns.
   */
  integrationCredentials?: { clientId?: string; clientSecret?: string } | null | "mirror";
  /** A pre-existing connected Google account. */
  savedConnection?: { email: string; displayName?: string } | null;
  /** Full control over the mirror leg (concurrency tests). */
  ensureImpl?: (input: {
    credentials?: { client_id?: string; client_secret?: string };
  }) => Promise<unknown>;
};

function installNangoStub(options: NangoStubOptions = {}) {
  const ensureCalls: { credentials?: { client_id?: string; client_secret?: string } }[] = [];
  let mirrored: { clientId?: string; clientSecret?: string } | null = null;
  registerCapabilityProvider(NANGO_SYSTEM_CAPABILITY, {
    packageName: "@cinatra-ai/nango-connector",
    impl: {
      isNangoConfigured: () => true,
      getNangoStatus: () => ({ status: "connected", detail: "" }),
      getNangoSettings: () => ({ secretKey: "not-a-real-key" }),
      providerConfigKeys: { googleOAuth: "cinatra-google-oauth" },
      getNangoOAuthCallbackUrl: () => "https://api.nango.dev/oauth/callback",
      getNangoOAuth2IntegrationCredentials: async () =>
        options.integrationCredentials === "mirror"
          ? mirrored
          : (options.integrationCredentials ?? null),
      getPrimarySavedNangoConnection: () => options.savedConnection ?? null,
      ensureNangoIntegration: async (input: {
        credentials?: { client_id?: string; client_secret?: string };
      }) => {
        ensureCalls.push(input);
        if (options.ensureImpl) return options.ensureImpl(input);
        if (options.ensureRejectsWith !== undefined) throw options.ensureRejectsWith;
        mirrored = {
          clientId: input.credentials?.client_id,
          clientSecret: input.credentials?.client_secret,
        };
        return "ensureResolvesWith" in options ? options.ensureResolvesWith : "cinatra-google-oauth";
      },
    },
  });
  return { ensureCalls };
}

/** A healthy Nango: it stores what the save mirrors and reads it back. */
function installHealthyNango(options: NangoStubOptions = {}) {
  return installNangoStub({ integrationCredentials: "mirror", ...options });
}

function storedRow(): GoogleOAuthStoredSettings {
  return (configRows.get("google_oauth") ?? {}) as GoogleOAuthStoredSettings;
}

/** The sync marker lives in its OWN row so the failure path never touches credentials. */
function syncMarker(): { status?: string; code?: string } | null {
  return (configRows.get("google_oauth_nango_sync") ?? null) as { status?: string; code?: string } | null;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetCapabilityRegistry();
  configRows.clear();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("classifyNangoSyncFailure", () => {
  it("reads a rejected secret key off a 401 and a 403", () => {
    expect(classifyNangoSyncFailure(axiosError(401))).toBe("secret-key-rejected");
    expect(classifyNangoSyncFailure(axiosError(403))).toBe("secret-key-rejected");
  });

  it("separates an unreachable server from a rejected request and a server error", () => {
    expect(classifyNangoSyncFailure(socketError("ECONNREFUSED"))).toBe("unreachable");
    expect(classifyNangoSyncFailure(axiosError(400))).toBe("request-rejected");
    expect(classifyNangoSyncFailure(axiosError(503))).toBe("service-unavailable");
  });

  it("falls back to `unknown` rather than mis-attributing an unrecognized error", () => {
    expect(classifyNangoSyncFailure(new Error("something else entirely"))).toBe("unknown");
    expect(classifyNangoSyncFailure(undefined)).toBe("unknown");
  });

  it("names the secret key AND the recourse in the operator copy for a 401", () => {
    const copy = describeNangoSyncFailure("secret-key-rejected");
    expect(copy).toContain("NANGO_SECRET_KEY");
    expect(copy).toContain("UUID v4");
    // The reassurance is the whole point of the ordering fix: nothing was lost.
    expect(copy).toContain("saved on this instance");
  });
});

describe("saveGoogleOAuthSettings ordering (the cinatra#2545 data-loss defect)", () => {
  it("persists the client id and secret even when the Nango mirror 401s", async () => {
    installNangoStub({ ensureRejectsWith: axiosError(401) });

    // Pre-fix this call THREW and wrote nothing at all.
    await expect(
      saveGoogleOAuthSettings({ clientId: "typed-id", clientSecret: "typed-secret" }),
    ).resolves.toMatchObject({ clientId: "typed-id", clientSecret: "typed-secret" });

    const row = storedRow();
    expect(row.clientId).toBe("typed-id");
    expect(row.clientSecret).toBe("typed-secret");
  });

  it("records the classified cause — and never provider-echoed text — on the row", async () => {
    installNangoStub({ ensureRejectsWith: axiosError(401) });
    await saveGoogleOAuthSettings({ clientId: "typed-id", clientSecret: "typed-secret" });

    expect(syncMarker()).toMatchObject({ status: "failed", code: "secret-key-rejected" });
    // The raw axios string must not be durable anywhere.
    expect(JSON.stringify([storedRow(), syncMarker()])).not.toContain("Request failed with status code");
    // The credential row itself is never touched by the failure path.
    expect(storedRow()).not.toHaveProperty("nangoSync");
  });

  it("still attempts the mirror, and clears the marker once it succeeds", async () => {
    installNangoStub({ ensureRejectsWith: axiosError(401) });
    await saveGoogleOAuthSettings({ clientId: "typed-id", clientSecret: "typed-secret" });
    expect(syncMarker()).not.toBeNull();

    __resetCapabilityRegistry();
    const { ensureCalls } = installHealthyNango();
    await saveGoogleOAuthSettings({ clientId: "typed-id", clientSecret: "typed-secret" });

    expect(ensureCalls).toHaveLength(1);
    expect(syncMarker()).toBeNull();
    expect(storedRow().clientId).toBe("typed-id");
  });

  it("never logs provider-echoed text — only the classified code and the status", async () => {
    // The nango gateway rewraps upstream rejections as a plain Error carrying
    // text lifted from the provider's HTTP response body. That text is
    // untrusted and must never reach the log.
    installNangoStub({ ensureRejectsWith: new Error("secret key sk-live-abc123 was rejected") });
    await saveGoogleOAuthSettings({ clientId: "typed-id", clientSecret: "typed-secret" });

    const logged = warnSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("code=unknown");
    expect(logged).not.toContain("sk-live-abc123");
    expect(logged).not.toContain("was rejected");
  });

  it("never resurrects older credentials when a concurrent save already won", async () => {
    // Double-submit: save A stalls in the mirror, save B lands completely, then
    // A fails. A's failure path must not put its own stale credentials back —
    // that would recreate the data-loss class. The marker living in its own row
    // is what makes this structurally impossible; this test guards that
    // property, so a future refactor cannot quietly fold it back in.
    let releaseA: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let call = 0;
    installNangoStub({
      integrationCredentials: null,
      ensureImpl: async () => {
        call += 1;
        if (call === 1) {
          await stalled;
          throw axiosError(401);
        }
        return "cinatra-google-oauth";
      },
    });

    const saveA = saveGoogleOAuthSettings({ clientId: "id-A", clientSecret: "secret-A" });
    await saveGoogleOAuthSettings({ clientId: "id-B", clientSecret: "secret-B" });
    expect(storedRow().clientId).toBe("id-B");

    releaseA();
    await saveA;

    expect(storedRow().clientId).toBe("id-B");
    expect(storedRow().clientSecret).toBe("secret-B");
  });
});

describe("overlapping saves cannot finalize each other's mirror outcome", () => {
  it("an older save's late SUCCESS does not clear a newer save's failure marker", async () => {
    // The inverse of the ordering above, and the nastier one: if save A's late
    // success cleared save B's marker, the instance would hold B's credentials,
    // Nango would hold A's, and NOTHING would record the divergence — so the
    // status would read connected and a later blank-secret save would quietly
    // restore A over B.
    let releaseA: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let call = 0;
    installNangoStub({
      integrationCredentials: { clientId: "id-A", clientSecret: "secret-A" },
      ensureImpl: async () => {
        call += 1;
        if (call === 1) {
          await stalled;
          return "cinatra-google-oauth"; // A mirrors successfully, but LATE.
        }
        throw axiosError(401); // B fails.
      },
    });

    const saveA = saveGoogleOAuthSettings({ clientId: "id-A", clientSecret: "secret-A" });
    await saveGoogleOAuthSettings({ clientId: "id-B", clientSecret: "secret-B" });
    expect(syncMarker()?.code).toBe("secret-key-rejected");

    releaseA();
    await saveA;

    // A no longer owns the credential row, so it must not speak for it.
    expect(syncMarker()?.code).toBe("secret-key-rejected");
    expect((await getGoogleOAuthStatus()).status).toBe("incomplete");
    // And the degraded read still shows B — Nango's stale copy of A must not win.
    expect((await getGoogleOAuthSettings()).clientId).toBe("id-B");
  });
});

describe("retrying after a failed mirror (the recourse copy says 'save again')", () => {
  it("keeps the rotation when the operator re-saves with the secret left blank", async () => {
    // The trap Codex round 2 caught: the merge base and the re-rendered form
    // both read Nango-FIRST, and Nango still holds the PREVIOUS client after a
    // failed mirror. So following our own "save again" advice — with the
    // write-only secret field blank, exactly as the panel renders it — would
    // have re-merged the PREVIOUS secret and silently undone the rotation.
    installNangoStub({
      ensureRejectsWith: axiosError(401),
      integrationCredentials: { clientId: "previous-id", clientSecret: "previous-secret" },
    });
    await saveGoogleOAuthSettings({ clientId: "rotated-id", clientSecret: "rotated-secret" });
    expect(storedRow()).toMatchObject({ clientId: "rotated-id", clientSecret: "rotated-secret" });

    // The values the form would render on the degraded re-render.
    const shown = await getGoogleOAuthSettings();
    expect(shown.clientId).toBe("rotated-id");

    // The retry: client id as rendered, secret left blank ("leave blank to keep").
    await saveGoogleOAuthSettings({ clientId: shown.clientId, clientSecret: undefined });

    expect(storedRow().clientId).toBe("rotated-id");
    expect(storedRow().clientSecret).toBe("rotated-secret");
  });

  it("clears the marker and reports connected once the retry mirrors cleanly", async () => {
    installNangoStub({
      ensureRejectsWith: axiosError(401),
      integrationCredentials: { clientId: "previous-id", clientSecret: "previous-secret" },
    });
    await saveGoogleOAuthSettings({ clientId: "rotated-id", clientSecret: "rotated-secret" });

    __resetCapabilityRegistry();
    installHealthyNango();
    await saveGoogleOAuthSettings({ clientId: undefined, clientSecret: undefined });

    expect(syncMarker()).toBeNull();
    expect(storedRow().clientId).toBe("rotated-id");
    expect((await getGoogleOAuthStatus()).status).toBe("connected");
  });
});

describe("what counts as a completed mirror (the gateway swallows rejections)", () => {
  it("flags `service-not-configured` when the gateway makes no call at all", async () => {
    // `ensureNangoIntegration` returns null WITHOUT calling Nango when the
    // instance has no connection service configured — the fresh-install case.
    installNangoStub({ ensureResolvesWith: null });
    await saveGoogleOAuthSettings({ clientId: "typed-id", clientSecret: "typed-secret" });

    expect(syncMarker()?.code).toBe("service-not-configured");
    expect((await getGoogleOAuthStatus()).detail).toContain("NANGO_SECRET_KEY");
  });

  it("flags `mirror-not-confirmed` when the gateway resolves but Nango holds nothing", async () => {
    // The gateway swallows "unique key already exists" / "invalid input" as
    // success, and skips its delete+recreate fallback when saved connections
    // exist. A resolved call is therefore not proof the mirror landed.
    installNangoStub({ integrationCredentials: null });
    await saveGoogleOAuthSettings({ clientId: "typed-id", clientSecret: "typed-secret" });

    expect(syncMarker()?.code).toBe("mirror-not-confirmed");
    expect((await getGoogleOAuthStatus()).status).toBe("incomplete");
  });
});

describe("getGoogleOAuthStatus degraded reporting", () => {
  it("reports `incomplete` with the cause and the recourse after a failed mirror", async () => {
    installNangoStub({ ensureRejectsWith: axiosError(401) });
    await saveGoogleOAuthSettings({ clientId: "typed-id", clientSecret: "typed-secret" });

    const status = await getGoogleOAuthStatus();
    expect(status.status).toBe("incomplete");
    expect(status.detail).toContain("NANGO_SECRET_KEY");
  });

  it("self-heals to `connected` once Nango actually holds the client", async () => {
    installNangoStub({ ensureRejectsWith: axiosError(401) });
    await saveGoogleOAuthSettings({ clientId: "typed-id", clientSecret: "typed-secret" });

    // Same durable marker, but Nango now reports the integration.
    __resetCapabilityRegistry();
    installNangoStub({
      integrationCredentials: { clientId: "typed-id", clientSecret: "typed-secret" },
    });

    const status = await getGoogleOAuthStatus();
    expect(status.status).toBe("connected");
    // A pure read: the stale marker is ignored, not rewritten.
    expect(syncMarker()).not.toBeNull();
  });

  it("keeps reporting degraded when a client ROTATION failed to mirror", async () => {
    // The regression Codex caught: `settings.clientId` is Nango-FIRST, so
    // comparing it against the Nango credentials compares Nango to itself and
    // always agrees. Nango still holds the PREVIOUS client here, so the saved
    // client is genuinely not in effect and the status must say so.
    installNangoStub({
      ensureRejectsWith: axiosError(401),
      integrationCredentials: { clientId: "previous-id", clientSecret: "previous-secret" },
    });
    await saveGoogleOAuthSettings({ clientId: "rotated-id", clientSecret: "rotated-secret" });

    expect(storedRow().clientId).toBe("rotated-id");
    expect((await getGoogleOAuthStatus()).status).toBe("incomplete");
  });

  it("keeps reporting degraded when only the SECRET was rotated", async () => {
    installNangoStub({
      ensureRejectsWith: axiosError(401),
      integrationCredentials: { clientId: "same-id", clientSecret: "previous-secret" },
    });
    await saveGoogleOAuthSettings({ clientId: "same-id", clientSecret: "rotated-secret" });

    expect((await getGoogleOAuthStatus()).status).toBe("incomplete");
  });

  it("does not hide a failed rotation behind an existing connected account", async () => {
    // An install that already has a connected Google account is the case most
    // likely to hit this path; the saved-connection arm must not short-circuit
    // the degraded report.
    installNangoStub({
      ensureRejectsWith: axiosError(401),
      integrationCredentials: { clientId: "previous-id", clientSecret: "previous-secret" },
      savedConnection: { email: "ops@example.com", displayName: "Ops" },
    });
    await saveGoogleOAuthSettings({ clientId: "rotated-id", clientSecret: "rotated-secret" });

    const status = await getGoogleOAuthStatus();
    expect(status.status).toBe("incomplete");
    // The connected account is still reported — it keeps working.
    expect(status.accountEmail).toBe("ops@example.com");
    expect(status.detail).toContain("not in effect yet");
  });

  it("reports `connected` for a clean save (no regression on the happy path)", async () => {
    installHealthyNango();
    await saveGoogleOAuthSettings({ clientId: "typed-id", clientSecret: "typed-secret" });

    const status = await getGoogleOAuthStatus();
    expect(status.status).toBe("connected");
    expect(status.detail).toBe("Google OAuth is configured for Cinatra.");
  });

  it("still reports a connected account normally when nothing failed", async () => {
    installHealthyNango({ savedConnection: { email: "ops@example.com", displayName: "Ops" } });
    await saveGoogleOAuthSettings({ clientId: "typed-id", clientSecret: "typed-secret" });

    const status = await getGoogleOAuthStatus();
    expect(status.status).toBe("connected");
    expect(status.accountEmail).toBe("ops@example.com");
  });
});

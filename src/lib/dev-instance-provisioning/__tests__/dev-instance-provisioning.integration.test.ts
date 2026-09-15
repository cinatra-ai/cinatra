/**
 * THE DEVELOPMENT INSTANCE-PROVISIONING COMMAND, AGAINST A REAL DATABASE.
 *
 * Every claim this command makes is a claim about ROWS: that the wrapper writes
 * the same row the screen's own writer writes, that a second run writes nothing
 * more, that a refusal happens BEFORE a write rather than after it, and that the
 * setup step's own derivation reads ready afterwards. A stubbed store would
 * agree with whatever this code said about all four, so there is no store double
 * here — a real Postgres, the real writers, the real sealing codec, the real
 * claim/commit machine and the real readiness saga.
 *
 * WHAT IS DOUBLED, AND ONLY THIS: the calls that leave the machine. The provider
 * connector's credential save and its live catalog reads are the connector's
 * network, not this command's writes; they are injected. The keyed credential
 * fingerprint is still computed by the REAL
 * `readLiveCredentialFingerprint` over a surface double, so the digest, the
 * commitment and the match that `deriveSetupAiStepState` performs are all
 * genuine.
 *
 *   SUPABASE_DB_URL='<a scratch-database connection string>' pnpm test:dev-instance-provisioning
 */
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const IN_DEDICATED_LANE = process.env.CINATRA_DEV_PROVISIONING_REALDB === "1";

if (IN_DEDICATED_LANE && !HAS_DB) {
  throw new Error(
    "the development instance-provisioning lane needs a live Postgres: set SUPABASE_DB_URL " +
      "to a real connection string. Refusing to skip — a skipped proof that a wrapper " +
      "writes the screen's own row proves nothing.",
  );
}
const describeDb = HAS_DB ? describe : describe.skip;

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_x3135";
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;

// Synthetic values. Not credentials, and never treated as any.
const SYNTHETIC_CONNECTOR_SECRET = "synthetic-connector-service-secret-3135";
const SYNTHETIC_PROVIDER_KEY = "synthetic-anthropic-provider-key-3135";
const CONNECTOR_SERVICE_URL = "http://127.0.0.1:3003";
const PUBLIC_ORIGIN = "https://provisioning-proof.example";
const NAMESPACE = "provisioning-proof-3135";
const DISPLAY_NAME = "Provisioning Proof";

let admin: Client;

/** Every metadata row, as stored. The instrument for "no additional writes". */
async function snapshotMetadata(): Promise<Record<string, string>> {
  const { rows } = await admin.query<{ key: string; value: string }>(
    `SELECT key, value FROM ${q(SCHEMA)}.${q("metadata")} ORDER BY key`,
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function deleteMetadata(key: string): Promise<void> {
  await admin.query(`DELETE FROM ${q(SCHEMA)}.${q("metadata")} WHERE key = $1`, [key]);
}

async function truncateMetadata(): Promise<void> {
  await admin.query(`DELETE FROM ${q(SCHEMA)}.${q("metadata")}`);
}

describeDb("development instance provisioning", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    // Force the schema into existence through the app's own initialiser.
    const { ensurePostgresSchema } = await import("@/lib/postgres-schema-init");
    ensurePostgresSchema();
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
  });

  beforeEach(async () => {
    delete process.env.CINATRA_RUNTIME_MODE;
    delete process.env.APP_RUNTIME_MODE;
    await truncateMetadata();
    await resetInProcessCaches();
  });

  afterEach(() => {
    delete process.env.CINATRA_RUNTIME_MODE;
    delete process.env.APP_RUNTIME_MODE;
  });

  // -------------------------------------------------------------------------
  // 1. The wrappers write the screens' own rows.
  // -------------------------------------------------------------------------

  it("the namespace wrapper writes the row the Name screen's own persistence path writes", async () => {
    const { provisionInstanceNamespace } = await import(
      "@/lib/dev-instance-provisioning/provision-namespace"
    );
    const { persistDeferredInstanceIdentity } = await import(
      "@/lib/instance-identity-deferred-write"
    );
    const { readInstanceIdentity, decryptInstanceAttachSecret } = await import(
      "@/lib/instance-identity-store"
    );

    await provisionInstanceNamespace(
      { instanceNamespace: NAMESPACE, instanceDisplayName: DISPLAY_NAME },
      { attachMarketplaceConsumer: async () => {} },
    );
    const throughWrapper = readInstanceIdentity();

    await deleteMetadata("instance_identity");
    await resetInProcessCaches();

    const { resolveRegistryUrl } = await import("@/app/setup/name/registry-url");
    await persistDeferredInstanceIdentity(
      {
        instanceNamespace: NAMESPACE,
        instanceDisplayName: DISPLAY_NAME,
        registryUrl: resolveRegistryUrl(),
      },
      { attachMarketplaceConsumer: async () => {} },
    );
    const throughScreenWriter = readInstanceIdentity();

    expect(throughWrapper).not.toBeNull();
    expect(throughScreenWriter).not.toBeNull();

    // EXCLUDED BY NAME — each of these is randomised or clocked on every write,
    // so equality of the two rows is a claim about everything else.
    const RANDOMISED_BY_CONSTRUCTION = [
      "instanceId",
      "instanceAttachSecretCiphertext",
      "instanceAttachSecretIv",
      "createdAt",
    ] as const;

    expect(omit(throughWrapper, RANDOMISED_BY_CONSTRUCTION)).toEqual(
      omit(throughScreenWriter, RANDOMISED_BY_CONSTRUCTION),
    );
    // And every excluded field is genuinely present in both, decrypting through
    // the same codec — the exclusion is "differs by construction", not "absent".
    for (const field of RANDOMISED_BY_CONSTRUCTION) {
      expect(String((throughWrapper as Record<string, unknown>)[field] ?? "")).not.toEqual("");
      expect(String((throughScreenWriter as Record<string, unknown>)[field] ?? "")).not.toEqual("");
    }
    expect(decryptInstanceAttachSecret(throughWrapper!).length).toBeGreaterThan(0);
    expect(decryptInstanceAttachSecret(throughScreenWriter!).length).toBeGreaterThan(0);
  }, 120_000);

  it("the connector-service-secret wrapper writes the row the Secrets screen's own writer writes", async () => {
    const { provisionConnectorServiceSecret, CONNECTOR_SERVICE_CONFIG_ID } = await import(
      "@/lib/dev-instance-provisioning/provision-connector-service-secret"
    );
    const {
      readConnectorConfigFromDatabase,
      writeConnectorConfigToDatabase,
      deleteConnectorConfig,
    } = await import("@/lib/database");

    provisionConnectorServiceSecret({
      secretKey: SYNTHETIC_CONNECTOR_SECRET,
      serverUrl: CONNECTOR_SERVICE_URL,
    });
    const wrapperRaw = await readRawMetadata(`connector_config:${CONNECTOR_SERVICE_CONFIG_ID}`);
    const wrapperUnsealed = readConnectorConfigFromDatabase<Record<string, unknown>>(
      CONNECTOR_SERVICE_CONFIG_ID,
      {},
    );

    deleteConnectorConfig(CONNECTOR_SERVICE_CONFIG_ID);
    await deleteMetadata(`connector_config:${CONNECTOR_SERVICE_CONFIG_ID}`);

    // The Secrets screen's writer, reached through the connector's own
    // `saveNangoSettings` with the config store bound exactly as
    // `registerHostConnectorServices` binds it.
    const { saveNangoSettings } = await import(
      "../../../../extensions/cinatra-ai/nango-connector/src/nango"
    );
    const { setNangoConfigStore, _resetNangoConfigStoreForTests } = await import(
      "../../../../extensions/cinatra-ai/nango-connector/src/config-store"
    );
    setNangoConfigStore({
      read: readConnectorConfigFromDatabase,
      write: writeConnectorConfigToDatabase,
      delete: deleteConnectorConfig,
    });
    try {
      await saveNangoSettings({
        secretKey: SYNTHETIC_CONNECTOR_SECRET,
        serverUrl: CONNECTOR_SERVICE_URL,
      });
    } finally {
      _resetNangoConfigStoreForTests();
    }
    const screenRaw = await readRawMetadata(`connector_config:${CONNECTOR_SERVICE_CONFIG_ID}`);
    const screenUnsealed = readConnectorConfigFromDatabase<Record<string, unknown>>(
      CONNECTOR_SERVICE_CONFIG_ID,
      {},
    );

    // Both are SEALED at rest, and neither row holds the plaintext.
    for (const raw of [wrapperRaw, screenRaw]) {
      expect(raw).not.toBeNull();
      expect(raw).not.toContain(SYNTHETIC_CONNECTOR_SECRET);
      expect(JSON.parse(raw!).secretKey.__enc).toBe(1);
    }
    // The ciphertext and the IV differ by construction (a fresh AES-GCM IV per
    // write) — excluded by name; every decrypted field is equal.
    expect(JSON.parse(wrapperRaw!).secretKey.iv).not.toEqual(JSON.parse(screenRaw!).secretKey.iv);
    expect(wrapperUnsealed).toEqual(screenUnsealed);
    expect(wrapperUnsealed.secretKey).toBe(SYNTHETIC_CONNECTOR_SECRET);
    expect(wrapperUnsealed.serverUrl).toBe(CONNECTOR_SERVICE_URL);
  }, 120_000);

  // -------------------------------------------------------------------------
  // 2. The refusal outside a development runtime, with ZERO writes.
  // -------------------------------------------------------------------------

  it("every wrapper, and the composed command, refuses in production before writing anything", async () => {
    const { DevelopmentRuntimeRefusedError } = await import(
      "@/lib/dev-instance-provisioning/runtime-gate"
    );
    const { provisionInstanceNamespace } = await import(
      "@/lib/dev-instance-provisioning/provision-namespace"
    );
    const { provisionConnectorServiceSecret } = await import(
      "@/lib/dev-instance-provisioning/provision-connector-service-secret"
    );
    const { provisionPublicOrigin } = await import(
      "@/lib/dev-instance-provisioning/provision-public-origin"
    );
    const { provisionProviderConnection } = await import(
      "@/lib/dev-instance-provisioning/provision-provider-connection"
    );
    const { provisionDevInstance } = await import(
      "@/lib/dev-instance-provisioning/provision-instance"
    );

    const before = await snapshotMetadata();
    process.env.CINATRA_RUNTIME_MODE = "production";

    await expect(
      provisionInstanceNamespace({
        instanceNamespace: NAMESPACE,
        instanceDisplayName: DISPLAY_NAME,
      }),
    ).rejects.toBeInstanceOf(DevelopmentRuntimeRefusedError);
    expect(() =>
      provisionConnectorServiceSecret({ secretKey: SYNTHETIC_CONNECTOR_SECRET }),
    ).toThrow(DevelopmentRuntimeRefusedError);
    expect(() => provisionPublicOrigin(PUBLIC_ORIGIN)).toThrow(DevelopmentRuntimeRefusedError);
    await expect(
      provisionProviderConnection({ provider: "anthropic", apiKey: SYNTHETIC_PROVIDER_KEY }),
    ).rejects.toBeInstanceOf(DevelopmentRuntimeRefusedError);
    await expect(
      provisionDevInstance({
        namespace: { instanceNamespace: NAMESPACE, instanceDisplayName: DISPLAY_NAME },
        publicOrigin: PUBLIC_ORIGIN,
      }),
    ).rejects.toBeInstanceOf(DevelopmentRuntimeRefusedError);

    expect(await snapshotMetadata()).toEqual(before);
  }, 120_000);

  // -------------------------------------------------------------------------
  // 3. The composed run: four writes, the wizard's own readiness predicates,
  //    and a second run that writes nothing.
  // -------------------------------------------------------------------------

  it("provisions the whole instance, leaves the wizard's readiness predicates satisfied, and is idempotent", async () => {
    const { provisionDevInstance } = await import(
      "@/lib/dev-instance-provisioning/provision-instance"
    );
    const { deriveSetupAiStepState } = await import("@/lib/setup-provider-commit");
    const { readInstanceIdentity } = await import("@/lib/instance-identity-store");
    const { getMcpPublicBaseUrl } = await import("@cinatra-ai/mcp-server/credentials");
    const { readLiveCredentialFingerprint } = await import("@/lib/llm-credential-fingerprint");
    const { PUBLIC_ORIGIN_RESTART_STEP } = await import(
      "@/lib/dev-instance-provisioning/provision-public-origin"
    );
    const { writeConnectorConfigToDatabase } = await import("@/lib/database");

    // The connector's own network, doubled — and nothing else.
    const externalCalls = { save: 0, validate: 0, sync: 0 };
    const deps = buildProviderDoubles(externalCalls, writeConnectorConfigToDatabase);
    const readFingerprint = (provider: string) =>
      readLiveCredentialFingerprint(provider, deps.surface);

    const startedAt = Date.now();
    const first = await provisionDevInstance(
      {
        namespace: { instanceNamespace: NAMESPACE, instanceDisplayName: DISPLAY_NAME },
        connectorService: {
          secretKey: SYNTHETIC_CONNECTOR_SECRET,
          serverUrl: CONNECTOR_SERVICE_URL,
        },
        provider: { provider: "anthropic", apiKey: SYNTHETIC_PROVIDER_KEY },
        publicOrigin: PUBLIC_ORIGIN,
      },
      deps.provisioningDeps,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(first.wrote).toBe(true);
    expect(first.namespace?.written).toBe(true);
    expect(first.connectorService?.written).toBe(true);
    expect(first.provider?.written).toBe(true);
    expect(first.publicOrigin?.written).toBe(true);
    // The one restart step the public-origin write owes the operator.
    expect(first.notices).toContain(PUBLIC_ORIGIN_RESTART_STEP);
    // The whole point of the command: it is not a browser session.
    expect(elapsedMs).toBeLessThan(120_000);

    // The wizard's OWN predicates, asked the way the wizard asks them.
    const state = await deriveSetupAiStepState({ readCredentialFingerprint: readFingerprint });
    expect(state.ready).toBe(true);
    expect(state.locked).toBe(true);
    expect(readInstanceIdentity()?.instanceNamespace).toBe(NAMESPACE);
    expect(getMcpPublicBaseUrl().publicBaseUrl).toBe(PUBLIC_ORIGIN);

    // --- The second run --------------------------------------------------
    const afterFirstRun = await snapshotMetadata();
    const externalCallsAfterFirstRun = { ...externalCalls };

    const second = await provisionDevInstance(
      {
        namespace: { instanceNamespace: NAMESPACE, instanceDisplayName: DISPLAY_NAME },
        connectorService: {
          secretKey: SYNTHETIC_CONNECTOR_SECRET,
          serverUrl: CONNECTOR_SERVICE_URL,
        },
        provider: { provider: "anthropic", apiKey: SYNTHETIC_PROVIDER_KEY },
        publicOrigin: PUBLIC_ORIGIN,
      },
      deps.provisioningDeps,
    );

    expect(second.wrote).toBe(false);
    expect(second.namespace?.written).toBe(false);
    expect(second.connectorService?.written).toBe(false);
    expect(second.provider?.written).toBe(false);
    expect(second.publicOrigin?.written).toBe(false);
    // No additional database write, byte for byte.
    expect(await snapshotMetadata()).toEqual(afterFirstRun);
    // And no additional external call.
    expect(externalCalls).toEqual(externalCallsAfterFirstRun);
    // The restart step is still printed — a re-run on an un-restarted instance
    // still owes it.
    expect(second.notices).toContain(PUBLIC_ORIGIN_RESTART_STEP);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function omit<T extends object>(value: T | null, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(value as unknown as Record<string, unknown>) };
  for (const key of keys) delete out[key];
  return out;
}

async function readRawMetadata(key: string): Promise<string | null> {
  const { rows } = await admin.query<{ value: string }>(
    `SELECT value FROM ${q(SCHEMA)}.${q("metadata")} WHERE key = $1`,
    [key],
  );
  return rows[0]?.value ?? null;
}

async function resetInProcessCaches(): Promise<void> {
  const { invalidateInstanceIdentityCache } = await import("@/lib/instance-identity-cache");
  invalidateInstanceIdentityCache();
  const { deleteConnectorConfigByPrefix } = await import("@/lib/database");
  // Evicts the in-process connector-config cache entries for keys the previous
  // test truncated underneath it (the delete is a no-op on rows already gone).
  deleteConnectorConfigByPrefix("");
}

/**
 * The doubles for what leaves the machine. The credential SAVE writes the
 * connector's own stored row (the connector's business, reached here directly
 * because dispatching the extension action needs an installed, active
 * connector); the readiness ports' external legs report success; the credential
 * fingerprint is computed by the REAL reader over this surface.
 */
function buildProviderDoubles(
  calls: { save: number; validate: number; sync: number },
  writeConnectorConfig: (connectorId: string, value: unknown) => void,
) {
  let storedKey: string | null = null;
  const surface = {
    getConfiguredAPIKey: async () => storedKey,
  };
  return {
    surface,
    provisioningDeps: {
      attachMarketplaceConsumer: async () => {},
      saveConnection: async (_provider: string, values: Record<string, string>) => {
        calls.save += 1;
        storedKey = values.apiKey;
        writeConnectorConfig("anthropic_connection", { apiKey: values.apiKey });
        return { ok: true as const, code: "saved" as const, sanitizedMessage: null };
      },
      readCredentialFingerprint: async (provider: string) => {
        const { readLiveCredentialFingerprint } = await import(
          "@/lib/llm-credential-fingerprint"
        );
        return readLiveCredentialFingerprint(provider, surface);
      },
      readinessPortOverrides: {
        validateCredential: async () => {
          calls.validate += 1;
          return { ok: true };
        },
        isSurfaceReady: async () => true,
        runStrictInitialSync: async () => {
          calls.sync += 1;
          return { uploadedSkillIds: [{ skillId: "synthetic-skill", version: "1" }] };
        },
      },
    },
  };
}

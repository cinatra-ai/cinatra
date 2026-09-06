// cinatra#3202 — THE CONFIGURED ANTHROPIC KEY IS RESOLVED THROUGH THE
// CONNECTOR'S REGISTERED SURFACE, NEVER THROUGH THE LEGACY ROW.
//
// The connector purges its legacy plaintext connector-config row the moment it
// holds a verified connection-service pointer, so every host read that went to
// that row directly saw nothing for a service-held key. This suite pins the
// state that produced the permanent failure — A KEY HELD BY THE CONNECTION
// SERVICE AND NO LEGACY ROW AT ALL — at the three seams that decide whether
// setup can commit and whether a later skill-selecting turn can run.
//
// RED on the previous head, for the reason the issue describes:
//   1. deriveApiKeyFingerprint() -> null            (setup's initial-sync step
//      could never identify the namespace, so it could never commit);
//   2. the upload client was constructed with an EMPTY key;
//   3. the sync-map state port resolved no mirrored reference, so every later
//      turn that selected an Anthropic skill was refused — permanently, since
//      the row it depended on is deleted rather than merely stale.
//
// The transient "sync has not caught up yet" race is a DIFFERENT, still-valid
// outcome: it is an absent MIRROR ROW under a resolvable namespace. Case 3
// below separates the two — same wire-visible refusal before, distinguishable
// causes now.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";

import {
  CREDENTIAL_FINGERPRINT_VERSION_PREFIX,
  deriveKeyedCredentialFingerprint,
} from "@/lib/llm-credential-fingerprint";

/** 64 hex chars = 32 bytes: a valid host secret for the keyed derivation. */
const HOST_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** The live connector surface. `null` = connector not installed/active. */
let surface: { getConfiguredAPIKey?: () => Promise<string | null> } | null = null;
/** The LEGACY connector-config row. `null` = purged, the real post-save state. */
let legacyRow: { apiKey?: string } | null = null;
let globalOptIn = false;

vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: (providerId: string) => (providerId === "anthropic" ? surface : null),
}));

vi.mock("@/lib/database", () => ({
  readAnthropicConnectionFromDatabase: () => legacyRow,
  readAnthropicSkillSyncEnabledFromDatabase: () => globalOptIn,
  readSkillLifecycleStates: () => ({ ok: true, states: new Map<string, string | null>() }),
}));

/** Every key the upload client was constructed with, in order. */
const uploadClientKeys: string[] = [];
/** The state port the sync map was built with — the later-turn resolution seam. */
let syncMapStatePort: {
  readRow: (
    catalogSkillId: string,
  ) => Promise<{ anthropicSkillId: string; anthropicVersion: string; stale: boolean } | null>;
} | null = null;

vi.mock("@cinatra-ai/llm", () => ({
  AnthropicSkillSyncEngine: class {
    async sync() {
      return { ok: true, outcomes: [] };
    }
    async syncStrict() {
      return { ok: true, outcomes: [] };
    }
  },
  TableBackedAnthropicSkillSyncMap: class {
    constructor(state: never) {
      syncMapStatePort = state as unknown as typeof syncMapStatePort;
    }
  },
  FetchAnthropicCustomSkillsClient: class {
    constructor(public apiKey: string) {
      uploadClientKeys.push(apiKey);
    }
  },
  defaultAnthropicSkillUploadGate: { isUploadAllowed: () => false },
  setAnthropicSkillSyncMap: vi.fn(),
}));

vi.mock("@cinatra-ai/skills", () => ({
  readSkillsCatalogSnapshot: async () => ({ skills: [] as Array<{ id: string }> }),
  getSkillAnthropicUploadFlag: () => undefined,
  assertSkillFilePathInsideRoot: () => {},
  isRuntimeDeliverableLifecycleState: () => true,
}));

vi.mock("@/lib/skill-bundle-store", () => ({
  captureSkillBundleFromDisk: vi.fn(),
  lintBundleRouterReferences: () => ({ ok: true, missing: [] }),
  readCurrentSkillBundleFromDatabase: () => null,
}));

vi.mock("@/lib/anthropic-skill-upload-governance", () => ({
  isAnthropicSkillUploadAllowedFromConfig: () => false,
}));

/** The mirror rows, keyed by the namespace the caller resolved. */
const syncRows = new Map<
  string,
  { anthropicSkillId: string; anthropicVersion: string; stale: boolean }
>();

vi.mock("@/lib/anthropic-skill-sync-dao", () => ({
  readSyncRow: async (fp: string, env: string, id: string) =>
    syncRows.get(`${fp}|${env}|${id}`) ?? null,
  upsertSyncRow: vi.fn(),
  markSyncRowStale: vi.fn(),
  markStaleForRemovedCatalogSkills: vi.fn(),
  withNamespaceSyncLock: async (_fp: string, _env: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/lib/anthropic-skill-lease-dao", () => ({
  acquireSkillLease: vi.fn(async () => {}),
}));

const {
  deriveApiKeyFingerprint,
  resolveConfiguredAnthropicApiKey,
  deriveEnvironmentNamespace,
  syncCatalogSkillsToAnthropic,
  ensureAnthropicSkillSyncMapRegistered,
} = await import("../anthropic-skill-sync-service");

const SERVICE_HELD_KEY = "sk-ant-held-by-the-connection-service";
const REGISTERED_FLAG = Symbol.for("@cinatra-ai/host:anthropic-skill-sync-map-registered/v1");

beforeEach(() => {
  // The state the connector actually leaves behind after a
  // connection-service-backed save: a key it can resolve, and NO legacy row.
  surface = { getConfiguredAPIKey: async () => SERVICE_HELD_KEY };
  legacyRow = null;
  globalOptIn = true;
  uploadClientKeys.length = 0;
  syncRows.clear();
  syncMapStatePort = null;
  delete process.env.BETTER_AUTH_SECRET;
  process.env.CINATRA_ENCRYPTION_KEY = HOST_SECRET;
  process.env.SUPABASE_DB_URL = "postgresql://u@127.0.0.1:5432/cinatra_3202";
  process.env.SUPABASE_SCHEMA = "cinatra";
  // The registration flag is a per-PROCESS fact anchored on globalThis; clear it
  // so each case registers its own map.
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTERED_FLAG];
});

describe("cinatra#3202 — a service-held key with the legacy row purged", () => {
  it("SEAM 1: the namespace fingerprint resolves the real key (it used to be null)", async () => {
    const fp = await deriveApiKeyFingerprint();

    // It resolves the REAL service-held key (leg 1), and it does so on the ONE
    // host-owned KEYED road for a credential (leg 2) — never a second, plain
    // digest of the same key.
    expect(fp).toBe(
      deriveKeyedCredentialFingerprint("anthropic", SERVICE_HELD_KEY, HOST_SECRET),
    );
    expect(fp!.startsWith(CREDENTIAL_FINGERPRINT_VERSION_PREFIX)).toBe(true);
    expect(fp).not.toContain(SERVICE_HELD_KEY);
    expect(fp).not.toBe(createHash("sha256").update(SERVICE_HELD_KEY).digest("hex"));
    process.env.BETTER_AUTH_SECRET = "app-secret";
    expect(await deriveApiKeyFingerprint()).toBe(fp);
    expect(await deriveApiKeyFingerprint()).not.toBe(
      createHmac("sha256", "app-secret").update(SERVICE_HELD_KEY).digest("hex"),
    );
  });

  it("SEAM 2: the upload client is built with the real key (it used to get an empty string)", async () => {
    const result = await syncCatalogSkillsToAnthropic();

    expect(result.ok).toBe(true);
    expect(uploadClientKeys).toEqual([SERVICE_HELD_KEY]);
    // And it is the SAME resolution the namespace used — one read, not two.
    expect(uploadClientKeys[0]).toBe(await resolveConfiguredAnthropicApiKey());
  });

  it("SEAM 3: a later skill-selecting turn resolves its mirrored reference", async () => {
    // A skill that WAS uploaded under this key's namespace.
    const namespace = `${await deriveApiKeyFingerprint()}|${deriveEnvironmentNamespace()}`;
    syncRows.set(`${namespace}|@cinatra-ai/skills:writing`, {
      anthropicSkillId: "skill_abc",
      anthropicVersion: "3",
      stale: false,
    });

    ensureAnthropicSkillSyncMapRegistered();
    expect(syncMapStatePort).not.toBeNull();

    // Resolvable ⇒ the delivery loop gets a reference and the turn RUNS. On the
    // previous head this was null for the permanent reason (no namespace at
    // all), which the runtime reported as the transient "not finished uploading
    // yet" condition and never recovered from.
    await expect(syncMapStatePort!.readRow("@cinatra-ai/skills:writing")).resolves.toEqual({
      anthropicSkillId: "skill_abc",
      anthropicVersion: "3",
      stale: false,
    });
  });

  it("SEAM 3: the genuine TRANSIENT race stays distinct — namespace resolves, the row is simply not there yet", async () => {
    // No mirror row written: the sync has not caught up. The namespace still
    // resolves, so this is an honestly transient "not uploaded yet" — the case
    // the classified-error path exists for, and no longer the only observable
    // outcome for the permanent one above.
    expect(await deriveApiKeyFingerprint()).not.toBeNull();

    ensureAnthropicSkillSyncMapRegistered();
    await expect(syncMapStatePort!.readRow("@cinatra-ai/skills:writing")).resolves.toBeNull();
  });
});

describe("cinatra#3202 — the surface is authoritative, the legacy row is only a degraded fallback", () => {
  it("a key the surface reports is preferred over a stale legacy row", async () => {
    legacyRow = { apiKey: "sk-ant-stale-plaintext" };
    expect(await resolveConfiguredAnthropicApiKey()).toBe(SERVICE_HELD_KEY);
  });

  it("the surface answering NO KEY is authoritative — the purged row is not re-read", async () => {
    surface = { getConfiguredAPIKey: async () => null };
    legacyRow = { apiKey: "sk-ant-stale-plaintext" };
    expect(await resolveConfiguredAnthropicApiKey()).toBeNull();
    expect(await deriveApiKeyFingerprint()).toBeNull();
  });

  it("an UNREADABLE surface degrades to the legacy row (unchanged pre-existing behaviour)", async () => {
    legacyRow = { apiKey: "sk-ant-row-only" };

    surface = null; // connector not installed/active
    expect(await resolveConfiguredAnthropicApiKey()).toBe("sk-ant-row-only");

    surface = {}; // installed, exposes no credential reader
    expect(await resolveConfiguredAnthropicApiKey()).toBe("sk-ant-row-only");

    surface = {
      getConfiguredAPIKey: async () => {
        throw new Error("credential read failed");
      },
    };
    expect(await resolveConfiguredAnthropicApiKey()).toBe("sk-ant-row-only");
  });

  it("no key anywhere ⇒ null, and the sync is inert", async () => {
    surface = null;
    legacyRow = null;
    expect(await deriveApiKeyFingerprint()).toBeNull();
    await expect(syncCatalogSkillsToAnthropic()).resolves.toEqual({ ok: true, outcomes: [] });
    expect(uploadClientKeys).toEqual([]);
  });
});

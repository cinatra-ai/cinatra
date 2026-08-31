/**
 * THE PROVIDER-CONNECTION BOOTSTRAP BOOT PHASE.
 *
 * A deployment materializes the provider key into the instance environment, so
 * before this phase an operator still had to re-type it into the setup wizard.
 * The phase closes that gap: when `OPENAI_API_KEY` is present and NO sealed
 * connection row exists it seals the environment value through the SAME writer
 * and codec the wizard uses, and completes the model step through the SAME
 * claim/commit machine — never a second write path.
 *
 * Pinned here against ONE in-memory, byte-accurate `cinatra.metadata` KV that
 * mirrors the production primitives (insert-if-absent, byte-equal CAS, raw
 * snapshot reads) — the same seam `openai-connection-store-at-rest.test.ts` and
 * `setup-provider-commit.test.ts` use. Everything under test is REAL code: the
 * seal codec, the connection store, the commit machine, the step derivation.
 *
 * SECRETS: obviously-fake placeholder keys only, and the log-hygiene case
 * asserts no captured boot line ever carries one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isSealed } from "@/lib/connector-config-secret-fields";

const ENV_API_KEY = "sk-FAKE-bootstrap-env-key-0000";
const SEEDED_API_KEY = "sk-FAKE-bootstrap-seeded-key-1111";
const ROTATED_AWAY_API_KEY = "sk-FAKE-bootstrap-third-key-2222";
const VALID_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// ONE in-memory metadata KV behind BOTH metadata ports: the connection row's
// dedicated port (`@/lib/database-metadata`) and the commit machine's generic
// primitives (`@/lib/database`). One store, because on a real instance they are
// one table — a phase that sealed into one and committed against the other
// would prove nothing.
// ---------------------------------------------------------------------------
const kv = new Map<string, string>();
const defaultProvider = { value: "gemini" };

const revalidate = vi.hoisted(() => ({
  calls: [] as string[],
  throwNoRequestStore: false,
}));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidate.calls.push(path);
    if (revalidate.throwNoRequestStore) {
      // EXACTLY what Next throws outside a request/work store — which is where
      // a boot phase runs. See `next/dist/server/web/spec-extension/revalidate`.
      const err = new Error(
        `Invariant: static generation store missing in revalidatePath ${path}`,
      );
      Object.defineProperty(err, "__NEXT_ERROR_CODE", {
        value: "E263",
        enumerable: false,
      });
      throw err;
    }
  },
}));

vi.mock("@/lib/database-metadata", async () => {
  const real = await import("@/lib/connector-config-secret-fields");
  const port: import("@/lib/connector-config-secret-fields").OpenAIConnectionMetadataPort = {
    readValue: <T,>(key: string, fallback: T): T => {
      const raw = kv.get(key);
      return raw === undefined ? fallback : (JSON.parse(raw) as T);
    },
    readRaw: (key: string) => kv.get(key) ?? null,
    insertIfAbsent: (key: string, value: unknown) => {
      if (!kv.has(key)) kv.set(key, JSON.stringify(value));
    },
    compareAndSwap: (key: string, newValue: string, expectedRaw: string) => {
      if (kv.get(key) !== expectedRaw) return false;
      kv.set(key, newValue);
      return true;
    },
  };
  return {
    readUnsealedOpenAIConnectionRow: () => real.readUnsealedOpenAIConnectionRowVia(port),
    readRawOpenAIConnectionRow: () => real.readRawOpenAIConnectionRowVia(port),
    writeSealedOpenAIConnectionRow: (
      next: unknown,
      options?: { preserveExistingSecret?: boolean },
    ) => real.writeSealedOpenAIConnectionRowVia(port, next, options),
    upgradeLegacyOpenAIConnectionRow: () => real.upgradeLegacyOpenAIConnectionRowVia(port),
  };
});

vi.mock("@/lib/database", () => ({
  readRawMetadataStringFromDatabase: (key: string) => kv.get(key) ?? null,
  writeMetadataValueIfAbsentToDatabase: (key: string, value: unknown) => {
    if (!kv.has(key)) kv.set(key, JSON.stringify(value));
  },
  compareAndSwapMetadataValueFromDatabase: (
    key: string,
    value: unknown,
    expectedRaw: string,
  ) => {
    if (kv.get(key) !== expectedRaw) return false;
    if (value === null) kv.delete(key);
    else kv.set(key, JSON.stringify(value));
    return true;
  },
  readDefaultLlmProviderFromDatabase: () => defaultProvider.value,
  writeDefaultLlmProviderToDatabase: (p: string) => {
    defaultProvider.value = p;
  },
}));

// The strict audit sink. Pinned by the audit module's own suites; here it is a
// spy so the boot-time audited write can be asserted for its ACTOR.
const auditEvents: Array<Record<string, unknown>> = [];
vi.mock("@/lib/authz/audit", () => ({
  logAuditEventStrict: async (input: Record<string, unknown>) => {
    auditEvents.push(input);
  },
}));

// The provider-specific readiness inputs (Anthropic-only in practice) and the
// receipt seam. Pinned by setup-readiness-receipt.test.ts.
vi.mock("@/lib/setup-readiness-saga", () => ({
  areProviderReadinessInputsSatisfied: () => true,
  readSetupReadinessState: () => ({ ready: false, receipt: null }),
  readSetupReadinessReceipt: () => null,
}));

// The LIVE credential fingerprint. Bound to the SEALED ROW rather than a
// constant, so `credentialFresh` in the step derivation is genuinely a
// statement about the value this phase sealed.
vi.mock("@/lib/llm-credential-fingerprint", () => ({
  readLiveCredentialFingerprint: async () => {
    const { readOpenAIConnection } = await import("@/lib/openai-connection-store");
    const key = readOpenAIConnection()?.apiKey;
    return key
      ? { status: "readable" as const, fingerprint: `cfv1:fake:${key}` }
      : { status: "absent" as const };
  },
  liveCredentialFingerprintMatches: (
    stored: string | null,
    live: { status: string; fingerprint?: string },
  ) => Boolean(stored) && live.status === "readable" && stored === live.fingerprint,
}));

vi.mock("@/lib/runtime-mode", () => ({ isAppDevelopmentMode: () => false }));

// ---------------------------------------------------------------------------
// Environment fixture
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "CINATRA_ENCRYPTION_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_PROJECT",
  "OPENAI_API_ORG",
  "CINATRA_PROVIDER_BOOTSTRAP_ROTATE",
] as const;
const originalEnv: Record<string, string | undefined> = {};

type Captured = { level: string; line: string };
let captured: Captured[] = [];
let spies: Array<{ mockRestore: () => void }> = [];

function captureBootOutput() {
  captured = [];
  const capture = (level: string) => (...args: unknown[]) => {
    captured.push({ level, line: args.map((a) => String(a)).join(" ") });
  };
  spies = [
    vi.spyOn(console, "log").mockImplementation(capture("log")),
    vi.spyOn(console, "warn").mockImplementation(capture("warn")),
    vi.spyOn(console, "error").mockImplementation(capture("error")),
  ];
}

beforeEach(() => {
  vi.resetModules();
  kv.clear();
  auditEvents.length = 0;
  revalidate.calls = [];
  revalidate.throwNoRequestStore = false;
  defaultProvider.value = "gemini";
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.CINATRA_ENCRYPTION_KEY = VALID_KEY_HEX;
  captureBootOutput();
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key] as string;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function bootPhase() {
  const { providerConnectionBootstrapPhases } = await import(
    "@/lib/boot/phases/provider-connection-bootstrap"
  );
  const phases = providerConnectionBootstrapPhases();
  expect(phases).toHaveLength(1);
  expect(phases[0].name).toBe("provider-connection-bootstrap");
  // A missing/refused bootstrap must never gate a deploy — it retries next boot.
  expect(phases[0].policy).toBe("retryable");
  return phases[0];
}

async function readConnection() {
  const { readOpenAIConnection } = await import("@/lib/openai-connection-store");
  return readOpenAIConnection();
}

async function seedSealedRow(apiKey: string) {
  const { updateOpenAIConnection } = await import("@/lib/openai-connection-store");
  await updateOpenAIConnection({ apiKey });
}

/** The row exactly as it sits at rest. */
function storedRow(): Record<string, unknown> {
  return JSON.parse(kv.get("openai_connection") ?? "null") as Record<string, unknown>;
}

function everyCapturedLine(): string {
  return captured.map((c) => `${c.level}:${c.line}`).join("\n");
}

// =============================================================================

describe("provider-connection bootstrap — sealing from the environment", () => {
  it("skips when OPENAI_API_KEY is not in the environment", async () => {
    const outcome = await (await bootPhase()).run();

    expect(outcome).toEqual({ skipped: expect.stringContaining("OPENAI_API_KEY") });
    expect(kv.has("openai_connection")).toBe(false);
  });

  it("seals the environment key into the connection row when NO sealed row exists", async () => {
    process.env.OPENAI_API_KEY = ENV_API_KEY;

    await (await bootPhase()).run();

    // Round-trips through the store the wizard writes and the connector reads…
    expect((await readConnection())?.apiKey).toBe(ENV_API_KEY);
    // …and it is SEALED at rest, never plaintext (the wizard's own codec).
    expect(isSealed(storedRow().apiKey)).toBe(true);
    expect(kv.get("openai_connection")).not.toContain(ENV_API_KEY);
  });

  it("seals with NO project id — a project id is optional", async () => {
    process.env.OPENAI_API_KEY = ENV_API_KEY;

    const outcome = await (await bootPhase()).run();

    expect(outcome).toBeUndefined();
    const connection = await readConnection();
    expect(connection?.apiKey).toBe(ENV_API_KEY);
    expect(connection?.projectId).toBeUndefined();
    expect(connection?.organizationId).toBeUndefined();
  });

  it("carries the optional project and organization ids when the environment sets them", async () => {
    process.env.OPENAI_API_KEY = ENV_API_KEY;
    process.env.OPENAI_API_PROJECT = "proj_FAKE_bootstrap";
    process.env.OPENAI_API_ORG = "org_FAKE_bootstrap";

    await (await bootPhase()).run();

    const connection = await readConnection();
    expect(connection?.projectId).toBe("proj_FAKE_bootstrap");
    expect(connection?.organizationId).toBe("org_FAKE_bootstrap");
  });

  it("revalidates NO route at boot — there is no router cache before the first request", async () => {
    process.env.OPENAI_API_KEY = ENV_API_KEY;
    // Armed so that ANY revalidation attempt throws exactly what Next throws
    // without a work store. The phase must not make one: it opts out at the
    // writer instead, so the request path keeps its error semantics intact.
    revalidate.throwNoRequestStore = true;

    const outcome = await (await bootPhase()).run();

    expect(outcome).toBeUndefined();
    expect(revalidate.calls).toEqual([]);
    expect((await readConnection())?.apiKey).toBe(ENV_API_KEY);
  });

  it("still revalidates the routes for a REQUEST-time writer (the wizard is unchanged)", async () => {
    await seedSealedRow(SEEDED_API_KEY);

    // The wizard's own call site passes no options and drops the route cache.
    expect(revalidate.calls).toContain("/configuration/llm");
  });

  it("leaves OPENAI_API_KEY in the environment for the knowledge-graph indexer", async () => {
    process.env.OPENAI_API_KEY = ENV_API_KEY;

    await (await bootPhase()).run();

    expect(process.env.OPENAI_API_KEY).toBe(ENV_API_KEY);
  });
});

describe("provider-connection bootstrap — the sealed row is the source of truth", () => {
  it("IGNORES the environment when a sealed row already exists", async () => {
    await seedSealedRow(SEEDED_API_KEY);
    process.env.OPENAI_API_KEY = ENV_API_KEY;

    const outcome = await (await bootPhase()).run();

    expect(outcome).toEqual({ skipped: expect.stringContaining("sealed") });
    expect((await readConnection())?.apiKey).toBe(SEEDED_API_KEY);
  });

  it("does NOT touch the setup commitment when the sealed row wins", async () => {
    await seedSealedRow(SEEDED_API_KEY);
    process.env.OPENAI_API_KEY = ENV_API_KEY;

    await (await bootPhase()).run();

    expect(kv.has("setup_provider_commit")).toBe(false);
    expect(defaultProvider.value).toBe("gemini");
    expect(auditEvents).toHaveLength(0);
  });

  it("RE-SEALS from the environment under CINATRA_PROVIDER_BOOTSTRAP_ROTATE, and logs the flag's effect", async () => {
    await seedSealedRow(SEEDED_API_KEY);
    process.env.OPENAI_API_KEY = ENV_API_KEY;
    process.env.CINATRA_PROVIDER_BOOTSTRAP_ROTATE = "true";

    await (await bootPhase()).run();

    expect((await readConnection())?.apiKey).toBe(ENV_API_KEY);
    expect(isSealed(storedRow().apiKey)).toBe(true);
    expect(everyCapturedLine()).toContain("CINATRA_PROVIDER_BOOTSTRAP_ROTATE");
  });

  it("re-seals ONCE: a second run in the same process does not rotate again", async () => {
    await seedSealedRow(SEEDED_API_KEY);
    process.env.OPENAI_API_KEY = ENV_API_KEY;
    process.env.CINATRA_PROVIDER_BOOTSTRAP_ROTATE = "true";
    const phase = await bootPhase();

    await phase.run();
    process.env.OPENAI_API_KEY = ROTATED_AWAY_API_KEY;
    const second = await phase.run();

    expect(second).toEqual({ skipped: expect.stringContaining("already re-sealed") });
    expect((await readConnection())?.apiKey).toBe(ENV_API_KEY);
  });

  it("an UNDECRYPTABLE sealed row STILL wins — presence is read from the raw row", async () => {
    await seedSealedRow(SEEDED_API_KEY);
    const sealedBytes = kv.get("openai_connection");
    // The host key changed under a row sealed with the old one. The unseal
    // reader drops the field fail-closed, so a DECRYPTED read reports no key —
    // and deciding on that read would silently overwrite an operator's row.
    process.env.CINATRA_ENCRYPTION_KEY =
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    process.env.OPENAI_API_KEY = ENV_API_KEY;

    const outcome = await (await bootPhase()).run();

    expect(outcome).toEqual({ skipped: expect.stringContaining("sealed") });
    expect(kv.get("openai_connection")).toBe(sealedBytes);
    expect(everyCapturedLine()).not.toContain(ENV_API_KEY);
  });

  it("treats any value other than \"true\" as rotation OFF", async () => {
    await seedSealedRow(SEEDED_API_KEY);
    process.env.OPENAI_API_KEY = ENV_API_KEY;
    process.env.CINATRA_PROVIDER_BOOTSTRAP_ROTATE = "1";

    await (await bootPhase()).run();

    expect((await readConnection())?.apiKey).toBe(SEEDED_API_KEY);
  });
});

describe("provider-connection bootstrap — the model setup step", () => {
  it("reads COMPLETE after a bootstrap, exactly as a wizard run leaves it", async () => {
    process.env.OPENAI_API_KEY = ENV_API_KEY;

    await (await bootPhase()).run();

    const { deriveSetupAiStepState } = await import("@/lib/setup-provider-commit");
    const state = await deriveSetupAiStepState();
    expect(state.locked).toBe(true);
    expect(state.credentialFresh).toBe(true);
    expect(state.ready).toBe(true);
  });

  it("records the commitment through the machine, with an honest bootstrap provenance", async () => {
    process.env.OPENAI_API_KEY = ENV_API_KEY;

    await (await bootPhase()).run();

    const { readSetupProviderCommitState } = await import("@/lib/setup-provider-commit");
    const state = readSetupProviderCommitState();
    expect(state.kind).toBe("committed");
    if (state.kind !== "committed") throw new Error("unreachable");
    expect(state.commitment.provider).toBe("openai");
    expect(state.commitment.provenance).toBe("environment-bootstrap");
    // No human took this action, so no human is named on the record.
    expect(state.commitment.actorId).toBeNull();
  });

  it("writes the default provider through the AUDITED mutation, as a system actor", async () => {
    process.env.OPENAI_API_KEY = ENV_API_KEY;

    await (await bootPhase()).run();

    expect(defaultProvider.value).toBe("openai");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      actorPrincipalType: "system",
      resourceType: "administration",
      resourceId: "llm_default_provider",
      operation: "settings.default_llm_provider.update",
      decision: "allowed",
    });
    expect(auditEvents[0].actorPrincipalId).toContain("provider-connection-bootstrap");
  });

  it("RESUMES an interrupted bootstrap: a row sealed from THIS environment with no commitment completes the step", async () => {
    // Exactly the state a crash (or a refused commit) between the two writes
    // leaves behind. The sealed-row-wins rule must not strand it forever.
    await seedSealedRow(ENV_API_KEY);
    expect(kv.has("setup_provider_commit")).toBe(false);
    process.env.OPENAI_API_KEY = ENV_API_KEY;

    const outcome = await (await bootPhase()).run();

    expect(outcome).toBeUndefined();
    const { deriveSetupAiStepState, readSetupProviderCommitState } = await import(
      "@/lib/setup-provider-commit"
    );
    const state = readSetupProviderCommitState();
    expect(state.kind).toBe("committed");
    if (state.kind !== "committed") throw new Error("unreachable");
    expect(state.commitment.provenance).toBe("environment-bootstrap");
    expect((await deriveSetupAiStepState()).ready).toBe(true);
    // The row was NOT re-sealed; only the missing half was written.
    expect((await readConnection())?.apiKey).toBe(ENV_API_KEY);
  });

  it("does NOT resume for a row holding some OTHER value — that operator's setup stays theirs", async () => {
    await seedSealedRow(SEEDED_API_KEY);
    process.env.OPENAI_API_KEY = ENV_API_KEY;

    const outcome = await (await bootPhase()).run();

    expect(outcome).toEqual({ skipped: expect.stringContaining("sealed") });
    expect(kv.has("setup_provider_commit")).toBe(false);
  });

  it("a ROTATION keeps the step COMPLETE: the commitment's fingerprint is refreshed", async () => {
    process.env.OPENAI_API_KEY = ENV_API_KEY;
    await (await bootPhase()).run();
    const { deriveSetupAiStepState, readSetupProviderCommitState } = await import(
      "@/lib/setup-provider-commit"
    );
    expect((await deriveSetupAiStepState()).ready).toBe(true);
    const before = readSetupProviderCommitState();
    if (before.kind !== "committed") throw new Error("unreachable");

    // Now rotate. Without refreshing the stored fingerprint the step would read
    // INCOMPLETE on an instance that was complete a moment earlier.
    process.env.OPENAI_API_KEY = ROTATED_AWAY_API_KEY;
    process.env.CINATRA_PROVIDER_BOOTSTRAP_ROTATE = "true";
    await (await bootPhase()).run();

    expect((await readConnection())?.apiKey).toBe(ROTATED_AWAY_API_KEY);
    const after = readSetupProviderCommitState();
    expect(after.kind).toBe("committed");
    if (after.kind !== "committed") throw new Error("unreachable");
    // The SAME commitment, refreshed — not a second one, and not a re-commit.
    expect(after.commitment.commitId).toBe(before.commitment.commitId);
    expect(after.commitment.credentialFingerprint).not.toBe(
      before.commitment.credentialFingerprint,
    );
    const state = await deriveSetupAiStepState();
    expect(state.credentialFresh).toBe(true);
    expect(state.ready).toBe(true);
    expect(everyCapturedLine()).not.toContain(ROTATED_AWAY_API_KEY);
  });

  it("leaves an EXISTING commitment alone (the phase never re-commits)", async () => {
    process.env.OPENAI_API_KEY = ENV_API_KEY;
    const phase = await bootPhase();
    await phase.run();
    const committedRaw = kv.get("setup_provider_commit");

    // A later boot with the row already sealed and committed.
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = ENV_API_KEY;
    await (await bootPhase()).run();

    expect(kv.get("setup_provider_commit")).toBe(committedRaw);
    expect(auditEvents).toHaveLength(1);
  });
});

describe("provider-connection bootstrap — log hygiene", () => {
  it("NEVER writes the key value to the boot output on the seal path", async () => {
    process.env.OPENAI_API_KEY = ENV_API_KEY;
    process.env.OPENAI_API_PROJECT = "proj_FAKE_bootstrap";

    const outcome = await (await bootPhase()).run();

    expect(captured.length).toBeGreaterThan(0); // it DID narrate the bootstrap
    expect(everyCapturedLine()).not.toContain(ENV_API_KEY);
    expect(JSON.stringify(outcome ?? null)).not.toContain(ENV_API_KEY);
  });

  it("NEVER writes either key value on the sealed-row-wins path", async () => {
    await seedSealedRow(SEEDED_API_KEY);
    process.env.OPENAI_API_KEY = ENV_API_KEY;

    const outcome = await (await bootPhase()).run();

    const lines = `${everyCapturedLine()}\n${JSON.stringify(outcome ?? null)}`;
    expect(lines).not.toContain(ENV_API_KEY);
    expect(lines).not.toContain(SEEDED_API_KEY);
  });

  it("NEVER writes the key value on the rotate path", async () => {
    await seedSealedRow(SEEDED_API_KEY);
    process.env.OPENAI_API_KEY = ENV_API_KEY;
    process.env.CINATRA_PROVIDER_BOOTSTRAP_ROTATE = "true";

    const outcome = await (await bootPhase()).run();

    const lines = `${everyCapturedLine()}\n${JSON.stringify(outcome ?? null)}`;
    expect(lines).toContain("CINATRA_PROVIDER_BOOTSTRAP_ROTATE");
    expect(lines).not.toContain(ENV_API_KEY);
    expect(lines).not.toContain(SEEDED_API_KEY);
  });

  it("names only the error CLASS when the seal fails (a bad host key)", async () => {
    process.env.OPENAI_API_KEY = ENV_API_KEY;
    process.env.CINATRA_ENCRYPTION_KEY = "too-short";

    await expect((await bootPhase()).run()).rejects.toThrow(
      /provider-connection-bootstrap/,
    );

    const lines = `${everyCapturedLine()}`;
    expect(lines).not.toContain(ENV_API_KEY);
    expect(kv.has("openai_connection")).toBe(false);
  });
});

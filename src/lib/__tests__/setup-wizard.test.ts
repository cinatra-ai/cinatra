// Tests for setup wizard step list.
//
// Covers:
//   - key is step 0, name is step 1
//   - CINATRA_ENCRYPTION_KEY ready/not-ready states
//   - Gemini step is NOT present
//   - isSetupWizardComplete() gate behavior
//   - the AI step's readiness derives from the provider-commit state machine
//     (cinatra#2388, epic #2385 S3): commitment (the lock) + fresh credential
//     fingerprint + provider-specific readiness — and completion is re-derived
//     FRESHLY on every read (the positive completion cache is gone, so a
//     complete→incomplete flip is visible immediately).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
}));

// cinatra#2386 — the sign-up step's presence is gated on hasAnyBetterAuthUsers().
// Default true (no step) so pre-existing tests below — written before the
// sign-up step existed — keep asserting steps[0]==="key" etc. without edits.
const hasUsersState = { value: true };
vi.mock("@/lib/auth", () => ({
  hasAnyBetterAuthUsers: () => Promise.resolve(hasUsersState.value),
}));

// The setup-wizard module imports several connector modules whose real
// implementations chain through @cinatra/connector-* barrels. Stub the LLM/
// Nango status helpers so the wizard logic runs in isolation.
// Note: connector-gemini is not imported by setup-wizard.
vi.mock("@cinatra-ai/openai-connector", () => ({
  isOpenAIConnectionReady: () => false,
  getConfiguredOpenAIConnection: async () => undefined,
}));
vi.mock("@/lib/nango-system", () => ({
  getNangoStatus: () => ({ status: "connected" }),
}));
// S3 (cinatra#2388): the AI step reads the provider-commit machine's FRESH
// derivation. Stubbed at that seam so the wizard's step/gate logic is
// exercised in isolation; the machine's own claim/commit/fingerprint rules are
// pinned by setup-provider-commit.test.ts.
const readinessState = { ready: false as boolean };
vi.mock("@/lib/setup-provider-commit", () => ({
  deriveSetupAiStepState: async () => ({
    ready: readinessState.ready,
    locked: readinessState.ready,
    credentialFresh: readinessState.ready,
    commitState: { kind: readinessState.ready ? "committed" : "absent" },
  }),
}));

import {
  getSetupWizardSteps,
  isSetupWizardComplete,
  getFirstIncompleteStep,
} from "@/lib/setup-wizard";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import type { InstanceIdentity } from "@/lib/instance-identity-store";

const SAMPLE_IDENTITY: InstanceIdentity = {
  instanceNamespace: "example-namespace",
  instanceDisplayName: "Acme Workspace",
  tokenCiphertext: "ct",
  tokenIv: "iv",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pwct",
  passwordIv: "pwiv",
  firstPublishedAt: null,
  createdAt: "2026-05-07T15:00:00.000Z",
};

const ORIGINAL_KEY = process.env.CINATRA_ENCRYPTION_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  hasUsersState.value = true;
  readinessState.ready = false;
  // Default: set a valid 64-char hex key so CINATRA_ENCRYPTION_KEY tests
  // don't bleed onto unrelated tests.
  process.env.CINATRA_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.CINATRA_ENCRYPTION_KEY;
  else process.env.CINATRA_ENCRYPTION_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// key step is step 0
// ---------------------------------------------------------------------------

describe("getSetupWizardSteps - key is step 0", () => {
  it("returns key as steps[0] with ready=false when CINATRA_ENCRYPTION_KEY is unset", async () => {
    delete process.env.CINATRA_ENCRYPTION_KEY;
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(null);
    const steps = await getSetupWizardSteps();
    expect(steps[0]?.id).toBe("key");
    expect(steps[0]?.href).toBe("/setup/key");
    expect(steps[0]?.ready).toBe(false);
  });

  it("returns key step as ready=true when CINATRA_ENCRYPTION_KEY is a 64-char hex", async () => {
    process.env.CINATRA_ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(null);
    const steps = await getSetupWizardSteps();
    const keyStep = steps.find((s) => s.id === "key");
    expect(keyStep).toBeDefined();
    expect(keyStep?.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSetupWizardComplete - key gate
// ---------------------------------------------------------------------------

describe("isSetupWizardComplete - key gate", () => {
  it("returns false when key step is not ready, even if all other steps are ready", async () => {
    delete process.env.CINATRA_ENCRYPTION_KEY;
    // Provide identity so name step would be ready; ai step is
    // never ready (mocked above) - but key blocks first anyway.
    vi.mocked(readInstanceIdentity).mockReturnValue(SAMPLE_IDENTITY);
    const result = await isSetupWizardComplete();
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// name step is index 1 after key
// ---------------------------------------------------------------------------

describe("getSetupWizardSteps - name step is index 1 after key", () => {
  it("returns name as step[1] when no identity is configured", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(null);
    const steps = await getSetupWizardSteps();
    expect(steps[1]?.id).toBe("name");
    expect(steps[1]?.href).toBe("/setup/name");
    expect(steps[1]?.ready).toBe(false);
  });

  it("marks the name step as ready when identity is configured", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(SAMPLE_IDENTITY);
    const steps = await getSetupWizardSteps();
    const nameStep = steps.find((s) => s.id === "name");
    expect(nameStep).toBeDefined();
    expect(nameStep?.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gemini step is not part of the setup wizard
// ---------------------------------------------------------------------------

describe("getSetupWizardSteps - no gemini step", () => {
  it("does NOT include a gemini step", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(null);
    const steps = await getSetupWizardSteps();
    expect(steps.find((s) => s.id === "gemini")).toBeUndefined();
  });

  it("isSetupWizardComplete returns false when ai is NOT ready", async () => {
    // No valid readiness receipt (the default); identity present so name is ready.
    vi.mocked(readInstanceIdentity).mockReturnValue(SAMPLE_IDENTITY);
    const result = await isSetupWizardComplete();
    // ai not ready -> false
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S6 (cinatra#2093): the AI step is RECEIPT-driven and provider-agnostic
// ---------------------------------------------------------------------------

describe("getSetupWizardSteps - the AI step follows the commit machine's derivation", () => {
  it("the ai step is NOT ready without a valid receipt, whatever any connection says", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(SAMPLE_IDENTITY);
    readinessState.ready = false;
    const steps = await getSetupWizardSteps();
    expect(steps.find((s) => s.id === "ai")?.ready).toBe(false);
  });

  it("the ai step IS ready with a valid receipt — no OpenAI-specific read involved", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(SAMPLE_IDENTITY);
    readinessState.ready = true;
    const steps = await getSetupWizardSteps();
    expect(steps.find((s) => s.id === "ai")?.ready).toBe(true);
  });

  it("a valid receipt completes the wizard (every other gate satisfied)", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(SAMPLE_IDENTITY);
    readinessState.ready = true;
    await expect(isSetupWizardComplete()).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2386 (setup-flow S1): the sign-up step is FIRST, but present ONLY
// while hasAnyBetterAuthUsers() is false.
// ---------------------------------------------------------------------------

describe("getSetupWizardSteps - the sign-up step (cinatra#2386)", () => {
  it("is steps[0], not ready, when zero Better Auth users exist", async () => {
    hasUsersState.value = false;
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(null);
    const steps = await getSetupWizardSteps();
    expect(steps[0]?.id).toBe("sign-up");
    expect(steps[0]?.href).toBe("/setup/sign-up");
    expect(steps[0]?.ready).toBe(false);
    // key shifts to index 1 while sign-up is present.
    expect(steps[1]?.id).toBe("key");
  });

  it("is ABSENT (not merely ready:true) once at least one user exists", async () => {
    hasUsersState.value = true;
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(null);
    const steps = await getSetupWizardSteps();
    expect(steps.find((s) => s.id === "sign-up")).toBeUndefined();
    expect(steps[0]?.id).toBe("key");
  });

  it("isSetupWizardComplete returns false while the sign-up step is present, even if every other gate is satisfied", async () => {
    hasUsersState.value = false;
    vi.mocked(readInstanceIdentity).mockReturnValue(SAMPLE_IDENTITY);
    readinessState.ready = true;
    await expect(isSetupWizardComplete()).resolves.toBe(false);
  });

  it("getFirstIncompleteStep resolves to the sign-up step ahead of every other step while it is present", async () => {
    hasUsersState.value = false;
    vi.mocked(readInstanceIdentity).mockReturnValue(SAMPLE_IDENTITY);
    readinessState.ready = true;
    const steps = await getSetupWizardSteps();
    expect(getFirstIncompleteStep(steps)?.id).toBe("sign-up");
  });
});

// ---------------------------------------------------------------------------
// S3 (cinatra#2388): NO completion cache — completion is re-derived freshly,
// so a complete→incomplete flip (credential deletion invalidating the
// fingerprint) is visible on the very next read. Under the retired positive
// cache this exact sequence served a stale `true` for up to 60 s.
// ---------------------------------------------------------------------------

describe("isSetupWizardComplete - fresh derivation, no stale-true window (cinatra#2388)", () => {
  it("reflects a complete→incomplete flip immediately", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(SAMPLE_IDENTITY);
    readinessState.ready = true;
    await expect(isSetupWizardComplete()).resolves.toBe(true);
    // The credential disappears (fingerprint mismatch) — the machine's fresh
    // derivation flips, and the wizard must flip WITH it, instantly.
    readinessState.ready = false;
    await expect(isSetupWizardComplete()).resolves.toBe(false);
  });
});

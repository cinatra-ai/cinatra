// Tests for setup wizard step list.
//
// Covers:
//   - key is step 0, name is step 1
//   - CINATRA_ENCRYPTION_KEY ready/not-ready states
//   - Gemini step is NOT present
//   - isSetupWizardComplete() gate behavior
//   - the AI step's readiness is RECEIPT VALIDITY (cinatra#2093, epic #2086 S6),
//     not a cached OpenAI connection boolean — so it is provider-agnostic and a
//     saved key alone never completes the step.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
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
// S6 (cinatra#2093): the AI step reads the setup READINESS RECEIPT. Stubbed at
// the readiness-state seam so the wizard's step/gate logic is exercised in
// isolation; the receipt's own validity + invalidation rules are pinned by
// setup-readiness-receipt.test.ts.
const readinessState = { ready: false as boolean };
vi.mock("@/lib/setup-readiness-saga", () => ({
  readSetupReadinessState: () => ({ ready: readinessState.ready, receipt: null }),
}));

import { getSetupWizardSteps, isSetupWizardComplete } from "@/lib/setup-wizard";
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

describe("getSetupWizardSteps - the AI step follows the readiness receipt", () => {
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

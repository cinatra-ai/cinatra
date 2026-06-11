// Tests for setup wizard step list.
//
// Covers:
//   - key is step 0, name is step 1
//   - CINATRA_ENCRYPTION_KEY ready/not-ready states
//   - Gemini step is NOT present
//   - isSetupWizardComplete() gate behavior

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
vi.mock("@/lib/openai-connection-store", () => ({
  readOpenAIConnection: () => null,
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
    // openai (ai step) is mocked as not ready above; identity present so name is ready
    vi.mocked(readInstanceIdentity).mockReturnValue(SAMPLE_IDENTITY);
    const result = await isSetupWizardComplete();
    // ai not ready -> false
    expect(result).toBe(false);
  });
});

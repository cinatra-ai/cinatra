// cinatra#2503 — the two setup gates must never reach opposite conclusions.
//
// The shell gate asks "is setup complete?" (`evaluateSetupGate` →
// `isStepsComplete`). `/setup` asks a DIFFERENT question of a SEPARATE read:
// "which step is next?" (`getFirstIncompleteStep`), and redirects to `/` when
// the answer is "none". Those are two independent derivations, and the redirect
// loop is exactly what happens when they disagree: one says "go to /setup", the
// other says "go to /".
//
// The fix has two halves. This file pins both:
//
//   1. SAME INPUT WITHIN A RENDER — `getSetupWizardSteps` is memoized per
//      server request with React `cache()`, so everything one request renders
//      reads the same steps. Asserted structurally (a `cache()` that gets
//      unwrapped is the regression), because React's cache is a pass-through
//      outside a server request and cannot be exercised from vitest.
//
//      Scope, stated honestly: this does NOT make `/` and `/setup` agree — they
//      are separate requests with separate caches. The cross-request half is
//      closed by `evaluateSetupGate` refusing to read an error as "incomplete"
//      (pinned in setup-gate-indeterminate.test.ts), and the shell's
//      indeterminate recovery. What `cache()` buys is same-render consistency
//      plus the dedupe of a repeated credential read.
//
//   2. SAME VERDICT ON THAT INPUT — given identical steps, "complete" and "no
//      first incomplete step" must be the same answer. They are separately
//      implemented (`isStepsComplete` enumerates specific step ids; the other
//      scans for any `!ready`), so a future step added to the list but not to
//      the enumeration would silently resurrect the split brain.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => identityState.value),
}));

const identityState = { value: null as unknown };
const hasUsersState = { value: true };
vi.mock("@/lib/auth", () => ({
  hasAnyBetterAuthUsers: () => Promise.resolve(hasUsersState.value),
}));

vi.mock("@cinatra-ai/openai-connector", () => ({
  isOpenAIConnectionReady: () => false,
  getConfiguredOpenAIConnection: async () => undefined,
}));

const nangoState = { connected: true };
vi.mock("@/lib/nango-system", () => ({
  getNangoStatus: () => ({ status: nangoState.connected ? "connected" : "not_connected" }),
}));

const readinessState = { ready: true };
vi.mock("@/lib/setup-provider-commit", () => ({
  deriveSetupAiStepState: async () => ({
    ready: readinessState.ready,
    locked: readinessState.ready,
    credentialFresh: readinessState.ready,
    commitState: { kind: readinessState.ready ? "committed" : "absent" },
  }),
}));

import {
  evaluateSetupGate,
  getFirstIncompleteStep,
  getSetupWizardSteps,
} from "@/lib/setup-wizard";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const ORIGINAL_KEY = process.env.CINATRA_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.CINATRA_ENCRYPTION_KEY = "k".repeat(32);
  delete process.env.CINATRA_E2E_SETUP_BYPASS;
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.CINATRA_ENCRYPTION_KEY;
  else process.env.CINATRA_ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe("half 1 — one derivation per request", () => {
  it("exports getSetupWizardSteps through React cache()", () => {
    const source = readFileSync(path.join(REPO_ROOT, "src/lib/setup-wizard.ts"), "utf8");
    expect(source).toMatch(/import \{ cache \} from "react"/);
    expect(source).toMatch(/export const getSetupWizardSteps = cache\(computeSetupWizardSteps\)/);
  });

  it("has the root layout read the non-throwing gate, not the raw boolean", () => {
    const layout = readFileSync(path.join(REPO_ROOT, "src/app/layout.tsx"), "utf8");
    expect(layout).toMatch(/evaluateSetupGate\(\)/);
    // The un-guarded call that used to reject the whole Promise.all.
    expect(layout).not.toMatch(/isSetupWizardComplete\(\)/);
    // And only a real "incomplete" may withhold the shell.
    expect(layout).toMatch(/setupGate !== "incomplete"/);
  });

  it("has /setup route off the shared step reader", () => {
    const page = readFileSync(path.join(REPO_ROOT, "src/app/setup/page.tsx"), "utf8");
    expect(page).toMatch(/getSetupWizardSteps\(\)/);
  });

  it("hands the indeterminate state to the shell so a fail-open guess cannot stick", () => {
    // A root layout is not re-rendered by ordinary client navigation, so the
    // fail-open verdict would otherwise sit in the router cache until a hard
    // reload. This asserts only the WIRING (layout → shell → hook); the hook's
    // exactly-once behaviour, including under StrictMode, is a real render test
    // in src/components/__tests__/setup-gate-recovery.test.tsx.
    const layout = readFileSync(path.join(REPO_ROOT, "src/app/layout.tsx"), "utf8");
    expect(layout).toMatch(/setupGateIndeterminate=\{setupGateIndeterminate\}/);

    const shell = readFileSync(path.join(REPO_ROOT, "src/components/app-shell.tsx"), "utf8");
    expect(shell).toMatch(/useSetupGateRecovery\(setupGateIndeterminate, refreshRoute\)/);
    expect(shell).toMatch(/router\.refresh\(\)/);
  });
});

describe("half 2 — the two gates agree on identical steps", () => {
  const matrix: Array<{
    name: string;
    hasUsers: boolean;
    identity: unknown;
    nango: boolean;
    ai: boolean;
  }> = [
    { name: "fully configured", hasUsers: true, identity: { i: 1 }, nango: true, ai: true },
    { name: "no account yet", hasUsers: false, identity: { i: 1 }, nango: true, ai: true },
    { name: "no instance identity", hasUsers: true, identity: null, nango: true, ai: true },
    { name: "nango not connected", hasUsers: true, identity: { i: 1 }, nango: false, ai: true },
    { name: "model step not ready", hasUsers: true, identity: { i: 1 }, nango: true, ai: false },
    { name: "nothing configured", hasUsers: false, identity: null, nango: false, ai: false },
    { name: "only the model missing", hasUsers: true, identity: { i: 1 }, nango: true, ai: false },
  ];

  for (const row of matrix) {
    it(`agrees for: ${row.name}`, async () => {
      hasUsersState.value = row.hasUsers;
      identityState.value = row.identity;
      nangoState.connected = row.nango;
      readinessState.ready = row.ai;

      const shellSaysComplete = (await evaluateSetupGate()) === "complete";
      const setupPageSaysComplete =
        getFirstIncompleteStep(await getSetupWizardSteps()) === null;

      // Disagreement here IS the redirect loop: the shell would send the user
      // to /setup while /setup sent them back to /.
      expect(shellSaysComplete).toBe(setupPageSaysComplete);
    });
  }

  it("also agrees when the encryption key — a non-step precondition — is absent", async () => {
    delete process.env.CINATRA_ENCRYPTION_KEY;
    hasUsersState.value = true;
    identityState.value = { i: 1 };
    nangoState.connected = true;
    readinessState.ready = true;

    const shellSaysComplete = (await evaluateSetupGate()) === "complete";
    const setupPageSaysComplete =
      getFirstIncompleteStep(await getSetupWizardSteps()) === null;

    expect(shellSaysComplete).toBe(false);
    expect(shellSaysComplete).toBe(setupPageSaysComplete);
  });
});

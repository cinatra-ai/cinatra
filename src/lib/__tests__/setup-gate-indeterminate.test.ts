// cinatra#2503 — the shell gate must distinguish "not set up" from "could not
// find out".
//
// The `/ ↔ /setup` redirect loop came from conflating the two. A transient
// Postgres refusal made the completeness read throw; the root layout's
// `Promise.all` rejected; `setupComplete` fell back to its `false` default; the
// shell redirected a fully-configured instance to `/setup`; the INDEPENDENT
// gate on `/setup` re-derived a moment later, got a healthy read, concluded
// "complete", and redirected back to `/`. Repeat until the backend settled.
//
// These tests pin the two halves of the fix:
//   1. `evaluateSetupGate()` never throws and reports `indeterminate` — never
//      `incomplete` — when the derivation fails.
//   2. `isSetupWizardComplete()` still PROPAGATES the failure, because its API
//      callers must not silently read a blip as "not complete".
//
// The per-request sharing half (React `cache`) is asserted structurally in
// setup-gate-shared-derivation.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => ({ instanceNamespace: "acme" })),
}));

const hasUsersState = { value: true, throws: false };
vi.mock("@/lib/auth", () => ({
  hasAnyBetterAuthUsers: () => {
    if (hasUsersState.throws) {
      return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5434"));
    }
    return Promise.resolve(hasUsersState.value);
  },
}));

vi.mock("@cinatra-ai/openai-connector", () => ({
  isOpenAIConnectionReady: () => false,
  getConfiguredOpenAIConnection: async () => undefined,
}));
vi.mock("@/lib/nango-system", () => ({
  getNangoStatus: () => ({ status: "connected" }),
}));

const readinessState = { ready: true as boolean };
vi.mock("@/lib/setup-provider-commit", () => ({
  deriveSetupAiStepState: async () => ({
    ready: readinessState.ready,
    locked: readinessState.ready,
    credentialFresh: readinessState.ready,
    commitState: { kind: readinessState.ready ? "committed" : "absent" },
  }),
}));

import { evaluateSetupGate, isSetupWizardComplete } from "@/lib/setup-wizard";

const ORIGINAL_KEY = process.env.CINATRA_ENCRYPTION_KEY;
const ORIGINAL_BYPASS = process.env.CINATRA_E2E_SETUP_BYPASS;

beforeEach(() => {
  process.env.CINATRA_ENCRYPTION_KEY = "k".repeat(32);
  delete process.env.CINATRA_E2E_SETUP_BYPASS;
  hasUsersState.value = true;
  hasUsersState.throws = false;
  readinessState.ready = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.CINATRA_ENCRYPTION_KEY;
  else process.env.CINATRA_ENCRYPTION_KEY = ORIGINAL_KEY;
  if (ORIGINAL_BYPASS === undefined) delete process.env.CINATRA_E2E_SETUP_BYPASS;
  else process.env.CINATRA_E2E_SETUP_BYPASS = ORIGINAL_BYPASS;
  vi.restoreAllMocks();
});

describe("evaluateSetupGate — the three states", () => {
  it("reports complete when every step reads ready", async () => {
    await expect(evaluateSetupGate()).resolves.toBe("complete");
  });

  it("reports incomplete when a step genuinely is not ready", async () => {
    readinessState.ready = false;
    await expect(evaluateSetupGate()).resolves.toBe("incomplete");
  });

  it("reports INDETERMINATE — not incomplete — when the read throws", async () => {
    hasUsersState.throws = true;
    // The whole bug in one assertion: a DB refusal must not be spelled
    // "this instance is not set up".
    await expect(evaluateSetupGate()).resolves.toBe("indeterminate");
  });

  it("never rejects, so it cannot take down the layout's Promise.all", async () => {
    hasUsersState.throws = true;
    await expect(evaluateSetupGate()).resolves.toBeTypeOf("string");
  });

  it("logs the underlying failure rather than swallowing it", async () => {
    hasUsersState.throws = true;
    await evaluateSetupGate();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("INDETERMINATE"),
      expect.any(Error),
    );
  });

  it("honours the e2e bypass without touching the backend at all", async () => {
    process.env.CINATRA_E2E_SETUP_BYPASS = "true";
    hasUsersState.throws = true;
    await expect(evaluateSetupGate()).resolves.toBe("complete");
  });
});

describe("the shell's redirect predicate over the gate states", () => {
  // Mirrors src/app/layout.tsx: `connectionReady = setupGate !== "incomplete"`,
  // and app-shell redirects to /setup only when !connectionReady.
  const redirectsToSetup = (gate: string) => !(gate !== "incomplete");
  // ...and the companion flag that makes the fail-open guess recoverable.
  const asksForRerender = (gate: string) => gate === "indeterminate";

  it("redirects ONLY on a real incomplete", () => {
    expect(redirectsToSetup("incomplete")).toBe(true);
    expect(redirectsToSetup("complete")).toBe(false);
    // The loop-breaker: an error-derived verdict never forces the wizard.
    expect(redirectsToSetup("indeterminate")).toBe(false);
  });

  it("asks for exactly one re-derivation on indeterminate, and never otherwise", () => {
    // Fail-open is a guess, not a verdict, so it must not be allowed to stick
    // in the router cache — but a determinate answer must not trigger churn.
    expect(asksForRerender("indeterminate")).toBe(true);
    expect(asksForRerender("complete")).toBe(false);
    expect(asksForRerender("incomplete")).toBe(false);
  });
});

describe("isSetupWizardComplete — unchanged propagation for API callers", () => {
  it("still throws on a failed read (callers must see the blip, not a false)", async () => {
    hasUsersState.throws = true;
    await expect(isSetupWizardComplete()).rejects.toThrow(/ECONNREFUSED/);
  });

  it("still answers true/false normally", async () => {
    await expect(isSetupWizardComplete()).resolves.toBe(true);
    readinessState.ready = false;
    await expect(isSetupWizardComplete()).resolves.toBe(false);
  });
});

/**
 * SETUP AI-STEP SERVER ACTIONS — the two operator-facing failure paths the
 * render-proof lane found on PR #2213's own surface (cinatra#2093, epic #2086
 * S6).
 *
 * F1 — the Anthropic key save. The connector's writer hard-requires a
 *      configured connection service, and an unconfigured one is the NORMAL
 *      pre-setup state, so the throw was reaching the operator as an unhandled
 *      server error. These pin BOTH arms: the failure becomes an in-page
 *      actionable record plus the wizard's codes-only flash, and the success
 *      path still clears the stale record and forwards.
 *
 * F2 — the readiness failure's fix-forward. Its only remedy is flipping the
 *      stored MCP mode, which nothing in the product could perform. These pin
 *      the action that performs it.
 *
 * There is no DOM runner in this workspace (see setup/key/__tests__), so the
 * RENDERED states are proven by the live walk in evidence/2093-s6-setup; what
 * is pinned here is the behaviour those renders read from.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// `redirect()` reports by THROWING a tagged error — mirror that, or the actions
// under test would keep executing past a redirect exactly where production
// stops.
class RedirectSignal extends Error {
  digest: string;
  constructor(public url: string) {
    super(`NEXT_REDIRECT:${url}`);
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

const writeConnectorConfigToDatabase = vi.fn();
// S5 (cinatra#2390): the ONE-transaction workspace-opt-in + bulk-consent
// writer the typed Anthropic save action calls.
const grantSetupConsentWithWorkspaceOptInInDatabase = vi.fn();
vi.mock("@/lib/anthropic-setup-consent-store", () => ({
  grantSetupConsentWithWorkspaceOptInInDatabase: (...args: unknown[]) =>
    grantSetupConsentWithWorkspaceOptInInDatabase(...args),
}));
// `readiness-state.ts` is kept REAL (for its config keys, its step id, and its
// failure reader), so this stands in for the durable store it reads through.
const storedConfig = new Map<string, unknown>();
vi.mock("@/lib/database", () => ({
  writeConnectorConfigToDatabase: (...args: unknown[]) =>
    writeConnectorConfigToDatabase(...args),
  readConnectorConfigFromDatabase: (key: string, fallback: unknown) =>
    storedConfig.has(key) ? storedConfig.get(key) : fallback,
}));

// S5 (cinatra#2390): the host-owned typed writer, stubbed at its seam — its
// own dispatch/validation/sanitization contract is pinned by
// setup-provider-connection-writer.test.ts.
const saveSetupProviderConnection = vi.fn<
  (provider: string, values: Record<string, string>) => Promise<unknown>
>(async () => ({ ok: true, code: "saved", sanitizedMessage: null }));
vi.mock("@/lib/setup-provider-connection-writer", () => ({
  saveSetupProviderConnection: (provider: string, values: Record<string, string>) =>
    saveSetupProviderConnection(provider, values),
}));

const isNangoConfigured = vi.fn(() => true);
vi.mock("@/lib/nango-system", () => ({
  isNangoConfigured: () => isNangoConfigured(),
}));

const saveAPISettings = vi.fn(async () => ({}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: (providerId: string) =>
    providerId === "anthropic" ? { providerId, saveAPISettings } : null,
}));

const writeAnthropicMcpMode = vi.fn();
const clearSetupReadinessReceipt = vi.fn();
const readAnthropicMcpMode = vi.fn(() => "function-tools");
// Stands in for the REAL sanitizer (whose redaction is pinned by
// setup-readiness-saga.test.ts) with a marker, so this file can prove the
// ACTION's own obligation: that nothing reaches durable state — or the LOGS —
// unsanitized.
const sanitizeReadinessMessage = vi.fn((text: string) => `[sanitized]${text.trim().slice(0, 400)}`);
vi.mock("@/lib/setup-readiness-saga", () => ({
  runSetupReadinessSaga: vi.fn(),
  sanitizeReadinessMessage: (text: string) => sanitizeReadinessMessage(text),
  writeAnthropicMcpMode: (mode: string) => writeAnthropicMcpMode(mode),
  clearSetupReadinessReceipt: () => clearSetupReadinessReceipt(),
  readAnthropicMcpMode: () => readAnthropicMcpMode(),
}));

vi.mock("@/lib/setup-readiness-ports", () => ({
  createSetupReadinessPorts: vi.fn(() => ({})),
}));

// S3 (cinatra#2388): the provider-commit machine, stubbed at its seam. The
// machine's own fencing/compensation rules are pinned by
// setup-provider-commit.test.ts; here it stands in as controllable state so
// the ACTIONS' refusal/redirect protocol can be proven.
const commitMachineState = {
  snapshot: { raw: null as string | null, state: { kind: "absent" } as Record<string, unknown> },
};
const beginSetupProviderClaim = vi.fn<(arg: unknown) => unknown>();
const commitSetupProviderClaim = vi.fn<(arg: unknown) => unknown>();
const releaseSetupProviderClaim = vi.fn<(arg: unknown) => boolean>(() => true);
const refreshCommittedCredentialFingerprint = vi.fn<(arg: unknown) => boolean>(() => true);
const compensateOwnedSetupCommitment = vi.fn<(arg: unknown) => boolean>(() => true);
vi.mock("@/lib/setup-provider-commit", () => ({
  readSetupProviderCommitSnapshot: () => commitMachineState.snapshot,
  readSetupProviderCommitState: () => commitMachineState.snapshot.state,
  beginSetupProviderClaim: (arg: unknown) => beginSetupProviderClaim(arg),
  commitSetupProviderClaim: (arg: unknown) => commitSetupProviderClaim(arg),
  releaseSetupProviderClaim: (arg: unknown) => releaseSetupProviderClaim(arg),
  refreshCommittedCredentialFingerprint: (arg: unknown) =>
    refreshCommittedCredentialFingerprint(arg),
  compensateOwnedSetupCommitment: (arg: unknown) => compensateOwnedSetupCommitment(arg),
}));

vi.mock("@/lib/llm-credential-fingerprint", () => ({
  readLiveCredentialFingerprint: async () => ({
    status: "readable",
    fingerprint: "cfv1:test",
  }),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({ user: { id: "user_admin" } })),
  getActorContext: vi.fn(async () => ({ userId: "user_admin" })),
}));

vi.mock("@/lib/admin/default-llm-provider-mutation", () => ({
  updateDefaultLlmProvider: vi.fn(async () => undefined),
}));

vi.mock("@cinatra-ai/sdk-extensions/llm-provider-contract", () => ({
  buildKnownWizardEligibleProviders: () => ["openai", "anthropic"],
}));

import {
  saveSetupAnthropicConnectionAction,
  saveSetupOpenAIConnectionAction,
  enableAnthropicNativeSkillDeliveryAction,
  selectSetupProviderAction,
  completeAiSetupAction,
} from "@/app/setup/model/actions";
import { runSetupReadinessSaga } from "@/lib/setup-readiness-saga";
import {
  ANTHROPIC_SETUP_CONSENT_FIELD,
  SETUP_READINESS_FAILURE_CONFIG_KEY,
} from "@/app/setup/model/readiness-state";

/** Run an action and return the URL it redirected to (failing if it did not). */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.url;
    throw err;
  }
  throw new Error("the action returned without redirecting");
}

function keyForm(apiKey: string): FormData {
  const form = new FormData();
  form.set("apiKey", apiKey);
  return form;
}

/** The last value written under the failure key (null when it was cleared). */
function lastFailureRecord() {
  const writes = writeConnectorConfigToDatabase.mock.calls.filter(
    (call) => call[0] === SETUP_READINESS_FAILURE_CONFIG_KEY,
  );
  return writes.length ? writes[writes.length - 1][1] : undefined;
}

/** Put a standing `native-skills-probe` failure in the store. */
function standingProbeFailure() {
  storedConfig.set(SETUP_READINESS_FAILURE_CONFIG_KEY, {
    step: "native-skills-probe",
    message: "Anthropic rejected a container.skills request.",
    fixForward: "Use “Switch to native MCP delivery” below…",
    at: "2026-07-29T10:00:00.000Z",
  });
}

let errorLogArgs: unknown[][];

beforeEach(() => {
  vi.clearAllMocks();
  storedConfig.clear();
  commitMachineState.snapshot = { raw: null, state: { kind: "absent" } };
  releaseSetupProviderClaim.mockReturnValue(true);
  refreshCommittedCredentialFingerprint.mockReturnValue(true);
  isNangoConfigured.mockReturnValue(true);
  saveAPISettings.mockImplementation(async () => ({}));
  readAnthropicMcpMode.mockReturnValue("function-tools");
  errorLogArgs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLogArgs.push(args);
  });
});

// ---------------------------------------------------------------------------
// S5 (cinatra#2390) — the TYPED setup save actions: `{ok, code,
// sanitizedMessage}` results, NEVER a redirect, NEVER error text in a URL or
// in durable state.
// ---------------------------------------------------------------------------

function consentedKeyForm(apiKey: string): FormData {
  const form = keyForm(apiKey);
  form.set(ANTHROPIC_SETUP_CONSENT_FIELD, "on");
  return form;
}

describe("S5 — saveSetupAnthropicConnectionAction: typed, consent-aware", () => {
  it("REQUIRES the literal consent input — no checkbox, no save, typed refusal", async () => {
    const result = await saveSetupAnthropicConnectionAction(null, keyForm("sk-ant-live"));
    expect(result).toMatchObject({ ok: false, code: "consent-required" });
    expect(saveSetupProviderConnection).not.toHaveBeenCalled();
    expect(grantSetupConsentWithWorkspaceOptInInDatabase).not.toHaveBeenCalled();
  });

  it("a blank key is a typed refusal before anything is touched", async () => {
    const result = await saveSetupAnthropicConnectionAction(null, consentedKeyForm("   "));
    expect(result).toMatchObject({ ok: false, code: "key-missing" });
    expect(saveSetupProviderConnection).not.toHaveBeenCalled();
  });

  it("SUCCESS: saves through the typed writer, then lands the opt-in + bulk grant in ONE transactional call attributed to the acting admin", async () => {
    const result = await saveSetupAnthropicConnectionAction(null, consentedKeyForm("sk-ant-live"));

    expect(saveSetupProviderConnection).toHaveBeenCalledWith("anthropic", {
      apiKey: "sk-ant-live",
    });
    // Actor attribution: the admin session's user id, never null-by-default.
    expect(grantSetupConsentWithWorkspaceOptInInDatabase).toHaveBeenCalledWith("user_admin");
    // The consent lands AFTER the key save succeeded, never before.
    expect(
      saveSetupProviderConnection.mock.invocationCallOrder[0],
    ).toBeLessThan(grantSetupConsentWithWorkspaceOptInInDatabase.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ ok: true, code: "saved" });
    // A stale failure record is cleared — parity with the retired action.
    expect(lastFailureRecord()).toBeNull();
  });

  it("a FAILED key save returns the writer's typed failure and NEVER touches consent or durable state", async () => {
    saveSetupProviderConnection.mockResolvedValueOnce({
      ok: false,
      code: "save-failed",
      sanitizedMessage: "[sanitized]Anthropic rejected the key (401).",
    });

    const result = await saveSetupAnthropicConnectionAction(null, consentedKeyForm("sk-ant-bad"));

    expect(result).toMatchObject({ ok: false, code: "save-failed" });
    expect(grantSetupConsentWithWorkspaceOptInInDatabase).not.toHaveBeenCalled();
    // NOTHING durable: the sanitized message exists only in the typed result
    // (the toast) — the pre-S5 durable failure record is retired for saves.
    expect(lastFailureRecord()).toBeUndefined();
  });

  it("an UNCONFIGURED connection service keeps its fix-forward naming the Secrets step (decided from the LIVE nango status)", async () => {
    isNangoConfigured.mockReturnValue(false);
    saveSetupProviderConnection.mockResolvedValueOnce({
      ok: false,
      code: "save-failed",
      sanitizedMessage: "[sanitized]connection service unavailable",
    });

    const result = await saveSetupAnthropicConnectionAction(null, consentedKeyForm("sk-ant-live"));
    expect(result.ok).toBe(false);
    expect(result.sanitizedMessage).toContain("Secrets");
  });

  it("a FAILED consent transaction is a typed failure — the opt-in is all-or-nothing, and the sanitized copy blocks nothing else", async () => {
    grantSetupConsentWithWorkspaceOptInInDatabase.mockImplementationOnce(() => {
      throw new Error("deadlock detected around authorization: sk-ant-SECRETVALUE01234567890");
    });

    const result = await saveSetupAnthropicConnectionAction(null, consentedKeyForm("sk-ant-live"));

    expect(result).toMatchObject({ ok: false, code: "consent-write-failed" });
    // The thrown message went through the sanitizer before joining the copy.
    expect(result.sanitizedMessage).toContain("[sanitized]");
    // The server log too: sanitized strings only, never the raw Error.
    expect(errorLogArgs.length).toBe(1);
    for (const arg of errorLogArgs[0]) {
      expect(arg).not.toBeInstanceOf(Error);
      expect(typeof arg).toBe("string");
    }
    // No success-path cleanup ran — the durable failure key was not touched.
    expect(lastFailureRecord()).toBeUndefined();
  });

  it("NEVER redirects — the typed result is the only channel (no error text can reach a URL)", async () => {
    for (const form of [
      keyForm("sk-ant-live"), // consent missing
      consentedKeyForm("   "), // key missing
      consentedKeyForm("sk-ant-live"), // success
    ]) {
      // A redirect would THROW (RedirectSignal); a clean return proves none.
      await expect(saveSetupAnthropicConnectionAction(null, form)).resolves.toBeTruthy();
    }
  });
});

describe("S5 — saveSetupOpenAIConnectionAction: typed, no redirect", () => {
  it("collects the connection fields into the writer's flat values map", async () => {
    const form = new FormData();
    form.set("apiKey", "sk-live");
    form.set("projectId", "proj_1");
    form.set("organizationId", "org_1");

    const result = await saveSetupOpenAIConnectionAction(null, form);

    expect(saveSetupProviderConnection).toHaveBeenCalledWith("openai", {
      apiKey: "sk-live",
      projectId: "proj_1",
      organizationId: "org_1",
    });
    expect(result).toMatchObject({ ok: true, code: "saved" });
  });

  it("returns the writer's typed failure verbatim — no redirect, no durable write", async () => {
    saveSetupProviderConnection.mockResolvedValueOnce({
      ok: false,
      code: "save-rejected",
      sanitizedMessage: "The connector did not accept the connection settings.",
    });
    const result = await saveSetupOpenAIConnectionAction(null, keyForm("sk-bad"));
    expect(result).toMatchObject({ ok: false, code: "save-rejected" });
    expect(writeConnectorConfigToDatabase).not.toHaveBeenCalled();
  });
});

describe("F2 — enableAnthropicNativeSkillDeliveryAction: the fix-forward is performable", () => {
  it("sets the stored MCP mode to native, clears the resolved failure, and returns to the step", async () => {
    standingProbeFailure();

    const url = await redirectOf(() => enableAnthropicNativeSkillDeliveryAction());

    expect(writeAnthropicMcpMode).toHaveBeenCalledWith("native");
    expect(lastFailureRecord()).toBeNull();
    expect(url).toBe("/setup/model?stay=1");
  });

  it("does NOT commit a provider or write a receipt — the operator re-runs the verification", async () => {
    standingProbeFailure();

    await redirectOf(() => enableAnthropicNativeSkillDeliveryAction());

    const touchedKeys = writeConnectorConfigToDatabase.mock.calls.map((call) => call[0]);
    // The ONLY durable connector-config write from this action, besides the
    // mode itself, is clearing the failure it resolves. A receipt must still be
    // earned.
    expect(touchedKeys).toEqual([SETUP_READINESS_FAILURE_CONFIG_KEY]);
  });

  it("CLEARS THE RECEIPT — so flipping back to a mode an old receipt was earned under cannot resurrect it", async () => {
    // The mode is a readiness-fingerprint input, so a receipt earned under it
    // reads as merely INVALID, not deleted, while the mode differs. Restoring
    // the mode would restore the fingerprint — and setup would read ready on a
    // probe that failed. This is the arm that prevents that.
    standingProbeFailure();

    await redirectOf(() => enableAnthropicNativeSkillDeliveryAction());

    expect(clearSetupReadinessReceipt).toHaveBeenCalledTimes(1);
    // And BEFORE the mode changes, so no ordering of crashes leaves
    // mode-changed with a stale receipt behind it.
    expect(clearSetupReadinessReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      writeAnthropicMcpMode.mock.invocationCallOrder[0],
    );
  });

  it("refuses to change the mode when the receipt could NOT be cleared (fail-closed)", async () => {
    standingProbeFailure();
    clearSetupReadinessReceipt.mockImplementationOnce(() => {
      throw new Error("config store unavailable");
    });

    const url = await redirectOf(() => enableAnthropicNativeSkillDeliveryAction());

    expect(writeAnthropicMcpMode).not.toHaveBeenCalled();
    expect(url).toBe("/setup/model?stay=1&error=setup-mcp-mode-switch-failed");
  });

  it("re-checks the standing condition AT MUTATION TIME: an UNRELATED failure is not erased", async () => {
    // A stale form, a double submit, or a direct invocation arrives after the
    // world moved. The failure record is a single global key, so acting on a
    // stale render would wipe an error the operator still has to act on.
    storedConfig.set(SETUP_READINESS_FAILURE_CONFIG_KEY, {
      step: "credential-validation",
      message: "The OpenAI key could not be validated.",
      fixForward: null,
      at: "2026-07-29T10:05:00.000Z",
    });

    const url = await redirectOf(() => enableAnthropicNativeSkillDeliveryAction());

    expect(url).toBe("/setup/model?stay=1");
    expect(writeAnthropicMcpMode).not.toHaveBeenCalled();
    expect(clearSetupReadinessReceipt).not.toHaveBeenCalled();
    expect(writeConnectorConfigToDatabase).not.toHaveBeenCalled();
  });

  it("re-checks the STORED MODE too: a double submit after the switch mutates nothing", async () => {
    standingProbeFailure();
    readAnthropicMcpMode.mockReturnValue("native");

    const url = await redirectOf(() => enableAnthropicNativeSkillDeliveryAction());

    expect(url).toBe("/setup/model?stay=1");
    expect(writeAnthropicMcpMode).not.toHaveBeenCalled();
    expect(writeConnectorConfigToDatabase).not.toHaveBeenCalled();
  });

  it("is ADMIN-GATED before it mutates anything", async () => {
    const { requireAdminSession } = await import("@/lib/auth-session");
    vi.mocked(requireAdminSession).mockRejectedValueOnce(new Error("not an admin"));
    standingProbeFailure();

    await expect(enableAnthropicNativeSkillDeliveryAction()).rejects.toThrow("not an admin");
    expect(clearSetupReadinessReceipt).not.toHaveBeenCalled();
    expect(writeAnthropicMcpMode).not.toHaveBeenCalled();
    expect(writeConnectorConfigToDatabase).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// S3 (cinatra#2388) — the actions honor the provider-commit machine.
// ---------------------------------------------------------------------------

function providerForm(provider: string): FormData {
  const form = new FormData();
  form.set("provider", provider);
  return form;
}

describe("S3 — selectSetupProviderAction refuses switches under the machine", () => {
  it("refuses ANY selection while a claim is pending", async () => {
    commitMachineState.snapshot = {
      raw: "{}",
      state: { kind: "claim-pending", claim: { actorId: "someone" } },
    };
    const url = await redirectOf(() => selectSetupProviderAction(providerForm("openai")));
    expect(url).toBe("/setup/model?stay=1&error=setup-provider-claim-pending");
    // The stored pick was NOT written.
    expect(
      writeConnectorConfigToDatabase.mock.calls.filter(
        (c) => c[0] === "setup_provider_selection",
      ),
    ).toHaveLength(0);
  });

  it("refuses switching AWAY from a committed provider, allows re-selecting it", async () => {
    commitMachineState.snapshot = {
      raw: "{}",
      state: { kind: "committed", commitment: { provider: "anthropic" } },
    };
    const refused = await redirectOf(() => selectSetupProviderAction(providerForm("openai")));
    expect(refused).toBe("/setup/model?stay=1&error=setup-provider-locked");
    const allowed = await redirectOf(() => selectSetupProviderAction(providerForm("anthropic")));
    expect(allowed).toBe("/setup/model?stay=1");
  });
});

describe("S3 — completeAiSetupAction under the machine", () => {
  it("refuses Continue while a claim is pending (no saga run, no claim taken)", async () => {
    commitMachineState.snapshot = {
      raw: "{}",
      state: { kind: "claim-pending", claim: { actorId: "someone" } },
    };
    const url = await redirectOf(() => completeAiSetupAction(providerForm("openai")));
    expect(url).toBe("/setup/model?stay=1&error=setup-provider-claim-pending");
    expect(beginSetupProviderClaim).not.toHaveBeenCalled();
    expect(vi.mocked(runSetupReadinessSaga)).not.toHaveBeenCalled();
  });

  it("refuses Continue for a provider DIFFERENT from the committed one (the lock)", async () => {
    commitMachineState.snapshot = {
      raw: "{}",
      state: { kind: "committed", commitment: { provider: "anthropic" } },
    };
    const url = await redirectOf(() => completeAiSetupAction(providerForm("openai")));
    expect(url).toBe("/setup/model?stay=1&error=setup-provider-locked");
    expect(vi.mocked(runSetupReadinessSaga)).not.toHaveBeenCalled();
  });

  it("absent state: claims, and RELEASES the claim when the saga reports failure", async () => {
    beginSetupProviderClaim.mockReturnValue({
      ok: true,
      claim: { nonce: "nonce-1", priorDefault: "openai" },
    });
    vi.mocked(runSetupReadinessSaga).mockResolvedValue({
      ok: false,
      failure: {
        step: "credential-validation",
        message: "no key",
        compensation: "setup-incomplete",
      },
    } as never);
    const url = await redirectOf(() => completeAiSetupAction(providerForm("openai")));
    expect(url).toBe("/setup/model?stay=1&error=setup-readiness-failed");
    expect(beginSetupProviderClaim).toHaveBeenCalledTimes(1);
    expect(releaseSetupProviderClaim).toHaveBeenCalledWith({ nonce: "nonce-1" });
  });

  it("S5: committing ANTHROPIC migrates the connector's MCP mode to native FIRST (receipt cleared before the flip)", async () => {
    readAnthropicMcpMode.mockReturnValue("function-tools");
    beginSetupProviderClaim.mockReturnValue({
      ok: true,
      claim: { nonce: "nonce-a", priorDefault: "openai" },
    });
    vi.mocked(runSetupReadinessSaga).mockResolvedValue({
      ok: true,
      receipt: {},
    } as never);

    const url = await redirectOf(() => completeAiSetupAction(providerForm("anthropic")));
    // S4 (cinatra#2389): a SUCCESSFUL Continue-commit advances (no `stay=1`) —
    // the step's auto-forward carries the operator onward.
    expect(url).toBe("/setup/model");

    expect(writeAnthropicMcpMode).toHaveBeenCalledWith("native");
    // Resurrection guard: the mode is a fingerprint input, so the receipt is
    // cleared BEFORE the mode changes — same ordering as the F2 action.
    expect(clearSetupReadinessReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      writeAnthropicMcpMode.mock.invocationCallOrder[0],
    );
    // And BEFORE the machine is entered, so the readiness fingerprint this run
    // earns is computed under the mode the commit leaves behind.
    expect(writeAnthropicMcpMode.mock.invocationCallOrder[0]).toBeLessThan(
      beginSetupProviderClaim.mock.invocationCallOrder[0],
    );
  });

  it("S5: an ALREADY-NATIVE mode is left untouched (idempotent commit, no receipt churn)", async () => {
    readAnthropicMcpMode.mockReturnValue("native");
    beginSetupProviderClaim.mockReturnValue({
      ok: true,
      claim: { nonce: "nonce-b", priorDefault: "openai" },
    });
    vi.mocked(runSetupReadinessSaga).mockResolvedValue({
      ok: true,
      receipt: {},
    } as never);

    await redirectOf(() => completeAiSetupAction(providerForm("anthropic")));
    expect(writeAnthropicMcpMode).not.toHaveBeenCalled();
    expect(clearSetupReadinessReceipt).not.toHaveBeenCalled();
  });

  it("S5: an OPENAI commit never touches the Anthropic MCP mode", async () => {
    beginSetupProviderClaim.mockReturnValue({
      ok: true,
      claim: { nonce: "nonce-c", priorDefault: "openai" },
    });
    vi.mocked(runSetupReadinessSaga).mockResolvedValue({
      ok: true,
      receipt: {},
    } as never);

    await redirectOf(() => completeAiSetupAction(providerForm("openai")));
    expect(writeAnthropicMcpMode).not.toHaveBeenCalled();
  });

  it("S5: a FAILED mode migration is reported through the codes-only flash and stops before the machine", async () => {
    readAnthropicMcpMode.mockReturnValue("function-tools");
    writeAnthropicMcpMode.mockImplementationOnce(() => {
      throw new Error("config store unavailable");
    });

    const url = await redirectOf(() => completeAiSetupAction(providerForm("anthropic")));
    expect(url).toBe("/setup/model?stay=1&error=setup-mcp-mode-switch-failed");
    expect(beginSetupProviderClaim).not.toHaveBeenCalled();
    expect(vi.mocked(runSetupReadinessSaga)).not.toHaveBeenCalled();
  });

  it("committed-same re-verify: NO claim is taken and success refreshes the stored fingerprint", async () => {
    commitMachineState.snapshot = {
      raw: '{"stored":"commitment"}',
      state: { kind: "committed", commitment: { provider: "openai" } },
    };
    vi.mocked(runSetupReadinessSaga).mockResolvedValue({
      ok: true,
      receipt: {},
    } as never);
    const url = await redirectOf(() => completeAiSetupAction(providerForm("openai")));
    // S4 (cinatra#2389): success advances — no `stay=1` on the redirect.
    expect(url).toBe("/setup/model");
    expect(beginSetupProviderClaim).not.toHaveBeenCalled();
    expect(refreshCommittedCredentialFingerprint).toHaveBeenCalledWith({
      expectedRaw: '{"stored":"commitment"}',
      commitment: { provider: "openai" },
      credentialFingerprint: "cfv1:test",
    });
  });
});

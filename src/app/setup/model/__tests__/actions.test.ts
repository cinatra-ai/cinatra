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
// The workspace upload opt-in: the SAME authority the step's Anthropic section
// uses to decide whether to render the consent control, so the fold's "is the
// consent required?" question has exactly one answer on both sides.
const isAnthropicUploadOptInStanding = vi.fn(() => false);
vi.mock("@/lib/setup-readiness-saga", () => ({
  runSetupReadinessSaga: vi.fn(),
  sanitizeReadinessMessage: (text: string) => sanitizeReadinessMessage(text),
  writeAnthropicMcpMode: (mode: string) => writeAnthropicMcpMode(mode),
  clearSetupReadinessReceipt: () => clearSetupReadinessReceipt(),
  readAnthropicMcpMode: () => readAnthropicMcpMode(),
  isAnthropicUploadOptInStanding: () => isAnthropicUploadOptInStanding(),
}));

// The real ports object carries the injected `setDefaultProvider` — the ATOMIC
// SETUP SINK the saga awaits. Kept addressable here so a "successful saga" in
// these tests actually drives the sink, which is what consumes the claim.
const capturedPorts: { setDefaultProvider?: (p: string) => Promise<void> } = {};
vi.mock("@/lib/setup-readiness-ports", () => ({
  createSetupReadinessPorts: vi.fn((options?: { setDefaultProvider?: (p: string) => Promise<void> }) => {
    capturedPorts.setDefaultProvider = options?.setDefaultProvider;
    return {} as Record<string, unknown>;
  }),
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

// The LIVE credential read. Controllable because the fold consults it to tell
// "the operator left the key blank because one is already stored" from "the
// operator left the key blank and there is nothing to verify".
const liveFingerprint = vi.fn<() => Promise<Record<string, unknown>>>(async () => ({
  status: "readable",
  fingerprint: "cfv1:test",
}));
vi.mock("@/lib/llm-credential-fingerprint", () => ({
  readLiveCredentialFingerprint: () => liveFingerprint(),
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
  enableAnthropicNativeSkillDeliveryAction,
  selectSetupProviderAction,
  continueSetupModelStepAction,
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

/** A submission of the step's ONE form: the hidden provider + the key field. */
function keyForm(apiKey: string, provider = "anthropic"): FormData {
  const form = new FormData();
  form.set("provider", provider);
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

/**
 * Every value the run wrote under the failure key. The fold CLEARS the previous
 * run's record before it does anything else, so "no durable failure was
 * recorded" is "every write was the clearing null" — not "nothing was written".
 */
function failureRecordWrites() {
  return writeConnectorConfigToDatabase.mock.calls
    .filter((call) => call[0] === SETUP_READINESS_FAILURE_CONFIG_KEY)
    .map((call) => call[1]);
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
  refreshCommittedCredentialFingerprint.mockReturnValue(true);
  isNangoConfigured.mockReturnValue(true);
  saveAPISettings.mockImplementation(async () => ({}));
  readAnthropicMcpMode.mockReturnValue("function-tools");
  isAnthropicUploadOptInStanding.mockReturnValue(false);
  // The fence now runs on EVERY absent-state submission (it covers the
  // credential write), so it needs a default here rather than per-test — and
  // an explicit reset, because `clearAllMocks` clears calls but keeps a
  // `mockReturnValue` an earlier test installed.
  beginSetupProviderClaim.mockReset();
  // Modelled as the real primitive behaves: a granted claim LANDS in the store,
  // so `readSetupProviderCommitState()` reports it. The fold re-asks that store
  // whether it still owns the fence before every side effect that reaches
  // outside the request, and a mock that never landed the claim would make
  // every one of those checks fail for the wrong reason.
  beginSetupProviderClaim.mockImplementation(() => {
    commitMachineState.snapshot = {
      raw: '{"state":"claimed","nonce":"nonce-fold"}',
      state: { kind: "claim-pending", claim: { nonce: "nonce-fold", actorId: "user_admin" } },
    };
    return { ok: true, claim: { nonce: "nonce-fold", priorDefault: "openai" } };
  });
  releaseSetupProviderClaim.mockReset();
  releaseSetupProviderClaim.mockImplementation(() => {
    commitMachineState.snapshot = { raw: null, state: { kind: "absent" } };
    return true;
  });
  liveFingerprint.mockResolvedValue({ status: "readable", fingerprint: "cfv1:test" });
  saveSetupProviderConnection.mockResolvedValue({
    ok: true,
    code: "saved",
    sanitizedMessage: null,
  });
  errorLogArgs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLogArgs.push(args);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2502 item E — THE SINGLE CONTINUE.
//
// One form, one button: save → consent → commit. These arms pin that folding
// the three mechanisms together did not soften any of them. The SAVE and
// CONSENT legs keep S5's typed contract (`{ok, code, sanitizedMessage}`, never
// a redirect, never error text in a URL or in durable state); the COMMIT leg
// keeps S3's redirect discipline (codes-only flash, `stay=1` on refusal, no
// `stay=1` on success).
// ---------------------------------------------------------------------------

function consentedKeyForm(apiKey: string): FormData {
  const form = keyForm(apiKey);
  form.set(ANTHROPIC_SETUP_CONSENT_FIELD, "on");
  return form;
}

/** A Continue that reaches the commit leg — the saga is stubbed to succeed.
 *  (The fence's default success lives in `beforeEach`; it is taken before the
 *  credential write now, so every absent-state run needs it.) */
function sagaSucceeds() {
  commitSetupProviderClaim.mockResolvedValue({
    ok: true,
    commitment: { provider: "openai" },
    raw: '{"state":"committed"}',
  } as never);
  vi.mocked(runSetupReadinessSaga).mockImplementation((async (input: {
    provider: string;
  }) => {
    // The real saga awaits the commit port before it reports success; driving
    // it here is what lets these arms observe the sink CONSUMING the claim
    // (after which releasing the nonce would be wrong).
    await capturedPorts.setDefaultProvider?.(input.provider);
    return { ok: true, receipt: {} };
  }) as never);
}

describe("item E — the consent transaction inside the single Continue", () => {
  it("REQUIRES the literal consent input — no checkbox, nothing written anywhere, typed refusal", async () => {
    const result = await continueSetupModelStepAction(null, keyForm("sk-ant-live"));
    expect(result).toMatchObject({ ok: false, code: "consent-required" });
    expect(saveSetupProviderConnection).not.toHaveBeenCalled();
    expect(grantSetupConsentWithWorkspaceOptInInDatabase).not.toHaveBeenCalled();
    // CONSENT-DECLINED is one honest state: the commit machine is never entered.
    expect(beginSetupProviderClaim).not.toHaveBeenCalled();
    expect(vi.mocked(runSetupReadinessSaga)).not.toHaveBeenCalled();
  });

  it("does NOT demand the consent again once the workspace opt-in already stands", async () => {
    isAnthropicUploadOptInStanding.mockReturnValue(true);
    sagaSucceeds();

    // No consent field at all — the step does not render one in this state.
    const url = await redirectOf(() => continueSetupModelStepAction(null, keyForm("sk-ant-live")));

    expect(url).toBe("/setup/model");
    expect(saveSetupProviderConnection).toHaveBeenCalledWith("anthropic", {
      apiKey: "sk-ant-live",
    });
    // Nothing to re-grant: the transaction is not re-run for a standing opt-in.
    expect(grantSetupConsentWithWorkspaceOptInInDatabase).not.toHaveBeenCalled();
  });

  it("SUCCESS: saves through the typed writer, lands the opt-in + bulk grant in ONE transactional call attributed to the acting admin, THEN commits", async () => {
    sagaSucceeds();

    const url = await redirectOf(() =>
      continueSetupModelStepAction(null, consentedKeyForm("sk-ant-live")),
    );

    expect(saveSetupProviderConnection).toHaveBeenCalledWith("anthropic", {
      apiKey: "sk-ant-live",
    });
    // Actor attribution: the admin session's user id, never null-by-default.
    expect(grantSetupConsentWithWorkspaceOptInInDatabase).toHaveBeenCalledWith("user_admin");
    // ORDER IS THE CONTRACT: the FENCE first (so the credential write is
    // covered by it), then the key, then the consent, then the saga.
    expect(beginSetupProviderClaim.mock.invocationCallOrder[0]).toBeLessThan(
      saveSetupProviderConnection.mock.invocationCallOrder[0],
    );
    expect(saveSetupProviderConnection.mock.invocationCallOrder[0]).toBeLessThan(
      grantSetupConsentWithWorkspaceOptInInDatabase.mock.invocationCallOrder[0],
    );
    expect(grantSetupConsentWithWorkspaceOptInInDatabase.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runSetupReadinessSaga).mock.invocationCallOrder[0],
    );
    // The fence is CONSUMED by the commit, never released behind it.
    expect(releaseSetupProviderClaim).not.toHaveBeenCalled();
    // S4: a successful Continue advances — no `stay=1`.
    expect(url).toBe("/setup/model");
    expect(lastFailureRecord()).toBeNull();
  });

  it("a FAILED key save returns the writer's typed failure, NEVER touches consent, RELEASES the fence, and never runs the saga", async () => {
    sagaSucceeds();
    saveSetupProviderConnection.mockResolvedValueOnce({
      ok: false,
      code: "save-failed",
      sanitizedMessage: "[sanitized]Anthropic rejected the key (401).",
    });

    const result = await continueSetupModelStepAction(null, consentedKeyForm("sk-ant-bad"));

    expect(result).toMatchObject({ ok: false, code: "save-failed" });
    expect(grantSetupConsentWithWorkspaceOptInInDatabase).not.toHaveBeenCalled();
    expect(vi.mocked(runSetupReadinessSaga)).not.toHaveBeenCalled();
    // The fence was taken to cover the write and GIVEN BACK on the refusal —
    // a held claim would leave the step read-only for the claim's whole TTL.
    expect(releaseSetupProviderClaim).toHaveBeenCalledWith({ nonce: "nonce-fold" });
    // NOTHING durable: the sanitized message exists only in the typed result
    // (the toast + the inline field error). The only failure-key write this run
    // makes is clearing the PREVIOUS run's record.
    expect(failureRecordWrites()).toEqual([null]);
  });

  it("an UNCONFIGURED connection service keeps its fix-forward naming the Secrets step (decided from the LIVE nango status)", async () => {
    isNangoConfigured.mockReturnValue(false);
    saveSetupProviderConnection.mockResolvedValueOnce({
      ok: false,
      code: "save-failed",
      sanitizedMessage: "[sanitized]connection service unavailable",
    });

    const result = await continueSetupModelStepAction(null, consentedKeyForm("sk-ant-live"));
    expect(result.ok).toBe(false);
    expect(result.sanitizedMessage).toContain("Secrets");
  });

  it("a FAILED consent transaction is a typed failure that BLOCKS the commit — saved-but-unconfirmed, never half-advanced", async () => {
    sagaSucceeds();
    grantSetupConsentWithWorkspaceOptInInDatabase.mockImplementationOnce(() => {
      throw new Error("deadlock detected around authorization: sk-ant-SECRETVALUE01234567890");
    });

    const result = await continueSetupModelStepAction(null, consentedKeyForm("sk-ant-live"));

    expect(result).toMatchObject({ ok: false, code: "consent-write-failed" });
    // The key IS stored — that is what makes the state "saved but unconfirmed"…
    expect(saveSetupProviderConnection).toHaveBeenCalledTimes(1);
    // …and the provider is emphatically NOT committed: the saga never ran and
    // the fence went back.
    expect(vi.mocked(runSetupReadinessSaga)).not.toHaveBeenCalled();
    expect(releaseSetupProviderClaim).toHaveBeenCalledWith({ nonce: "nonce-fold" });
    // The thrown message went through the sanitizer before joining the copy.
    expect(result.sanitizedMessage).toContain("[sanitized]");
    // The server log too: sanitized strings only, never the raw Error.
    expect(errorLogArgs.length).toBe(1);
    for (const arg of errorLogArgs[0]) {
      expect(arg).not.toBeInstanceOf(Error);
      expect(typeof arg).toBe("string");
    }
    // …and the explanation is DURABLE: the typed result is rendered once, but
    // the operator must still find out why setup stopped after a reload.
    expect(failureRecordWrites()).toEqual([
      null,
      expect.objectContaining({
        step: "bulk-consent",
        fixForward: expect.stringContaining("was saved"),
      }),
    ]);
  });

  it("NEVER redirects on a save/consent-leg outcome — the typed result is the only channel there", async () => {
    // A redirect would THROW (RedirectSignal); a clean return proves none.
    // Consent missing — refused before the writer is reached.
    await expect(
      continueSetupModelStepAction(null, keyForm("sk-ant-live")),
    ).resolves.toMatchObject({ ok: false, code: "consent-required" });

    // Save rejected — the writer answered, the typed failure comes back.
    saveSetupProviderConnection.mockResolvedValueOnce({
      ok: false,
      code: "save-rejected",
      sanitizedMessage: "The connector did not accept the connection settings.",
    });
    await expect(
      continueSetupModelStepAction(null, consentedKeyForm("sk-ant-live")),
    ).resolves.toMatchObject({ ok: false, code: "save-rejected" });
  });
});

describe("item E — the credential leg inside the single Continue", () => {
  it("collects the OpenAI connection fields into the writer's flat values map", async () => {
    sagaSucceeds();
    const form = keyForm("sk-live", "openai");
    form.set("projectId", "proj_1");
    form.set("organizationId", "org_1");

    await redirectOf(() => continueSetupModelStepAction(null, form));

    expect(saveSetupProviderConnection).toHaveBeenCalledWith("openai", {
      apiKey: "sk-live",
      projectId: "proj_1",
      organizationId: "org_1",
    });
  });

  it("returns the writer's typed failure verbatim and stops — no commit, no durable record", async () => {
    sagaSucceeds();
    saveSetupProviderConnection.mockResolvedValueOnce({
      ok: false,
      code: "save-rejected",
      sanitizedMessage: "The connector did not accept the connection settings.",
    });
    const result = await continueSetupModelStepAction(null, keyForm("sk-bad", "openai"));
    expect(result).toMatchObject({ ok: false, code: "save-rejected" });
    expect(vi.mocked(runSetupReadinessSaga)).not.toHaveBeenCalled();
    expect(failureRecordWrites()).toEqual([null]);
  });

  it("a BLANK key with nothing stored is a typed refusal before anything is touched", async () => {
    liveFingerprint.mockResolvedValue({ status: "absent" });
    const result = await continueSetupModelStepAction(null, consentedKeyForm("   "));
    expect(result).toMatchObject({ ok: false, code: "key-missing" });
    expect(saveSetupProviderConnection).not.toHaveBeenCalled();
    expect(beginSetupProviderClaim).not.toHaveBeenCalled();
  });

  it("an UNREADABLE stored credential is refused too — fail closed, and it says so honestly", async () => {
    liveFingerprint.mockResolvedValue({ status: "unreadable", reason: "connector-unavailable" });
    const result = await continueSetupModelStepAction(null, consentedKeyForm(""));
    expect(result).toMatchObject({ ok: false, code: "key-missing" });
    expect(result.sanitizedMessage).toMatch(/could not read a stored/i);
    expect(saveSetupProviderConnection).not.toHaveBeenCalled();
  });

  it("a BLANK key over a READABLE stored credential SKIPS the save and commits — the reopened flow's 'you do not need to re-enter it'", async () => {
    // The #2504 copy tells the operator exactly this, so a Continue that
    // refused an empty field would contradict the step's own instructions.
    isAnthropicUploadOptInStanding.mockReturnValue(true);
    sagaSucceeds();

    const url = await redirectOf(() => continueSetupModelStepAction(null, keyForm("")));

    expect(saveSetupProviderConnection).not.toHaveBeenCalled();
    expect(beginSetupProviderClaim).toHaveBeenCalledTimes(1);
    expect(url).toBe("/setup/model");
  });

  it("a DEGRADED save still commits, and carries the notice on the success redirect", async () => {
    isAnthropicUploadOptInStanding.mockReturnValue(true);
    saveSetupProviderConnection.mockResolvedValueOnce({
      ok: true,
      code: "saved-degraded",
      sanitizedMessage: "the connection-service copy did not complete",
    });
    sagaSucceeds();

    const url = await redirectOf(() => continueSetupModelStepAction(null, keyForm("sk-ant-live")));

    // The key works, so setup completes — but the operator still hears about
    // the incomplete copy, through the codes-only NOTICE channel.
    expect(url).toBe("/setup/model?notice=setup-connection-service-not-synced");
    expect(url).not.toContain("stay=1");
  });
});

describe("item E — the claim fence guards the credential, not just the commit", () => {
  it("a PENDING claim refuses BEFORE the credential is touched", async () => {
    commitMachineState.snapshot = {
      raw: "{}",
      state: { kind: "claim-pending", claim: { actorId: "someone" } },
    };

    const url = await redirectOf(() =>
      continueSetupModelStepAction(null, consentedKeyForm("sk-ant-live")),
    );

    expect(url).toBe("/setup/model?stay=1&error=setup-provider-claim-pending");
    // THE POINT: another admin's run is verifying a specific credential right
    // now. Writing a new one underneath it would invalidate the fingerprint
    // that run started with — so the save must not happen at all.
    expect(saveSetupProviderConnection).not.toHaveBeenCalled();
    expect(grantSetupConsentWithWorkspaceOptInInDatabase).not.toHaveBeenCalled();
    // And it does not disturb the in-flight run's failure record either.
    expect(failureRecordWrites()).toEqual([]);
  });

  it("the LOCK refuses a different provider BEFORE the credential is touched", async () => {
    commitMachineState.snapshot = {
      raw: "{}",
      state: { kind: "committed", commitment: { provider: "anthropic" } },
    };

    const url = await redirectOf(() =>
      continueSetupModelStepAction(null, keyForm("sk-live", "openai")),
    );

    expect(url).toBe("/setup/model?stay=1&error=setup-provider-locked");
    expect(saveSetupProviderConnection).not.toHaveBeenCalled();
    expect(failureRecordWrites()).toEqual([]);
  });

  it("a claim landing AFTER the pre-flight read still stops the credential write — the fence, not the read, is what decides", async () => {
    // THE TOCTOU. The pre-flight read is advisory: it can say "absent" and be
    // stale by the time this run acts. `beginSetupProviderClaim` is the real
    // fence (insert-if-absent), and the fold takes it BEFORE the save — so the
    // loser of the race never reaches the writer at all, and cannot change the
    // credential the winner is verifying.
    commitMachineState.snapshot = { raw: null, state: { kind: "absent" } };
    beginSetupProviderClaim.mockReturnValue({ ok: false, refusal: "claim-pending" });

    const url = await redirectOf(() =>
      continueSetupModelStepAction(null, consentedKeyForm("sk-ant-live")),
    );

    expect(url).toBe("/setup/model?stay=1&error=setup-provider-claim-pending");
    expect(saveSetupProviderConnection).not.toHaveBeenCalled();
    expect(grantSetupConsentWithWorkspaceOptInInDatabase).not.toHaveBeenCalled();
    expect(vi.mocked(runSetupReadinessSaga)).not.toHaveBeenCalled();
    // It also lost before it could touch the other run's failure record.
    expect(failureRecordWrites()).toEqual([]);
  });

  it("a commitment landing after the pre-flight read reports the LOCK, still without writing a credential", async () => {
    commitMachineState.snapshot = { raw: null, state: { kind: "absent" } };
    beginSetupProviderClaim.mockReturnValue({ ok: false, refusal: "committed" });

    const url = await redirectOf(() =>
      continueSetupModelStepAction(null, consentedKeyForm("sk-ant-live")),
    );

    expect(url).toBe("/setup/model?stay=1&error=setup-provider-locked");
    expect(saveSetupProviderConnection).not.toHaveBeenCalled();
  });

  it("gives the fence back even when the failure-record clear THROWS — the step is never wedged", async () => {
    // A claim held past an unexpected throw wedges the step read-only for the
    // claim's whole TTL, which on a first-run instance is the whole product.
    writeConnectorConfigToDatabase.mockImplementationOnce(() => {
      throw new Error("config store unavailable");
    });

    await expect(
      continueSetupModelStepAction(null, consentedKeyForm("sk-ant-live")),
    ).rejects.toThrow("config store unavailable");

    expect(beginSetupProviderClaim).toHaveBeenCalledTimes(1);
    expect(releaseSetupProviderClaim).toHaveBeenCalledWith({ nonce: "nonce-fold" });
    // …and it threw before it could touch the credential.
    expect(saveSetupProviderConnection).not.toHaveBeenCalled();
  });

  it("STOPS if the lease was lost while the (unbounded) credential save ran", async () => {
    // Holding the nonce is not owning the lease: the claim can expire under a
    // slow save, or be replaced. Running the consent transaction and the saga's
    // uploads after that would be acting unfenced — the commit CAS would refuse
    // later, but the side effects would already have happened.
    sagaSucceeds();
    saveSetupProviderConnection.mockImplementationOnce(async () => {
      commitMachineState.snapshot = { raw: null, state: { kind: "absent" } }; // expired
      return { ok: true, code: "saved", sanitizedMessage: null };
    });

    const url = await redirectOf(() =>
      continueSetupModelStepAction(null, consentedKeyForm("sk-ant-live")),
    );

    expect(url).toBe("/setup/model?stay=1&error=setup-provider-claim-pending");
    expect(grantSetupConsentWithWorkspaceOptInInDatabase).not.toHaveBeenCalled();
    expect(vi.mocked(runSetupReadinessSaga)).not.toHaveBeenCalled();
  });

  it("writes its durable failure BEFORE giving the fence back — a later run's cleared record is never overwritten", async () => {
    vi.mocked(runSetupReadinessSaga).mockResolvedValue({
      ok: false,
      failure: { step: "credential-validation", message: "no models", compensation: "setup-incomplete" },
    } as never);

    await redirectOf(() => continueSetupModelStepAction(null, consentedKeyForm("sk-ant-live")));

    const recordWrite = writeConnectorConfigToDatabase.mock.calls.findIndex(
      (call) => call[0] === SETUP_READINESS_FAILURE_CONFIG_KEY && call[1] !== null,
    );
    expect(recordWrite).toBeGreaterThanOrEqual(0);
    expect(
      writeConnectorConfigToDatabase.mock.invocationCallOrder[recordWrite],
    ).toBeLessThan(releaseSetupProviderClaim.mock.invocationCallOrder[0]);
  });

  it("an unknown provider is a typed refusal — nothing written, nothing redirected", async () => {
    const form = new FormData();
    form.set("provider", "gemini");
    form.set("apiKey", "whatever");
    const result = await continueSetupModelStepAction(null, form);
    expect(result).toMatchObject({ ok: false, code: "provider-invalid" });
    expect(saveSetupProviderConnection).not.toHaveBeenCalled();
    expect(failureRecordWrites()).toEqual([]);
  });

  it("clears the PREVIOUS run's failure record before doing anything else — one run, one standing state", async () => {
    saveSetupProviderConnection.mockResolvedValueOnce({
      ok: false,
      code: "save-rejected",
      sanitizedMessage: "The connector did not accept the connection settings.",
    });

    await continueSetupModelStepAction(null, consentedKeyForm("sk-ant-bad"));

    // The clear happens before the writer runs, so a step re-render can never
    // show a stale saga failure next to this run's inline error.
    const clearOrder = writeConnectorConfigToDatabase.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(saveSetupProviderConnection.mock.invocationCallOrder[0]);
    expect(failureRecordWrites()).toEqual([null]);
  });

  it("tells the island to refresh ONLY when a now-false alert is still on screen", async () => {
    const rejected = {
      ok: false,
      code: "save-rejected",
      sanitizedMessage: "The connector did not accept the connection settings.",
    };

    // Nothing stale behind this run: no refresh advice, so the key the operator
    // typed survives the failure render.
    saveSetupProviderConnection.mockResolvedValueOnce(rejected);
    const first = await continueSetupModelStepAction(null, consentedKeyForm("sk-ant-bad"));
    expect(first).not.toHaveProperty("clearedStandingFailure", true);

    // A durable record from an EARLIER run WAS standing: this run cleared it,
    // so the alert it produced is now false and the route must re-render.
    storedConfig.set(SETUP_READINESS_FAILURE_CONFIG_KEY, {
      step: "credential-validation",
      message: "an earlier run failed here",
      fixForward: null,
      at: "2026-08-09T10:00:00.000Z",
    });
    saveSetupProviderConnection.mockResolvedValueOnce(rejected);
    const second = await continueSetupModelStepAction(null, consentedKeyForm("sk-ant-bad"));
    expect(second).toMatchObject({ ok: false, clearedStandingFailure: true });
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

/**
 * A Continue submitted with NO key typed — the ordinary shape once a credential
 * is already stored (the step then renders the Administration pointer and no
 * key field at all). The consent input rides along because the Anthropic
 * section renders it whenever it renders anything, and these arms are about the
 * COMMIT leg, not about the consent gate.
 */
function providerForm(provider: string): FormData {
  const form = new FormData();
  form.set("provider", provider);
  form.set(ANTHROPIC_SETUP_CONSENT_FIELD, "on");
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

describe("S3 — the commit leg of the single Continue, under the machine", () => {
  it("refuses Continue while a claim is pending (no saga run, no claim taken)", async () => {
    commitMachineState.snapshot = {
      raw: "{}",
      state: { kind: "claim-pending", claim: { actorId: "someone" } },
    };
    const url = await redirectOf(() => continueSetupModelStepAction(null, providerForm("openai")));
    expect(url).toBe("/setup/model?stay=1&error=setup-provider-claim-pending");
    expect(beginSetupProviderClaim).not.toHaveBeenCalled();
    expect(vi.mocked(runSetupReadinessSaga)).not.toHaveBeenCalled();
  });

  it("refuses Continue for a provider DIFFERENT from the committed one (the lock)", async () => {
    commitMachineState.snapshot = {
      raw: "{}",
      state: { kind: "committed", commitment: { provider: "anthropic" } },
    };
    const url = await redirectOf(() => continueSetupModelStepAction(null, providerForm("openai")));
    expect(url).toBe("/setup/model?stay=1&error=setup-provider-locked");
    expect(vi.mocked(runSetupReadinessSaga)).not.toHaveBeenCalled();
  });

  it("absent state: claims, and RELEASES the claim when the saga reports failure", async () => {
    vi.mocked(runSetupReadinessSaga).mockResolvedValue({
      ok: false,
      failure: {
        step: "credential-validation",
        message: "no key",
        compensation: "setup-incomplete",
      },
    } as never);
    const url = await redirectOf(() => continueSetupModelStepAction(null, providerForm("openai")));
    expect(url).toBe("/setup/model?stay=1&error=setup-readiness-failed");
    expect(beginSetupProviderClaim).toHaveBeenCalledTimes(1);
    expect(releaseSetupProviderClaim).toHaveBeenCalledWith({ nonce: "nonce-fold" });
  });

  it("S5: committing ANTHROPIC migrates the connector's MCP mode to native FIRST (receipt cleared before the flip)", async () => {
    readAnthropicMcpMode.mockReturnValue("function-tools");
    vi.mocked(runSetupReadinessSaga).mockResolvedValue({
      ok: true,
      receipt: {},
    } as never);

    const url = await redirectOf(() => continueSetupModelStepAction(null, providerForm("anthropic")));
    // S4 (cinatra#2389): a SUCCESSFUL Continue-commit advances (no `stay=1`) —
    // the step's auto-forward carries the operator onward.
    expect(url).toBe("/setup/model");

    expect(writeAnthropicMcpMode).toHaveBeenCalledWith("native");
    // Resurrection guard: the mode is a fingerprint input, so the receipt is
    // cleared BEFORE the mode changes — same ordering as the F2 action.
    expect(clearSetupReadinessReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      writeAnthropicMcpMode.mock.invocationCallOrder[0],
    );
    // …and BEFORE the readiness run, so the fingerprint this run earns is
    // computed under the mode the commit leaves behind. (cinatra#2502 item E
    // moved the CLAIM ahead of the credential write, so the mode migration is
    // no longer the first thing that happens — but the ordering that carries
    // the meaning, mode-before-fingerprint-before-saga, is unchanged.)
    expect(writeAnthropicMcpMode.mock.invocationCallOrder[0]).toBeLessThan(
      liveFingerprint.mock.invocationCallOrder[liveFingerprint.mock.calls.length - 1],
    );
    expect(writeAnthropicMcpMode.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runSetupReadinessSaga).mock.invocationCallOrder[0],
    );
  });

  it("S5: an ALREADY-NATIVE mode is left untouched (idempotent commit, no receipt churn)", async () => {
    readAnthropicMcpMode.mockReturnValue("native");
    vi.mocked(runSetupReadinessSaga).mockResolvedValue({
      ok: true,
      receipt: {},
    } as never);

    await redirectOf(() => continueSetupModelStepAction(null, providerForm("anthropic")));
    expect(writeAnthropicMcpMode).not.toHaveBeenCalled();
    expect(clearSetupReadinessReceipt).not.toHaveBeenCalled();
  });

  it("S5: an OPENAI commit never touches the Anthropic MCP mode", async () => {
    vi.mocked(runSetupReadinessSaga).mockResolvedValue({
      ok: true,
      receipt: {},
    } as never);

    await redirectOf(() => continueSetupModelStepAction(null, providerForm("openai")));
    expect(writeAnthropicMcpMode).not.toHaveBeenCalled();
  });

  it("S5: a FAILED mode migration stops before the saga, releases the fence, and leaves a STANDING explanation", async () => {
    sagaSucceeds();
    readAnthropicMcpMode.mockReturnValue("function-tools");
    writeAnthropicMcpMode.mockImplementationOnce(() => {
      throw new Error("config store unavailable");
    });

    const url = await redirectOf(() => continueSetupModelStepAction(null, providerForm("anthropic")));
    expect(url).toBe("/setup/model?stay=1&error=setup-mcp-mode-switch-failed");
    expect(vi.mocked(runSetupReadinessSaga)).not.toHaveBeenCalled();
    // cinatra#2502 item E: the fence goes back, and the operator is left with
    // a durable reason on the step rather than a bare flash code.
    expect(releaseSetupProviderClaim).toHaveBeenCalledWith({ nonce: "nonce-fold" });
    expect(lastFailureRecord()).toMatchObject({ step: "commit" });
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
    const url = await redirectOf(() => continueSetupModelStepAction(null, providerForm("openai")));
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

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
// `readiness-state.ts` is kept REAL (for its config keys, its step id, and its
// failure reader), so this stands in for the durable store it reads through.
const storedConfig = new Map<string, unknown>();
vi.mock("@/lib/database", () => ({
  writeConnectorConfigToDatabase: (...args: unknown[]) =>
    writeConnectorConfigToDatabase(...args),
  readConnectorConfigFromDatabase: (key: string, fallback: unknown) =>
    storedConfig.has(key) ? storedConfig.get(key) : fallback,
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
  saveAnthropicSetupKeyAction,
  enableAnthropicNativeSkillDeliveryAction,
} from "@/app/setup/ai/actions";
import {
  SETUP_CREDENTIAL_SAVE_STEP_ID,
  SETUP_READINESS_FAILURE_CONFIG_KEY,
} from "@/app/setup/ai/readiness-state";

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
  isNangoConfigured.mockReturnValue(true);
  saveAPISettings.mockImplementation(async () => ({}));
  readAnthropicMcpMode.mockReturnValue("function-tools");
  errorLogArgs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLogArgs.push(args);
  });
});

describe("F1 — saveAnthropicSetupKeyAction: the writer's throw is an operator state, not a server error", () => {
  it("an UNCONFIGURED connection service becomes an in-page record naming the step to complete first", async () => {
    // The exact condition the connector's writer refuses on, and the normal
    // pre-setup state of a fresh instance.
    isNangoConfigured.mockReturnValue(false);
    saveAPISettings.mockRejectedValue(
      new Error("Configure the connection service first so Anthropic API requests can authenticate."),
    );

    const url = await redirectOf(() => saveAnthropicSetupKeyAction(keyForm("sk-ant-live")));

    // Reported through the wizard's codes-only flash protocol, like the OpenAI
    // arm — never as an unhandled throw out of the action.
    expect(url).toBe("/setup/ai?stay=1&error=setup-provider-save-failed");

    const record = lastFailureRecord() as {
      step: string;
      message: string;
      fixForward: string | null;
    };
    expect(record.step).toBe(SETUP_CREDENTIAL_SAVE_STEP_ID);
    expect(record.message).toContain("Configure the connection service first");
    // ACTIONABLE: it names what to complete first, which is the whole point of
    // the finding.
    expect(record.fixForward).toContain("Connections");
  });

  it("a DIFFERENT error class is still reported — never swallowed, and no remedy is invented", async () => {
    isNangoConfigured.mockReturnValue(true);
    saveAPISettings.mockRejectedValue(new Error("Anthropic rejected the key (401)."));

    const url = await redirectOf(() => saveAnthropicSetupKeyAction(keyForm("sk-ant-bad")));
    expect(url).toBe("/setup/ai?stay=1&error=setup-provider-save-failed");

    const record = lastFailureRecord() as { message: string; fixForward: string | null };
    expect(record.message).toContain("Anthropic rejected the key");
    // The connection service IS configured here, so the "finish Connections"
    // remedy would be a lie. No fix-forward is better than a wrong one.
    expect(record.fixForward).toBeNull();
  });

  it("the recorded message goes through the SANITIZER — a writer that echoes the key back never reaches durable state raw", async () => {
    isNangoConfigured.mockReturnValue(true);
    const raw = "upstream rejected authorization: sk-ant-SECRETVALUE01234567890";
    saveAPISettings.mockRejectedValue(new Error(raw));

    await redirectOf(() => saveAnthropicSetupKeyAction(keyForm("sk-ant-live")));

    expect(sanitizeReadinessMessage).toHaveBeenCalledWith(raw);
    const record = lastFailureRecord() as { message: string };
    expect(record.message.startsWith("[sanitized]")).toBe(true);
  });

  it("the SERVER LOG gets the SANITIZED text, never the raw Error (message + stack)", async () => {
    // A server log is durable and often shipped off-box. Sanitizing the
    // operator-facing copy while `console.error(..., err)`-ing the raw Error
    // would defeat the sanitizer entirely — the message AND the stack ride
    // along. Asserted structurally (no Error object is ever handed to the sink)
    // because the redaction itself belongs to the real sanitizer, pinned in
    // setup-readiness-saga.test.ts.
    isNangoConfigured.mockReturnValue(true);
    const rejection = new Error("upstream rejected authorization: sk-ant-SECRETVALUE01234567890");
    saveAPISettings.mockRejectedValue(rejection);

    await redirectOf(() => saveAnthropicSetupKeyAction(keyForm("sk-ant-live")));

    expect(errorLogArgs.length).toBe(1);
    for (const args of errorLogArgs) {
      for (const arg of args) {
        expect(arg).not.toBeInstanceOf(Error);
        expect(typeof arg).toBe("string");
      }
      // What DOES go to the sink is the sanitizer's output.
      expect(args.join(" ")).toContain("[sanitized]");
    }
  });

  it("a redirect thrown by the connector's own writer is CONTROL FLOW, not a failure", async () => {
    saveAPISettings.mockRejectedValue(new RedirectSignal("/configuration/llm?modal=anthropic"));

    const url = await redirectOf(() => saveAnthropicSetupKeyAction(keyForm("sk-ant-live")));
    expect(url).toBe("/configuration/llm?modal=anthropic");
    // Nothing was recorded as a failure — the writer navigated on purpose.
    expect(lastFailureRecord()).toBeUndefined();
  });

  it("SUCCESS still clears the stale failure record and forwards to the step", async () => {
    const url = await redirectOf(() => saveAnthropicSetupKeyAction(keyForm("sk-ant-live")));

    expect(saveAPISettings).toHaveBeenCalledWith({ apiKey: "sk-ant-live" });
    expect(url).toBe("/setup/ai?stay=1");
    expect(lastFailureRecord()).toBeNull();
  });

  it("a blank key is rejected before the connector is touched", async () => {
    const url = await redirectOf(() => saveAnthropicSetupKeyAction(keyForm("   ")));
    expect(url).toBe("/setup/ai?stay=1&error=setup-provider-invalid");
    expect(saveAPISettings).not.toHaveBeenCalled();
  });
});

describe("F2 — enableAnthropicNativeSkillDeliveryAction: the fix-forward is performable", () => {
  it("sets the stored MCP mode to native, clears the resolved failure, and returns to the step", async () => {
    standingProbeFailure();

    const url = await redirectOf(() => enableAnthropicNativeSkillDeliveryAction());

    expect(writeAnthropicMcpMode).toHaveBeenCalledWith("native");
    expect(lastFailureRecord()).toBeNull();
    expect(url).toBe("/setup/ai?stay=1");
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
    expect(url).toBe("/setup/ai?stay=1&error=setup-mcp-mode-switch-failed");
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

    expect(url).toBe("/setup/ai?stay=1");
    expect(writeAnthropicMcpMode).not.toHaveBeenCalled();
    expect(clearSetupReadinessReceipt).not.toHaveBeenCalled();
    expect(writeConnectorConfigToDatabase).not.toHaveBeenCalled();
  });

  it("re-checks the STORED MODE too: a double submit after the switch mutates nothing", async () => {
    standingProbeFailure();
    readAnthropicMcpMode.mockReturnValue("native");

    const url = await redirectOf(() => enableAnthropicNativeSkillDeliveryAction());

    expect(url).toBe("/setup/ai?stay=1");
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

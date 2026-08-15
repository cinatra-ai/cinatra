/**
 * PER-ACTION fixtures for the `/configuration` action sweep (cinatra#2700,
 * epic #2699).
 *
 * A server action never passes through a segment layout, so the gate on the
 * page it is rendered from proves nothing about the action: a Next.js server
 * action is a POST endpoint invocable WITHOUT its form. Every action that
 * serves a `/configuration` surface therefore states the platform-admin gate in
 * its own body, and this file exercises each one.
 *
 * Two properties per action:
 *   1. a NON-ADMIN session is refused — the gate redirects (by throw), and
 *   2. the refusal happens BEFORE any effect: no writer runs, and not even the
 *      connector-surface resolution runs (the OpenAI/Anthropic wrappers throw a
 *      descriptive "connector not installed" error when they get that far, so
 *      seeing the REDIRECT instead is itself the ordering proof).
 *
 * The gates raised here were:
 *   - development logging save/clear + the email-safety save — no gate at all;
 *   - the OpenAI connection save/clear — connector `manage` authorization,
 *     raised to platform-admin because the surface is `/configuration/llm`;
 *   - the OpenAI prompt-caching save, the Anthropic connection save/clear and
 *     the default-image-provider save — the remaining ungated writers on the
 *     same surface, found by the sweep clause rather than by the named list.
 *
 * The module-wide completeness half — "no `/configuration` action was missed" —
 * is the action table in
 * `src/app/configuration/__tests__/configuration-admin-gate.test.ts`, which
 * enumerates every exported server action in the segment and holds each one to
 * a gate or to a written-down reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

/** What `requireAdminSession()` does to a non-admin caller: redirect, by throw. */
class NotAuthorizedRedirect extends Error {
  digest = "NEXT_REDIRECT;replace;/not-authorized";
  constructor() {
    super("NEXT_REDIRECT");
  }
}

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  requireAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(() => false),
  resolveOrgRoleForSession: vi.fn(async () => null),
  getActorContext: vi.fn(async () => ({})),
  // The effect sinks the swept actions would reach if the gate let them.
  saveEmailSystemDevelopmentSettings: vi.fn(),
  clearAllProviderLogEntries: vi.fn(),
  saveAnthropicLoggingSettings: vi.fn(),
  saveMcpLoggingSettings: vi.fn(),
  updateOpenAIPromptCaching: vi.fn(),
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn(() => {
    throw new Error("openai surface is not installed/active");
  }),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: mocks.requireAdminSession,
  requireAuthSession: mocks.requireAuthSession,
  isPlatformAdmin: mocks.isPlatformAdmin,
  resolveOrgRoleForSession: mocks.resolveOrgRoleForSession,
  getActorContext: mocks.getActorContext,
}));

vi.mock("@/lib/email-system", () => ({
  saveEmailSystemDevelopmentSettings: mocks.saveEmailSystemDevelopmentSettings,
}));

vi.mock("@/lib/logging", () => ({
  clearAllProviderLogEntries: mocks.clearAllProviderLogEntries,
  saveAnthropicLoggingSettings: mocks.saveAnthropicLoggingSettings,
}));

vi.mock("@/lib/mcp-logging", () => ({
  saveMcpLoggingSettings: mocks.saveMcpLoggingSettings,
}));

vi.mock("@/lib/openai-connection-store", () => ({
  updateOpenAIPromptCaching: mocks.updateOpenAIPromptCaching,
  readOpenAIConnection: vi.fn(() => null),
}));

vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: mocks.getLlmProviderSurface,
  requireLlmProviderSurface: mocks.requireLlmProviderSurface,
}));

/** Each swept action, invoked with the arguments its form posts. */
const SWEPT_ACTIONS: Array<{
  name: string;
  surface: string;
  invoke: (actions: Record<string, (...args: never[]) => Promise<unknown>>) => Promise<unknown>;
}> = [
  {
    name: "saveDevelopmentLoggingAction",
    surface: "/configuration/telemetry",
    invoke: (a) => a.saveDevelopmentLoggingAction(new FormData() as never),
  },
  {
    name: "clearDevelopmentLogEntriesAction",
    surface: "/configuration/telemetry",
    invoke: (a) => a.clearDevelopmentLogEntriesAction(),
  },
  {
    name: "saveEmailSystemDevelopmentSettingsAction",
    surface: "/configuration/development",
    invoke: (a) => a.saveEmailSystemDevelopmentSettingsAction(new FormData() as never),
  },
  {
    name: "saveOpenAIConnectionAction",
    surface: "/configuration/llm",
    invoke: (a) => a.saveOpenAIConnectionAction(new FormData() as never),
  },
  {
    name: "clearOpenAIConnectionAction",
    surface: "/configuration/llm",
    invoke: (a) => a.clearOpenAIConnectionAction(),
  },
  {
    name: "saveOpenAIPromptCachingAction",
    surface: "/configuration/llm",
    invoke: (a) => a.saveOpenAIPromptCachingAction(new FormData() as never),
  },
  {
    name: "setDefaultImageProviderAction",
    surface: "/configuration/llm",
    invoke: (a) => a.setDefaultImageProviderAction(new FormData() as never),
  },
  {
    name: "saveAnthropicConnectionAction",
    surface: "/configuration/llm",
    invoke: (a) => a.saveAnthropicConnectionAction(new FormData() as never),
  },
  {
    name: "clearAnthropicConnectionAction",
    surface: "/configuration/llm",
    invoke: (a) => a.clearAnthropicConnectionAction(),
  },
];

async function loadActions() {
  return (await import("@/app/campaigns/actions")) as unknown as Record<
    string,
    (...args: never[]) => Promise<unknown>
  >;
}

describe("cinatra#2700 — the formerly session-only /configuration actions refuse a non-admin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminSession.mockRejectedValue(new NotAuthorizedRedirect());
    mocks.requireLlmProviderSurface.mockImplementation(() => {
      throw new Error("openai surface is not installed/active");
    });
  });

  for (const action of SWEPT_ACTIONS) {
    it(`${action.name} (${action.surface}) redirects a non-admin to /not-authorized`, async () => {
      const actions = await loadActions();
      await expect(action.invoke(actions)).rejects.toMatchObject({
        digest: "NEXT_REDIRECT;replace;/not-authorized",
      });
      expect(mocks.requireAdminSession).toHaveBeenCalled();
    });
  }

  it("refuses BEFORE any effect — no writer and no connector resolution runs", async () => {
    const actions = await loadActions();
    for (const action of SWEPT_ACTIONS) {
      await expect(action.invoke(actions)).rejects.toBeInstanceOf(NotAuthorizedRedirect);
    }
    expect(mocks.saveEmailSystemDevelopmentSettings).not.toHaveBeenCalled();
    expect(mocks.clearAllProviderLogEntries).not.toHaveBeenCalled();
    expect(mocks.saveAnthropicLoggingSettings).not.toHaveBeenCalled();
    expect(mocks.saveMcpLoggingSettings).not.toHaveBeenCalled();
    expect(mocks.updateOpenAIPromptCaching).not.toHaveBeenCalled();
    // The wrappers resolve their connector surface AFTER the gate: a non-admin
    // never reaches the "connector not installed" error, only the redirect.
    expect(mocks.requireLlmProviderSurface).not.toHaveBeenCalled();
  });

  it("an ADMIN session passes the gate and reaches the action body", async () => {
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "user_1", role: "user,admin" },
      session: { activeOrganizationId: "org_1" },
    });
    const actions = await loadActions();

    await actions.saveEmailSystemDevelopmentSettingsAction(new FormData() as never).catch(() => {
      // The action ends in redirect(); the mocked next/navigation is not used
      // here, so a thrown NEXT_REDIRECT from the real helper is expected and
      // irrelevant — the assertion below is that the WRITE happened.
    });
    expect(mocks.saveEmailSystemDevelopmentSettings).toHaveBeenCalledTimes(1);

    // The OpenAI wrapper now gets far enough to resolve its connector surface
    // (and, with none registered in this suite, to fail loudly on that) —
    // proving the gate is the only thing that stopped the non-admin above.
    await expect(actions.clearOpenAIConnectionAction()).rejects.toThrow(
      /not installed\/active/,
    );
    expect(mocks.requireLlmProviderSurface).toHaveBeenCalledWith("openai");
  });
});

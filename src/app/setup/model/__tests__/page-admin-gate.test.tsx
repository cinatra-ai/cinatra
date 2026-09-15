/**
 * The LLM-provider setup step is ADMINISTRATOR-ONLY at the PAGE, not only at
 * its actions.
 *
 * Every mutating server action on this step already calls
 * `requireAdminSession()` (`../actions.ts`), but the page itself rendered
 * provider-readiness state — which provider is committed, whether a stored
 * credential is fresh, which connector is installed — to any signed-in
 * member. Readiness is administrative state; the page must carry the same
 * gate its actions carry, and it must carry it BEFORE any readiness is
 * derived.
 *
 * `requireAdminSession()` redirects a non-admin to `/not-authorized`
 * (`@/lib/auth-session`), which in a server component surfaces as a thrown
 * Next redirect signal — the same shape the sibling page tests already model.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@cinatra-ai/sdk-extensions/llm-provider-contract", () => ({
  buildKnownWizardEligibleProviders: () => ["openai", "anthropic"],
}));

// The session under test. `requireAdminSession` reproduces the real
// comma-separated role split and the `/not-authorized` redirect from
// `@/lib/auth-session`.
const sessionState = { role: "user" };

function hasAdminRole(role: string) {
  return String(role ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes("admin");
}

const requireAdminSession = vi.fn(async () => {
  if (!hasAdminRole(sessionState.role)) {
    throw new Error("NEXT_REDIRECT:/not-authorized");
  }
  return { user: { id: "user-1", role: sessionState.role } };
});

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: () => requireAdminSession(),
}));

const deriveSetupAiStepState = vi.fn(async () => ({
  ready: false,
  locked: false,
  credentialFresh: false,
  commitState: { kind: "absent" as const },
}));

vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: () => ({}),
  getLlmProviderSurfacePackageName: () => null,
}));
vi.mock("@/lib/setup-readiness-saga", () => ({
  readAnthropicMcpMode: () => "native",
}));
vi.mock("@/lib/setup-provider-commit", () => ({
  deriveSetupAiStepState: () => deriveSetupAiStepState(),
}));
vi.mock("@/components/connector-brand-icons", () => ({
  connectorBrandIcon: () => null,
}));
vi.mock("@/app/setup/model/readiness-state", () => ({
  SETUP_CREDENTIAL_SAVE_STEP_ID: "credential-save",
  readSetupProviderSelection: () => null,
  readSetupReadinessFailure: () => null,
}));
vi.mock("@/app/setup/model/actions", () => ({
  selectSetupProviderAction: vi.fn(),
  continueSetupModelStepAction: vi.fn(),
  enableAnthropicNativeSkillDeliveryAction: vi.fn(),
}));
vi.mock("@/app/setup/model/openai-provider-step", () => ({
  SetupOpenAIProviderStep: () => <div data-testid="openai-step" />,
  isOpenAIConnectionReady: async () => false,
}));
vi.mock("@/app/setup/model/anthropic-provider-step", () => ({
  SetupAnthropicProviderStep: () => <div data-testid="anthropic-step" />,
  isAnthropicConnectionReady: async () => false,
}));
vi.mock("@/lib/setup-wizard", () => ({
  getSetupWizardSteps: vi.fn().mockResolvedValue([]),
  getFirstIncompleteStep: vi.fn().mockReturnValue({ id: "ai", href: "/setup/model" }),
}));

async function renderAiPage(): Promise<string> {
  const { default: SetupAiPage } = await import("../page");
  const ui = (await SetupAiPage({
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  return renderToStaticMarkup(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionState.role = "user";
});

describe("SetupAiPage — the step requires an administrator", () => {
  it("redirects a signed-in member to /not-authorized", async () => {
    sessionState.role = "user";

    await expect(renderAiPage()).rejects.toThrow("NEXT_REDIRECT:/not-authorized");
  });

  it("derives NO provider readiness for a member — the gate runs first", async () => {
    sessionState.role = "user";

    await expect(renderAiPage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(deriveSetupAiStepState).not.toHaveBeenCalled();
  });

  it("renders the step for an administrator", async () => {
    sessionState.role = "user,admin";

    const html = await renderAiPage();

    expect(requireAdminSession).toHaveBeenCalled();
    expect(deriveSetupAiStepState).toHaveBeenCalled();
    expect(html).toMatch(/data-testid="setup-provider-openai"/);
    expect(html).toMatch(/data-testid="setup-provider-anthropic"/);
  });
});

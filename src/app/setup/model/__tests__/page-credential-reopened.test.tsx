/**
 * cinatra#2504 — the "saved credentials changed" alert on the LLM Provider
 * step is FALSE for a legacy commitment whose credential fingerprint was
 * never captured (a pre-openai-connector-0.1.9 commitment): nothing was
 * removed or rotated, the fingerprint simply predates capture. This pins:
 *
 *  - the legacy ("never captured") copy renders when
 *    `credentialFingerprintNeverCaptured` is true, and the rotation/removal
 *    copy does NOT;
 *  - the existing rotation/removal copy still renders unchanged for a
 *    genuine fingerprint mismatch (`credentialFingerprintNeverCaptured:
 *    false`);
 *  - neither alert renders once the credential reads fresh.
 *
 * Same mock-shape conventions as ../page-provider-cards.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  // cinatra#2502 item E — the step's one form is a client island that refreshes
  // the route once a result arrives, so a static render of this page now pulls
  // `useRouter` in.
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@cinatra-ai/sdk-extensions/llm-provider-contract", () => ({
  buildKnownWizardEligibleProviders: () => ["openai", "anthropic"],
}));

// Mutable per-test state for the seams the assertions vary.
const aiState = {
  credentialFresh: false,
  credentialFingerprintNeverCaptured: false,
};

vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: () => ({}),
  getLlmProviderSurfacePackageName: () => null,
}));
vi.mock("@/lib/setup-readiness-saga", () => ({
  readAnthropicMcpMode: () => "native",
}));
vi.mock("@/lib/setup-provider-commit", () => ({
  deriveSetupAiStepState: async () => ({
    ready: false,
    locked: true,
    credentialFresh: aiState.credentialFresh,
    credentialFingerprintNeverCaptured: aiState.credentialFingerprintNeverCaptured,
    commitState: { kind: "committed", commitment: { provider: "openai" } },
  }),
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
  aiState.credentialFresh = false;
  aiState.credentialFingerprintNeverCaptured = false;
});

describe("SetupAiPage — the reopened-key alert distinguishes 'never captured' from a real rotation (cinatra#2504)", () => {
  it("renders the accurate legacy copy for a NEVER-CAPTURED fingerprint — and NOT the false rotation/removal claim", async () => {
    aiState.credentialFingerprintNeverCaptured = true;
    const html = await renderAiPage();

    expect(html).toMatch(/data-testid="setup-credential-reopened"/);
    expect(html).toMatch(/This setup predates credential verification/);
    expect(html).toMatch(/press Continue to\s*verify the saved key now/);
    expect(html).toMatch(/do not need to re-enter it/);
    // The false-for-this-case claim must not appear.
    expect(html).not.toMatch(/removed, rotated, or can no longer be read/);
    expect(html).not.toMatch(/The saved credentials changed/);
  });

  it("still renders the rotation/removal copy, unchanged, for a genuine fingerprint mismatch", async () => {
    aiState.credentialFingerprintNeverCaptured = false;
    const html = await renderAiPage();

    expect(html).toMatch(/data-testid="setup-credential-reopened"/);
    expect(html).toMatch(/The saved credentials changed/);
    expect(html).toMatch(/removed, rotated, or can no longer be read/);
    // The legacy copy must not appear.
    expect(html).not.toMatch(/predates credential verification/);
  });

  it("renders neither alert once the credential reads fresh", async () => {
    aiState.credentialFresh = true;
    aiState.credentialFingerprintNeverCaptured = false;
    const html = await renderAiPage();

    expect(html).not.toMatch(/data-testid="setup-credential-reopened"/);
    expect(html).not.toMatch(/The saved credentials changed/);
    expect(html).not.toMatch(/predates credential verification/);
  });
});

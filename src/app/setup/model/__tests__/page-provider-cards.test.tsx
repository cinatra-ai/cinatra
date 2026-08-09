/**
 * cinatra#2477 (owner acceptance review) — the two provider cards on the LLM
 * Provider step carry NO descriptive copy: logo + provider name only. The
 * only text a card may still show below its label is FUNCTIONAL state — the
 * connector-not-installed notice and the choice-locked notice.
 *
 * renderToStaticMarkup over the server component with every heavy seam
 * stubbed (same mock-shape conventions as
 * ../../sign-up/__tests__/page.test.tsx and
 * ../../name/__tests__/page-card-removal.test.tsx).
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
const surfaceState = {
  installed: true,
};
const commitStateBox: { value: unknown } = {
  value: { kind: "absent" },
};
const aiReadyBox = { credentialFresh: false };

vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: () => (surfaceState.installed ? {} : null),
  getLlmProviderSurfacePackageName: () => null,
}));
vi.mock("@/lib/setup-readiness-saga", () => ({
  readAnthropicMcpMode: () => "native",
}));
vi.mock("@/lib/setup-provider-commit", () => ({
  deriveSetupAiStepState: async () => ({
    ready: false,
    locked: false,
    credentialFresh: aiReadyBox.credentialFresh,
    commitState: commitStateBox.value,
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
  surfaceState.installed = true;
  commitStateBox.value = { kind: "absent" };
  aiReadyBox.credentialFresh = false;
});

describe("SetupAiPage — provider cards carry no descriptive copy (cinatra#2477)", () => {
  it("renders both cards with the provider name only — the descriptive blurbs are gone", async () => {
    const html = await renderAiPage();

    expect(html).toMatch(/data-testid="setup-provider-openai"/);
    expect(html).toMatch(/data-testid="setup-provider-anthropic"/);
    expect(html).toContain("OpenAI");
    expect(html).toContain("Anthropic");

    // The removed blurbs (both cards' descriptive copy).
    expect(html).not.toMatch(/Runs the chat assistant/);
    expect(html).not.toMatch(/delivers your skills natively/);
    expect(html).not.toMatch(/you will be asked to confirm/);
  });

  it("still renders the FUNCTIONAL not-installed notice when a connector is absent", async () => {
    surfaceState.installed = false;
    const html = await renderAiPage();
    expect(html).toMatch(/connector is not installed or active on this instance/);
  });

  it("still renders the FUNCTIONAL locked-out notice on the non-committed card", async () => {
    commitStateBox.value = { kind: "committed", commitment: { provider: "openai" } };
    aiReadyBox.credentialFresh = true;
    const html = await renderAiPage();
    // The anthropic card is locked out by the openai commitment.
    expect(html).toMatch(/The provider choice is committed — changeable later in Administration\./);
    // Still no descriptive blurb anywhere.
    expect(html).not.toMatch(/Runs the chat assistant/);
  });
});

// @vitest-environment jsdom
/**
 * cinatra#2502 item E — ONE PRIMARY ACTION ON /setup/model.
 *
 * Design spec `specs/app-setup.html` revision 0.3.0 §I: "Each step advances on
 * a single right-aligned primary Continue. There is no per-step Save beside it
 * and no separate confirm: submitting Continue is what persists the step's
 * input, validates it, and moves the wizard forward."
 *
 * The step used to carry two buttons that called two different actions — Save
 * persisted the credential, Continue ran the commit saga, and Continue's form
 * posted only a hidden `provider`, so it could not save. That is what these
 * arms pin as gone: the key field (and the Anthropic consent) now live INSIDE
 * the Continue form, so one submit carries them.
 *
 * Structural, not cosmetic: the assertions walk the rendered DOM and check
 * containment and submit-button counts, because "the field is in the form" is
 * exactly the property a string scan cannot express — the retired layout had
 * both elements on the page too, just in different forms.
 *
 * The provider sections render for REAL here (unlike ../page-provider-cards),
 * since the fields they contribute are the subject.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
// `prerenderToNodeStream`, not `renderToStaticMarkup`: the provider sections are
// ASYNC server components (they read the connector surface), and the synchronous
// renderer throws on the first suspend. The sibling render tests stub those
// components out, which is exactly what this file must not do — the fields they
// contribute are the subject.
import { prerenderToNodeStream } from "react-dom/static";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  useRouter: () => ({ refresh: () => {} }),
}));
// The step is administrator-only: the page calls `requireAdminSession()`
// before it derives anything (the gate itself is covered by
// ./page-admin-gate.test.tsx). These renders stand in an admin session so the
// gate is a no-op and the assertions below are unchanged.
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: async () => ({ user: { id: "user-1", role: "admin" } }),
}));
vi.mock("@cinatra-ai/sdk-extensions/llm-provider-contract", () => ({
  buildKnownWizardEligibleProviders: () => ["openai", "anthropic"],
}));

const selection = { provider: "openai" as string | null };
const optInStanding = { value: false };

// A surface that exists but reports NOT ready — the uncommitted first-run
// state, which is the one that renders a key field.
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: () => ({
    getConfiguredConnection: async () => null,
    isConnectionReady: () => false,
  }),
  getLlmProviderSurfacePackageName: () => null,
}));
vi.mock("@/lib/openai-connection-store", () => ({
  readOpenAIConnection: () => null,
}));
vi.mock("@/lib/setup-readiness-saga", () => ({
  readAnthropicMcpMode: () => "native",
  isAnthropicUploadOptInStanding: () => optInStanding.value,
}));
vi.mock("@/lib/setup-provider-commit", () => ({
  deriveSetupAiStepState: async () => ({
    ready: false,
    locked: false,
    credentialFresh: false,
    credentialFingerprintNeverCaptured: false,
    commitState: { kind: "absent" },
  }),
}));
vi.mock("@/components/connector-brand-icons", () => ({
  connectorBrandIcon: () => null,
}));
vi.mock("@/app/setup/model/readiness-state", () => ({
  SETUP_CREDENTIAL_SAVE_STEP_ID: "credential-save",
  ANTHROPIC_SETUP_CONSENT_FIELD: "consentToSkillsUpload",
  readSetupProviderSelection: () => selection.provider,
  readSetupReadinessFailure: () => null,
}));
vi.mock("@/app/setup/model/actions", () => ({
  selectSetupProviderAction: vi.fn(),
  continueSetupModelStepAction: vi.fn(),
  enableAnthropicNativeSkillDeliveryAction: vi.fn(),
}));
vi.mock("@/lib/setup-wizard", () => ({
  getSetupWizardSteps: vi.fn().mockResolvedValue([]),
  getFirstIncompleteStep: vi.fn().mockReturnValue({ id: "ai", href: "/setup/model" }),
}));

async function renderAiPage(): Promise<Document> {
  const { default: SetupAiPage } = await import("../page");
  const ui = (await SetupAiPage({
    searchParams: Promise.resolve({ stay: "1" }),
  })) as ReactElement;
  const { prelude } = await prerenderToNodeStream(ui);
  const html = await new Promise<string>((resolve, reject) => {
    let out = "";
    prelude.setEncoding("utf8");
    prelude.on("data", (chunk: string) => {
      out += chunk;
    });
    prelude.on("end", () => resolve(out));
    prelude.on("error", reject);
  });
  const doc = document.implementation.createHTMLDocument("step");
  doc.body.innerHTML = html;
  return doc;
}

/** The step's own form — the one carrying Continue, not a provider-card form. */
function stepForm(doc: Document): HTMLFormElement {
  const form = doc.querySelector<HTMLFormElement>(
    'form:has([data-testid="setup-ai-continue"])',
  );
  expect(form, "the step must render a form containing Continue").not.toBeNull();
  return form!;
}

beforeEach(() => {
  vi.clearAllMocks();
  selection.provider = "openai";
  optInStanding.value = false;
});

describe("item E — the model step advances on ONE primary Continue", () => {
  it("puts the OpenAI key field INSIDE the Continue form", async () => {
    const doc = await renderAiPage();
    const form = stepForm(doc);

    const key = doc.querySelector('input[name="apiKey"]');
    expect(key, "the key field must render on an uncommitted step").not.toBeNull();
    // THE FOLD: containment, not co-location. The retired layout had both on the
    // page — in two different forms, which is why Continue could not save.
    expect(form.contains(key)).toBe(true);
    // The provider the submission commits travels with it.
    expect(form.querySelector('input[name="provider"]')?.getAttribute("value")).toBe("openai");
  });

  it("renders exactly ONE submit control in that form, and it is Continue", async () => {
    const doc = await renderAiPage();
    const form = stepForm(doc);

    const submits = form.querySelectorAll('button[type="submit"]');
    expect(submits).toHaveLength(1);
    expect(submits[0].getAttribute("data-testid")).toBe("setup-ai-continue");
    expect(submits[0].textContent?.trim()).toMatch(/^continue$/i);
  });

  it("retires the separate Save/Change button entirely", async () => {
    const doc = await renderAiPage();
    // Every button on the step, by its own label. A "Save" or "Change" here is
    // the second primary action §I forbids.
    const labels = Array.from(doc.querySelectorAll("button")).map((b) =>
      (b.textContent ?? "").trim(),
    );
    expect(labels).not.toContain("Save");
    expect(labels).not.toContain("Change");
    expect(labels.filter((l) => /^continue$/i.test(l))).toHaveLength(1);
  });

  it("folds the Anthropic consent into the SAME submission as the key", async () => {
    selection.provider = "anthropic";
    const doc = await renderAiPage();
    const form = stepForm(doc);

    const key = doc.querySelector('input[name="apiKey"]');
    const consent = doc.querySelector('[data-testid="setup-anthropic-consent"]');
    expect(key).not.toBeNull();
    expect(consent, "the consent control must render while the opt-in does not stand").not.toBeNull();
    // One transaction boundary, one submission: the consent cannot be recorded
    // by a press the key did not ride along with.
    expect(form.contains(key)).toBe(true);
    expect(form.contains(consent)).toBe(true);
  });

  it("keeps the native `required` consent backstop in step with the server rule", async () => {
    selection.provider = "anthropic";

    // Read off `aria-required`, which is what the Radix checkbox reflects the
    // `required` prop as on the control the operator actually clicks (it also
    // mirrors it onto its hidden bubble input, which is what makes the native
    // constraint fire).
    // Opt-in NOT standing: the server demands the consent, so the control does.
    const demanding = await renderAiPage();
    expect(
      demanding
        .querySelector('[data-testid="setup-anthropic-consent"]')
        ?.getAttribute("aria-required"),
    ).toBe("true");

    // Opt-in standing (the reopened-key flow on an already-consented
    // workspace): the server accepts a Continue without it, so a `required`
    // attribute here would block a submission the server would have taken.
    optInStanding.value = true;
    const relaxed = await renderAiPage();
    const consent = relaxed.querySelector('[data-testid="setup-anthropic-consent"]');
    if (consent) expect(consent.getAttribute("aria-required")).not.toBe("true");
  });

  it("keeps the fix-forward form OUT of the step form — nested forms are invalid markup", async () => {
    const doc = await renderAiPage();
    const form = stepForm(doc);
    expect(form.querySelector("form")).toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * Tests for EmailTestDeliveryFormRenderer (DESIGN-V3 contract (8) rework).
 *
 * The renderer is now a PURE snapshot → onChange surface: it performs NO send
 * (no client fetch, no /api/test-delivery/send). Both actions RESOLVE the gate
 * by emitting a JSON envelope at BOTH top-level `userResponse` (the WayFlow
 * resume-bridge key) AND `testResult` (the declared node output):
 *   - Send     → { action:"send", recipientEmail, selectionMode, ...ids }
 *   - Continue → { action:"continue" }
 * The banner reflects ONLY the inbound `value.lastSendResult` the run supplied
 * on re-entry. Latency is honest: Send disables both buttons + shows a pending
 * state; a re-entry (fresh `value.gateCycle`) clears it.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { EmailTestDeliveryFormRenderer } from "../email-test-delivery-form-renderer";
import type { FieldRendererContext } from "../field-renderer-registry";

const MINIMAL_CONTEXT: FieldRendererContext = { connectedApps: [] };

const BASE_VALUE = {
  campaignId: "camp_123",
  defaultRecipientEmail: "default@example.com",
  defaultSelectionMode: "random_initial" as const,
  initialDraftOptions: [
    { id: "draft-1", label: "Acme Co", subject: "Hello Acme" },
    { id: "draft-2", label: "Globex", subject: "Hello Globex" },
  ],
  followUpDraftOptions: [{ id: "fu-1", stepNumber: 2, subject: "Follow up 1" }],
};

function renderField(
  overrides: { onChange?: (v: unknown) => void; value?: unknown } = {},
) {
  const onChange = overrides.onChange ?? vi.fn();
  const utils = render(
    <EmailTestDeliveryFormRenderer
      fieldName="testForm"
      schema={{ "x-renderer": "@cinatra-ai/email-test-delivery-agent:input" }}
      value={overrides.value ?? BASE_VALUE}
      onChange={onChange}
      context={MINIMAL_CONTEXT}
    />,
  );
  return { onChange, ...utils };
}

/** Decodes the emitted onChange payload, asserting the two-key envelope contract. */
function decodeEnvelope(onChange: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const payload = onChange.mock.calls[0][0] as Record<string, unknown>;
  // Exactly the two expected keys, both JSON strings carrying the SAME envelope.
  expect(new Set(Object.keys(payload))).toEqual(new Set(["userResponse", "testResult"]));
  expect(typeof payload.userResponse).toBe("string");
  expect(typeof payload.testResult).toBe("string");
  expect(payload.userResponse).toBe(payload.testResult);
  return JSON.parse(payload.testResult as string) as Record<string, unknown>;
}

describe("EmailTestDeliveryFormRenderer", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the form fields", () => {
    renderField();
    expect(document.querySelectorAll('input[name="recipientEmail"]').length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.getByText(/Test recipient email/i)).toBeTruthy();
    expect(screen.getByText(/What to send/i)).toBeTruthy();
  });

  it("renders no banner on first entry (no inbound lastSendResult)", () => {
    renderField();
    expect(document.querySelector('[data-testid="test-delivery-banner"]')).toBeNull();
  });

  it("performs NO client send (renderer never fetches)", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      renderField();
      fireEvent.click(screen.getByRole("button", { name: /send test email/i }));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a green banner from inbound lastSendResult (success)", () => {
    renderField({
      value: {
        ...BASE_VALUE,
        gateCycle: 1,
        lastSendResult: { ok: true, message: "Test email sent to default@example.com.", sentTo: "default@example.com" },
      },
    });
    const banner = document.querySelector('[data-testid="test-delivery-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("data-status")).toBe("success");
    expect(banner!.textContent).toContain("default@example.com");
  });

  it("shows a red banner from inbound lastSendResult (failure)", () => {
    renderField({
      value: {
        ...BASE_VALUE,
        gateCycle: 1,
        lastSendResult: { ok: false, message: "No drafts selected." },
      },
    });
    const banner = document.querySelector('[data-testid="test-delivery-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("data-status")).toBe("error");
    expect(banner!.textContent).toMatch(/no drafts/i);
  });

  it("Send resolves the gate with a { action:'send' } envelope (both keys)", () => {
    const { onChange } = renderField();
    fireEvent.click(screen.getByRole("button", { name: /send test email/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const decoded = decodeEnvelope(onChange as ReturnType<typeof vi.fn>);
    expect(decoded).toMatchObject({
      action: "send",
      recipientEmail: "default@example.com",
      selectionMode: "random_initial",
    });
    // No stray inbound/rehydration keys leak into the outbound envelope.
    expect(decoded.lastSendResult).toBeUndefined();
    expect(decoded.gateCycle).toBeUndefined();
  });

  it("Send with specific_initial carries the selected initial ids", () => {
    const { onChange } = renderField({
      value: {
        ...BASE_VALUE,
        defaultSelectionMode: "specific_initial" as const,
        defaultSpecificInitialDraftIds: ["draft-1", "draft-2"],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /send test email/i }));
    const decoded = decodeEnvelope(onChange as ReturnType<typeof vi.fn>);
    expect(decoded).toMatchObject({
      action: "send",
      selectionMode: "specific_initial",
      specificInitialDraftIds: ["draft-1", "draft-2"],
    });
  });

  it("Send disables both buttons and shows the pending state", () => {
    renderField();
    fireEvent.click(screen.getByRole("button", { name: /send test email/i }));
    expect(document.querySelector('[data-testid="test-delivery-pending"]')).not.toBeNull();
    const sendBtn = screen.getByRole("button", { name: /sending test/i }) as HTMLButtonElement;
    const continueBtn = screen.getByRole("button", { name: /^continue$/i }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    expect(continueBtn.disabled).toBe(true);
  });

  it("double-click Send resolves the gate only once (dedupe)", () => {
    const { onChange } = renderField();
    const sendBtn = screen.getByRole("button", { name: /send test email/i });
    fireEvent.click(sendBtn);
    fireEvent.click(sendBtn);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("Continue resolves the gate with a { action:'continue' } envelope (both keys)", () => {
    const { onChange } = renderField();
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const decoded = decodeEnvelope(onChange as ReturnType<typeof vi.fn>);
    expect(decoded).toEqual({ action: "continue" });
    // Old multi-output keys must not leak.
    expect((decoded as { continueRequested?: unknown }).continueRequested).toBeUndefined();
    expect((decoded as { lastSendResult?: unknown }).lastSendResult).toBeUndefined();
  });

  it("a fresh gateCycle clears the pending state (re-entry rehydration)", () => {
    const { onChange, rerender } = renderField({
      value: { ...BASE_VALUE, gateCycle: 0 },
    });
    fireEvent.click(screen.getByRole("button", { name: /send test email/i }));
    expect(document.querySelector('[data-testid="test-delivery-pending"]')).not.toBeNull();
    // The run re-enters the gate with a fresh server-produced gateCycle + result.
    rerender(
      <EmailTestDeliveryFormRenderer
        fieldName="testForm"
        schema={{ "x-renderer": "@cinatra-ai/email-test-delivery-agent:input" }}
        value={{
          ...BASE_VALUE,
          gateCycle: 1,
          lastSendResult: { ok: true, message: "Test email sent.", sentTo: "default@example.com" },
        }}
        onChange={onChange}
        context={MINIMAL_CONTEXT}
      />,
    );
    // Pending cleared; buttons re-enabled; the real banner is shown.
    expect(document.querySelector('[data-testid="test-delivery-pending"]')).toBeNull();
    expect((screen.getByRole("button", { name: /send test email/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(document.querySelector('[data-testid="test-delivery-banner"]')).not.toBeNull();
  });

  it("a pre-claim FAILURE re-entry (advanced gateCycle) clears pending — never strands (F3)", () => {
    // F3: a pre-claim failure now records a `failed` ledger row that allocates a
    // fresh seq, so gateCycle ADVANCES on the failure re-entry (previously it
    // returned the unchanged max seq → gateCycle stayed put → the screen stranded
    // permanently disabled). This asserts the renderer clears pending + re-enables
    // the controls on a failure re-entry, driven purely by the advanced gateCycle.
    const { onChange, rerender } = renderField({
      value: { ...BASE_VALUE, gateCycle: 3 },
    });
    fireEvent.click(screen.getByRole("button", { name: /send test email/i }));
    expect(document.querySelector('[data-testid="test-delivery-pending"]')).not.toBeNull();
    expect((screen.getByRole("button", { name: /sending test/i }) as HTMLButtonElement).disabled).toBe(true);
    // The run re-enters the gate with a FRESH gateCycle carrying a FAILURE result.
    rerender(
      <EmailTestDeliveryFormRenderer
        fieldName="testForm"
        schema={{ "x-renderer": "@cinatra-ai/email-test-delivery-agent:input" }}
        value={{
          ...BASE_VALUE,
          gateCycle: 4, // advanced by the recorded pre-claim failure row's seq
          lastSendResult: { ok: false, message: "Enter a valid recipient email address for the test send." },
        }}
        onChange={onChange}
        context={MINIMAL_CONTEXT}
      />,
    );
    // Pending cleared, controls RE-ENABLED (the user can correct + retry), and the
    // failure banner is shown — the screen is never stranded.
    expect(document.querySelector('[data-testid="test-delivery-pending"]')).toBeNull();
    expect((screen.getByRole("button", { name: /send test email/i }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /^continue$/i }) as HTMLButtonElement).disabled).toBe(false);
    const banner = document.querySelector('[data-testid="test-delivery-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("data-status")).toBe("error");
  });
});

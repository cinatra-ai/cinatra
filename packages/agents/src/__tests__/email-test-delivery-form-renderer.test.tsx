// @vitest-environment jsdom
/**
 * Tests for EmailTestDeliveryFormRenderer.
 *
 * Asserts:
 *   - Renders all archive form fields (recipientEmail input, selectionMode,
 *     and conditional draft option groups).
 *   - Initial banner state is null.
 *   - Send button POSTs to /api/test-delivery/send and updates banner on success.
 *   - Send button updates banner on error.
 *   - Continue button calls onChange({ continueRequested: true, lastSendResult }).
 *   - Send does NOT call onChange (gate stays unresolved).
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

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
  followUpDraftOptions: [
    { id: "fu-1", stepNumber: 2, subject: "Follow up 1" },
  ],
};

function renderField(overrides: { onChange?: (v: unknown) => void; value?: unknown } = {}) {
  const onChange = overrides.onChange ?? vi.fn();
  return {
    onChange,
    ...render(
      <EmailTestDeliveryFormRenderer
        fieldName="testForm"
        schema={{ "x-renderer": "@cinatra-ai/email-test-delivery-agent:input" }}
        value={overrides.value ?? BASE_VALUE}
        onChange={onChange}
        context={MINIMAL_CONTEXT}
      />,
    ),
  };
}

describe("EmailTestDeliveryFormRenderer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the archive form fields", () => {
    renderField();
    // Recipient email input — by name attribute
    const inputs = document.querySelectorAll('input[name="recipientEmail"]');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    // Selection mode (rendered inside Select — stub renders as div); check label text
    expect(screen.getByText(/Test recipient email/i)).toBeTruthy();
    expect(screen.getByText(/What to send/i)).toBeTruthy();
  });

  it("renders no banner on initial mount", () => {
    renderField();
    expect(document.querySelector('[data-testid="test-delivery-banner"]')).toBeNull();
  });

  it("Send button: success → green banner with recipient", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, sentTo: "default@example.com" }),
    });
    const { onChange } = renderField();
    const sendBtn = screen.getByRole("button", { name: /send test email/i });
    await act(async () => {
      fireEvent.click(sendBtn);
    });
    await waitFor(() => {
      const banner = document.querySelector('[data-testid="test-delivery-banner"]');
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain("default@example.com");
      expect(banner!.getAttribute("data-status")).toBe("success");
    });
    expect(onChange).not.toHaveBeenCalled();
    // Verify fetch URL
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toBe("/api/test-delivery/send");
  });

  it("Send button: server error → red banner", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: "boom" }),
    });
    const { onChange } = renderField();
    const sendBtn = screen.getByRole("button", { name: /send test email/i });
    await act(async () => {
      fireEvent.click(sendBtn);
    });
    await waitFor(() => {
      const banner = document.querySelector('[data-testid="test-delivery-banner"]');
      expect(banner).not.toBeNull();
      expect(banner!.getAttribute("data-status")).toBe("error");
      expect(banner!.textContent).toMatch(/boom/i);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Continue button calls onChange with testResult JSON envelope (userResponse + lastSendResult)", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, sentTo: "default@example.com" }),
    });
    const { onChange } = renderField();
    // Send first to populate lastSendResult
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /send test email/i }));
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="test-delivery-banner"]')).not.toBeNull();
    });
    const continueBtn = screen.getByRole("button", { name: /continue/i });
    fireEvent.click(continueBtn);
    expect(onChange).toHaveBeenCalledTimes(1);
    const payload = (onChange as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      testResult: string;
    };
    expect(typeof payload.testResult).toBe("string");
    const decoded = JSON.parse(payload.testResult) as {
      userResponse: string;
      lastSendResult: { ok?: boolean } | null;
    };
    expect(decoded).toMatchObject({ userResponse: "continue" });
    expect(decoded.lastSendResult).toMatchObject({ ok: true });
  });

  it("Continue with no prior send still resolves the gate (lastSendResult: null)", () => {
    const { onChange } = renderField();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const payload = (onChange as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      testResult: string;
    };
    expect(JSON.parse(payload.testResult)).toEqual({
      userResponse: "continue",
      lastSendResult: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Single string-output contract
//
// The OAS 26.1.0 InputMessageNode contract requires exactly ONE output. The
// renderer must therefore emit `{ testResult: "<json-string>" }` whose
// JSON.parse is `{ userResponse, lastSendResult }`. Top-level
// `continueRequested` / `lastSendResult` keys must NOT appear on the
// emitted payload.
// ---------------------------------------------------------------------------
describe("EmailTestDeliveryFormRenderer — single string-output contract", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("Continue emits a single `testResult` JSON-string keyed payload", () => {
    const { onChange } = renderField();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const payload = (onChange as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;

    // Exactly one key, named `testResult`, value is a JSON string.
    expect(Object.keys(payload)).toEqual(["testResult"]);
    expect(typeof payload.testResult).toBe("string");

    // Old multi-output keys MUST NOT leak.
    expect((payload as { continueRequested?: unknown }).continueRequested).toBeUndefined();
    expect((payload as { lastSendResult?: unknown }).lastSendResult).toBeUndefined();

    // Round-trip: JSON.parse → { userResponse, lastSendResult }.
    const decoded = JSON.parse(payload.testResult as string) as {
      userResponse?: unknown;
      lastSendResult: unknown;
    };
    expect(decoded).toHaveProperty("userResponse");
    expect(decoded).toHaveProperty("lastSendResult");
  });
});

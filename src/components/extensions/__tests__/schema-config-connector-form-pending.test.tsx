// @vitest-environment jsdom
//
// THE WAIT THE PERSON CAN SEE.
//
// Measured on a live acceptance round: a press on a connector's "Add schedule"
// action whose handler had stopped left the screen with no spinner, no message
// and no progress text thirty seconds later. The only feedback was the button
// repainting into a greyed-out state — which reads exactly like a button that
// refused the press, not like one that is working.
//
// The surface now says both halves out loud: a spinner while the action is in
// flight, and, when nothing comes back at all, a bounded give-up phrased for a
// person instead of an abort's own "signal is aborted" text.

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSchemaConfig } from "@/lib/extension-schema-config";
import { SchemaConfigConnectorForm } from "@/components/extensions/schema-config-connector-form";
import { toast } from "@/lib/cinatra-toast";

vi.mock("@/lib/cinatra-toast", () => {
  const base = vi.fn();
  const t = Object.assign(base, {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    promise: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  });
  return { toast: t, cinatraToast: t };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The appointment-schedules shape: one text field + one named action. */
const SURFACE = {
  fields: [
    { kind: "text", key: "bookingPageUrl", label: "Booking page URL" },
    { kind: "named-action", label: "Add schedule", actionId: "addSchedule" },
  ],
} as const;

function surfaceOf(raw: unknown) {
  const parsed = parseSchemaConfig(raw);
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.errors.join("; ")}`);
  return parsed.surface;
}

async function renderForm() {
  await act(async () => {
    root.render(
      <SchemaConfigConnectorForm installId="i1" packageName="@x/y" surface={surfaceOf(SURFACE)} />,
    );
  });
}

function actionButton() {
  const btn = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Add schedule"),
  );
  expect(btn).toBeTruthy();
  return btn!;
}

function spinnerIn(el: Element) {
  return el.querySelector('[role="status"]');
}

describe("a named action's visible wait", () => {
  it("shows a spinner on the button while the action is in flight", async () => {
    let release: ((r: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ) as unknown as typeof fetch,
    );
    await renderForm();

    expect(spinnerIn(actionButton())).toBeNull();

    await act(async () => {
      actionButton().click();
      await Promise.resolve();
    });

    // In flight: the button is busy AND says so with the app's own spinner.
    const busy = actionButton();
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(spinnerIn(busy)).not.toBeNull();

    await act(async () => {
      release!(new Response(JSON.stringify({ result: {} }), { status: 200 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spinnerIn(actionButton())).toBeNull();
  });

  it("a request that never answers ends in a readable give-up, not an abort's own words", async () => {
    const abortError = new DOMException("signal timed out", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn(async () => { throw abortError; }) as unknown as typeof fetch);
    await renderForm();

    await act(async () => {
      actionButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toast.success).not.toHaveBeenCalled();
    const message = vi.mocked(toast.error).mock.calls[0]?.[0] as string;
    expect(message).toContain("did not respond in time");
    expect(message).not.toContain("signal");
    // And the button is pressable again — never left greyed out for good.
    expect(actionButton().hasAttribute("disabled")).toBe(false);
    expect(spinnerIn(actionButton())).toBeNull();
  });

  it("the action request carries a bound of its own", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await renderForm();

    await act(async () => {
      actionButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

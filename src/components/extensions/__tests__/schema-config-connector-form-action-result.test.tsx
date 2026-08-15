// @vitest-environment jsdom
//
// cinatra#2752 — the schema-config shell's ACTION-RESULT verdict.
//
// A named action's HTTP 200 says only that the handler RAN. A handler that
// reports failure by RETURNING `{ banner: "error", message }` instead of
// throwing (the google-appointment-schedules `addSchedule` shape, evidence
// E10/E11 of #2370 S4) used to land on `toast.success("Done.")` with its
// message discarded — every failed Add read as success.
//
// The shell now decides the verdict itself: a declared banner variant owns its
// tone (and yields to the server's own message on the non-success tones), a
// banner name the surface never declared FAILS SAFE to the error path, and only
// a result with no banner name at all is the plain "Done." confirmation. The
// fix is in the GENERIC shell, so every schema-config connector is covered.

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
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.info).mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function surfaceOf(raw: unknown) {
  const parsed = parseSchemaConfig(raw);
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.errors.join("; ")}`);
  return parsed.surface;
}

/** The appointment-schedules shape: a text field + an "Add schedule" named
 *  action, and NO banner field — the surface declares no banner vocabulary at
 *  all, which is exactly why the error banner used to be swallowed. */
const NO_BANNER_SURFACE = {
  fields: [
    { kind: "text", key: "bookingPageUrl", label: "Booking page URL" },
    { kind: "named-action", label: "Add schedule", actionId: "addSchedule" },
  ],
} as const;

/** A surface that DOES declare a banner vocabulary (the openai/apify shape). */
const DECLARED_BANNER_SURFACE = {
  fields: [
    {
      kind: "banner",
      label: "Result",
      variants: [
        { name: "saved", tone: "success", message: "Saved!" },
        { name: "error", tone: "destructive", message: "Couldn't save the settings." },
      ],
    },
    { kind: "named-action", label: "Save", actionId: "save" },
  ],
} as const;

/** Stub the action endpoint with one canned JSON body + status. */
function stubAction(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

async function renderForm(surface: ReturnType<typeof surfaceOf>) {
  await act(async () => {
    root.render(
      <SchemaConfigConnectorForm installId="i1" packageName="@x/y" surface={surface} />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function clickAction(label: string) {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(btn).toBeTruthy();
  await act(async () => {
    btn!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("schema-config action results — the error-banner verdict (#2752)", () => {
  it("E10 repro: a `{banner:'error'}` result toasts the SERVER's message as an error, never Done.", async () => {
    stubAction({
      result: {
        banner: "error",
        message: "Use a public Google Calendar appointment schedule link from calendar.app.google.",
      },
    });
    await renderForm(surfaceOf(NO_BANNER_SURFACE));
    await clickAction("Add schedule");

    expect(toast.error).toHaveBeenCalledWith(
      "Use a public Google Calendar appointment schedule link from calendar.app.google.",
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("E11 repro: the 404 add-failure message reaches the user as an error too", async () => {
    stubAction({
      result: { banner: "error", message: "Unable to load the appointment schedule page (404)." },
    });
    await renderForm(surfaceOf(NO_BANNER_SURFACE));
    await clickAction("Add schedule");

    expect(toast.error).toHaveBeenCalledWith("Unable to load the appointment schedule page (404).");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("an UNKNOWN banner name fails safe to the error path — never toast.success", async () => {
    // The surface declares "saved" and "error"; the handler answers with a name
    // it never declared. The shell cannot interpret that outcome, so it refuses
    // to call it a success.
    stubAction({ result: { banner: "somethingNobodyDeclared" } });
    await renderForm(surfaceOf(DECLARED_BANNER_SURFACE));
    await clickAction("Save");

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    // With no server message it falls back to the declared "error" variant's
    // static text rather than inventing one.
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the settings.");
  });

  it("an unknown banner name on a surface with NO banner vocabulary also fails safe", async () => {
    stubAction({ result: { banner: "somethingNobodyDeclared" } });
    await renderForm(surfaceOf(NO_BANNER_SURFACE));
    await clickAction("Add schedule");

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Action failed.");
  });

  it("a DECLARED error variant yields its static text to the server's own message", async () => {
    stubAction({ result: { banner: "error", message: "401 invalid_api_key" } });
    await renderForm(surfaceOf(DECLARED_BANNER_SURFACE));
    await clickAction("Save");

    expect(toast.error).toHaveBeenCalledWith("401 invalid_api_key");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("a declared error variant with no server message keeps toasting its static text", async () => {
    stubAction({ result: { banner: "error" } });
    await renderForm(surfaceOf(DECLARED_BANNER_SURFACE));
    await clickAction("Save");

    expect(toast.error).toHaveBeenCalledWith("Couldn't save the settings.");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("a declared SUCCESS variant is unchanged — its static message toasts as success", async () => {
    stubAction({ result: { banner: "saved" } });
    await renderForm(surfaceOf(DECLARED_BANNER_SURFACE));
    await clickAction("Save");

    expect(toast.success).toHaveBeenCalledWith("Saved!");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a result carrying NO banner name is still the plain confirmation", async () => {
    stubAction({ result: {} });
    await renderForm(surfaceOf(NO_BANNER_SURFACE));
    await clickAction("Add schedule");

    expect(toast.success).toHaveBeenCalledWith("Done.");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a transport failure still toasts the action's own error text", async () => {
    stubAction({ error: "Request failed (500)." }, 500);
    await renderForm(surfaceOf(NO_BANNER_SURFACE));
    await clickAction("Add schedule");

    expect(toast.error).toHaveBeenCalledWith("Request failed (500).");
    expect(toast.success).not.toHaveBeenCalled();
  });
});

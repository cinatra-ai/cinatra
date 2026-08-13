// @vitest-environment jsdom
//
// cinatra#1082 item 4 — EDIT-FIDELITY of the hydrated setup form.
//
// The host resolver (`resolveSchemaConfigInitialValues`, unit-tested in
// src/lib/__tests__/extension-config-hydration.test.ts) decides WHICH saved
// values reach the form. These tests pin what the RENDERER then does with
// them, which is the half the "edit fidelity" item is about:
//
//   1. every hydratable field kind actually pre-fills from `initialValues`
//      (and a `secret` never does), and
//   2. an UNTOUCHED hydrated form submits back exactly what it was hydrated
//      with — the no-loss property. A field that renders a saved value but
//      submits something else (or nothing) silently rewrites saved
//      configuration the user never edited, which is worse than the blank
//      form the hydration replaced.
//
// Property 2 is asserted against the REAL submit path (`collectFormInputs`
// over the live DOM, dispatched through the host action endpoint), not
// against props — that is the only thing the connector's write handler
// actually sees.

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSchemaConfig } from "@/lib/extension-schema-config";
import { SchemaConfigConnectorForm } from "@/components/extensions/schema-config-connector-form";

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
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function surfaceOf(raw: unknown) {
  const parsed = parseSchemaConfig(raw);
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.errors.join("; ")}`);
  return parsed.surface;
}

async function renderForm(props: React.ComponentProps<typeof SchemaConfigConnectorForm>) {
  await act(async () => {
    root.render(<SchemaConfigConnectorForm {...props} />);
  });
  // Flush the mount effects' fetch chains (deferred setState + response json()).
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The live value the submit path (`collectFormInputs`) would read for a key. */
function submittedValue(key: string): string | undefined {
  const el = container.querySelector<HTMLInputElement>(`input[name="${key}"]`);
  return el?.value;
}

/**
 * Stub `fetch` and return the recorded action requests. Mirrors the stub the
 * action-scoping test uses; `responder` serves individual actions so an
 * options load can be made to succeed, fail, hang, or come back empty.
 */
function stubActions(responder?: (actionId: string) => Promise<Response>): {
  calls: { actionId: string; body: Record<string, string> }[];
} {
  const calls: { actionId: string; body: Record<string, string> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const actionId = String(url).split("/").pop() ?? "";
      calls.push({ actionId, body: JSON.parse(String(init?.body ?? "{}")) });
      if (responder) return responder(actionId);
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }) as unknown as typeof fetch,
  );
  return { calls };
}

async function clickSave() {
  const trigger = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Save",
  );
  expect(trigger, "Save button").toBeTruthy();
  await act(async () => {
    trigger!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const SAVE_ACTION = { kind: "named-action", label: "Save", actionId: "save" } as const;

describe("hydrated setup form — per-kind pre-fill fidelity (cinatra#1082 item 4)", () => {
  it("pre-fills every hydratable field kind, and NEVER a secret", async () => {
    const surface = surfaceOf({
      fields: [
        { kind: "text", key: "projectId", label: "Project" },
        { kind: "secret", key: "apiKey", label: "API key" },
        { kind: "copyable-credential", key: "webhookUrl", label: "Webhook URL" },
        {
          kind: "select",
          key: "tier",
          label: "Tier",
          defaultValue: "standard",
          options: [
            { value: "standard", label: "Standard" },
            { value: "priority", label: "Priority" },
          ],
        },
        { kind: "boolean", key: "streaming", label: "Streaming", defaultValue: true },
        { kind: "number", key: "timeout", label: "Timeout", defaultValue: 30 },
        { kind: "free-list", key: "domains", label: "Domains" },
      ],
    });
    await renderForm({
      installId: "i1",
      packageName: "@x/c",
      surface,
      initialValues: {
        projectId: "proj_saved",
        apiKey: "sk-must-never-render",
        webhookUrl: "https://hooks.example/abc",
        tier: "priority",
        // Explicit "false" must beat the declared `defaultValue: true` — a
        // saved OFF toggle rendering ON would flip the setting on the next save.
        streaming: "false",
        timeout: "90",
        domains: JSON.stringify(["a.example", "b.example"]),
      },
    });

    expect(submittedValue("projectId")).toBe("proj_saved");
    expect(submittedValue("tier")).toBe("priority");
    expect(submittedValue("streaming")).toBe("false");
    expect(submittedValue("timeout")).toBe("90");
    expect(JSON.parse(submittedValue("domains") ?? "null")).toEqual(["a.example", "b.example"]);
    // The copyable credential is a read-only DISPLAY row: it renders the saved
    // value in its own input but carries no `name`, so it never enters a
    // submission (the connector owns the value; the form only shows it).
    const copyable = container.querySelector<HTMLInputElement>("#webhookUrl");
    expect(copyable?.value).toBe("https://hooks.example/abc");
    expect(copyable?.getAttribute("name")).toBeNull();
    // The secret field is present but EMPTY, and its value appears nowhere.
    expect(submittedValue("apiKey")).toBe("");
    expect(container.innerHTML).not.toContain("sk-must-never-render");
  });

  it("an UNTOUCHED hydrated form submits back exactly what it was hydrated with", async () => {
    const { calls } = stubActions();
    const surface = surfaceOf({
      fields: [
        { kind: "text", key: "projectId", label: "Project" },
        { kind: "secret", key: "apiKey", label: "API key" },
        {
          kind: "select",
          key: "tier",
          label: "Tier",
          defaultValue: "standard",
          options: [
            { value: "standard", label: "Standard" },
            { value: "priority", label: "Priority" },
          ],
        },
        { kind: "boolean", key: "streaming", label: "Streaming", defaultValue: true },
        { kind: "number", key: "timeout", label: "Timeout", defaultValue: 30 },
        SAVE_ACTION,
      ],
    });
    await renderForm({
      installId: "i1",
      packageName: "@x/c",
      surface,
      initialValues: {
        projectId: "proj_saved",
        tier: "priority",
        streaming: "false",
        timeout: "90",
      },
    });
    await clickSave();

    const save = calls.find((c) => c.actionId === "save");
    expect(save?.body).toEqual({
      projectId: "proj_saved",
      // A write-only secret submits empty — the connector reads "unchanged".
      apiKey: "",
      tier: "priority",
      streaming: "false",
      timeout: "90",
    });
  });

  it("hydrates fields that live in a TAB panel, not only the flat fields", async () => {
    const surface = surfaceOf({
      fields: [{ kind: "text", key: "projectId", label: "Project" }],
      tabs: [
        {
          id: "advanced",
          label: "Advanced",
          fields: [{ kind: "text", key: "region", label: "Region" }],
        },
      ],
    });
    await renderForm({
      installId: "i1",
      packageName: "@x/c",
      surface,
      initialValues: { projectId: "proj_saved", region: "eu-central" },
    });
    // Tab panels are force-mounted so the submit scan sees them; the hydrated
    // value must reach the panel field too (collectHydrationKeySets admits
    // tab keys, so the renderer must honour them).
    expect(submittedValue("region")).toBe("eu-central");
  });
});

describe("hydrated dynamic-select-options — the saved value survives an options load that cannot serve it", () => {
  const surface = surfaceOf({
    fields: [
      {
        kind: "dynamic-select-options",
        key: "defaultModel",
        label: "Default model",
        optionsAction: "listModels",
        defaultValue: "gpt-5.5",
        placeholder: "Save a working key first.",
      },
      SAVE_ACTION,
    ],
  });

  it("keeps the saved value while the options are still LOADING", async () => {
    // An options action that never settles: the picker stays in its loading
    // state, so the user cannot have chosen anything.
    stubActions((actionId) =>
      actionId === "listModels"
        ? new Promise<Response>(() => {})
        : Promise.resolve(new Response(JSON.stringify({ result: {} }), { status: 200 })),
    );
    await renderForm({
      installId: "i1",
      packageName: "@x/c",
      surface,
      initialValues: { defaultModel: "gpt-5.5-pro" },
    });
    expect(container.querySelector('[data-testid="dynamic-select-loading"]')).toBeTruthy();
    expect(submittedValue("defaultModel")).toBe("gpt-5.5-pro");
  });

  it("keeps the saved value when the options action FAILS, and submits it back", async () => {
    // This is the openai `listModels` case: the options action calls the live
    // provider and fails (rejected/expired key). The field renders an error
    // instead of a picker, so the user cannot pick — submitting an empty
    // value here would ask the connector to rewrite a setting nobody touched.
    const { calls } = stubActions((actionId) =>
      Promise.resolve(
        actionId === "listModels"
          ? new Response(JSON.stringify({ error: "401 invalid_api_key" }), { status: 500 })
          : new Response(JSON.stringify({ result: {} }), { status: 200 }),
      ),
    );
    await renderForm({
      installId: "i1",
      packageName: "@x/c",
      surface,
      initialValues: { defaultModel: "gpt-5.5-pro" },
    });
    expect(container.querySelector('[data-testid="dynamic-select-error"]')).toBeTruthy();
    expect(submittedValue("defaultModel")).toBe("gpt-5.5-pro");

    await clickSave();
    expect(calls.find((c) => c.actionId === "save")?.body).toEqual({
      defaultModel: "gpt-5.5-pro",
    });
  });

  it("keeps the saved value when the options action returns NO options", async () => {
    stubActions((actionId) =>
      Promise.resolve(
        new Response(JSON.stringify({ result: actionId === "listModels" ? { options: [] } : {} }), {
          status: 200,
        }),
      ),
    );
    await renderForm({
      installId: "i1",
      packageName: "@x/c",
      surface,
      initialValues: { defaultModel: "gpt-5.5-pro" },
    });
    expect(container.querySelector('[data-testid="dynamic-select-empty"]')).toBeTruthy();
    expect(submittedValue("defaultModel")).toBe("gpt-5.5-pro");
  });

  it("selects the saved value once the options DO load, over the declared default", async () => {
    stubActions((actionId) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            result:
              actionId === "listModels"
                ? {
                    options: [
                      { value: "gpt-5.5", label: "GPT-5.5" },
                      { value: "gpt-5.5-pro", label: "GPT-5.5 Pro" },
                    ],
                  }
                : {},
          }),
          { status: 200 },
        ),
      ),
    );
    await renderForm({
      installId: "i1",
      packageName: "@x/c",
      surface,
      initialValues: { defaultModel: "gpt-5.5-pro" },
    });
    expect(submittedValue("defaultModel")).toBe("gpt-5.5-pro");
  });

  it("with NO saved value the declared default still wins once options load (opt-out unchanged)", async () => {
    stubActions((actionId) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            result:
              actionId === "listModels"
                ? {
                    options: [
                      { value: "gpt-5.4", label: "GPT-5.4" },
                      { value: "gpt-5.5", label: "GPT-5.5" },
                    ],
                  }
                : {},
          }),
          { status: 200 },
        ),
      ),
    );
    await renderForm({ installId: "i1", packageName: "@x/c", surface });
    expect(submittedValue("defaultModel")).toBe("gpt-5.5");
  });

  it("re-syncs to NEWLY hydrated values while a re-load is in flight (no remount)", async () => {
    // A fresh server render can hand the same mounted form new saved values
    // (e.g. after a route refresh). The options re-load is in flight — or
    // hangs — so nothing re-picks; the hidden input must already carry the NEW
    // saved value rather than the one the previous render seeded.
    stubActions((actionId) =>
      actionId === "listModels"
        ? new Promise<Response>(() => {})
        : Promise.resolve(new Response(JSON.stringify({ result: {} }), { status: 200 })),
    );
    const props = {
      installId: "i1",
      packageName: "@x/c",
      surface,
      initialValues: { defaultModel: "gpt-5.5-pro" },
    } as const;
    await renderForm(props);
    expect(submittedValue("defaultModel")).toBe("gpt-5.5-pro");

    await act(async () => {
      root.render(
        <SchemaConfigConnectorForm {...props} initialValues={{ defaultModel: "gpt-5.6" }} />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(submittedValue("defaultModel")).toBe("gpt-5.6");
  });

  it("a non-hydrating connector still submits an empty value when its options fail (no invented value)", async () => {
    // Fail-closed the other way: with nothing hydrated there is nothing to
    // preserve, so the field must NOT invent the declared default it could
    // not offer the user.
    stubActions((actionId) =>
      Promise.resolve(
        actionId === "listModels"
          ? new Response(JSON.stringify({ error: "boom" }), { status: 500 })
          : new Response(JSON.stringify({ result: {} }), { status: 200 }),
      ),
    );
    await renderForm({ installId: "i1", packageName: "@x/c", surface });
    expect(submittedValue("defaultModel")).toBe("");
  });
});

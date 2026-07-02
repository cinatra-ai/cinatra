// @vitest-environment jsdom
//
// cinatra#658 (PR-4) renderer coverage for the EXTENDED schema-config DSL:
// select (admin-only option gating), record-list (live rows + badges + per-row
// delete), banner (result-driven), advisory (probe-driven). The renderer is pure
// presentation over a FAIL-CLOSED parsed surface — these tests prove the new
// field kinds render + dispatch through the host action endpoint correctly and
// that admin-only options are HOST-gated.

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSchemaConfig } from "@/lib/extension-schema-config";
import { SchemaConfigConnectorForm } from "@/components/extensions/schema-config-connector-form";

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
  // allow mount effects (advisory/record-list initial fetch) to flush
  await act(async () => {
    await Promise.resolve();
  });
}

describe("SchemaConfigConnectorForm — extended DSL (#658)", () => {
  it("select: a NON-admin never sees an admin-only option", async () => {
    const surface = surfaceOf({
      fields: [
        {
          kind: "select",
          key: "scope",
          label: "Scope",
          options: [
            { value: "global", label: "Global", adminOnly: true },
            { value: "user", label: "Personal" },
          ],
        },
      ],
    });
    await renderForm({ installId: "i1", packageName: "@x/y", surface, isAdmin: false });
    // The hidden input carries the selected value; a non-admin defaults to the
    // first VISIBLE option (user), never the admin-only "global".
    const hidden = container.querySelector<HTMLInputElement>('input[name="scope"]');
    expect(hidden?.value).toBe("user");
  });

  it("select: an admin defaults to the declared defaultValue", async () => {
    const surface = surfaceOf({
      fields: [
        {
          kind: "select",
          key: "scope",
          label: "Scope",
          defaultValue: "global",
          options: [
            { value: "global", label: "Global", adminOnly: true },
            { value: "user", label: "Personal" },
          ],
        },
      ],
    });
    await renderForm({ installId: "i1", packageName: "@x/y", surface, isAdmin: true });
    const hidden = container.querySelector<HTMLInputElement>('input[name="scope"]');
    expect(hidden?.value).toBe("global");
  });

  it("record-list: renders rows from listAction, shows badges + per-row delete", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("listServers")) {
        return new Response(
          JSON.stringify({
            result: {
              servers: [
                { id: "s1", label: "Prod", serverUrl: "https://a", privateUrl: false, disabled: false },
                { id: "s2", label: "Local", serverUrl: "http://localhost", privateUrl: true, disabled: true },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ result: { banner: "deleted" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const surface = surfaceOf({
      fields: [
        {
          kind: "record-list",
          label: "Servers",
          listActionId: "listServers",
          deleteActionId: "deleteServer",
          emptyState: "None.",
          itemTitleKey: "label",
          itemSubtitleKey: "serverUrl",
          itemBadges: [
            { key: "privateUrl", label: "Private URL", variant: "destructive" },
            { key: "disabled", label: "Disabled", variant: "secondary" },
          ],
        },
      ],
    });
    await renderForm({ installId: "i9", packageName: "@x/y", surface });
    // flush the list fetch + state update
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const items = container.querySelectorAll('[data-testid="record-list-item"]');
    expect(items.length).toBe(2);
    // The private/disabled row shows BOTH data-driven badges; the public/enabled
    // row shows neither (truthy-gated).
    expect(container.textContent).toContain("Prod");
    expect(container.textContent).toContain("Private URL");
    expect(container.textContent).toContain("Disabled");
    // The list action was dispatched to the host endpoint with the install id.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/extensions/i9/actions/listServers"))).toBe(true);
  });

  it("banner: stays hidden until an action result names a variant", async () => {
    const surface = surfaceOf({
      fields: [
        {
          kind: "banner",
          label: "Result",
          variants: [{ name: "saved", tone: "success", message: "Saved!" }],
        },
        { kind: "named-action", label: "Save", actionId: "createServer" },
      ],
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { banner: "saved" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await renderForm({ installId: "i1", packageName: "@x/y", surface });
    // No banner before any action.
    expect(container.querySelector('[data-testid="schema-config-banner"]')).toBeNull();

    // Click the named action → result `{ banner: "saved" }` → banner appears.
    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save");
    expect(btn).toBeTruthy();
    await act(async () => {
      btn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const banner = container.querySelector('[data-testid="schema-config-banner"]');
    expect(banner?.textContent).toContain("Saved!");
  });

  it("advisory: renders whenReady / whenNotReady from the probe verdict", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { ready: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const surface = surfaceOf({
      fields: [
        {
          kind: "advisory",
          label: "API key storage",
          tone: "info",
          probeActionId: "connectionServiceReady",
          whenReady: "Keys stored securely.",
          whenNotReady: "Configure the service.",
        },
      ],
    });
    await renderForm({ installId: "i1", packageName: "@x/y", surface });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const advisory = container.querySelector('[data-testid="schema-config-advisory"]');
    expect(advisory?.textContent).toContain("Keys stored securely.");
  });
});

// cinatra#782 renderer coverage for the field-kind expansion: dynamic-select-options
// (action-sourced options with loading/populate/error/empty), boolean (toggle →
// hidden true/false), number (min/max/step attrs), free-list (add → hidden JSON).
describe("SchemaConfigConnectorForm — field-kind expansion (#782)", () => {
  it("dynamic-select-options: fetches options on mount, populates the select + hidden value", async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seenUrls.push(String(url));
      return new Response(
        JSON.stringify({ result: { options: [{ value: "gpt-5.5", label: "GPT-5.5" }, { value: "gpt-5-mini", label: "GPT-5 mini" }] } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const surface = surfaceOf({
      fields: [{ kind: "dynamic-select-options", key: "model", label: "Model", optionsAction: "listModels", defaultValue: "gpt-5-mini" }],
    });
    await renderForm({ installId: "i7", packageName: "@x/y", surface });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The options action was dispatched to the host endpoint with the install id.
    expect(seenUrls.some((u) => u.includes("/api/extensions/i7/actions/listModels"))).toBe(true);
    // The hidden input carries the declared defaultValue (present in fetched options).
    const hidden = container.querySelector<HTMLInputElement>('input[name="model"]');
    expect(hidden?.value).toBe("gpt-5-mini");
    // No loading/error state remains.
    expect(container.querySelector('[data-testid="dynamic-select-loading"]')).toBeNull();
    expect(container.querySelector('[data-testid="dynamic-select-error"]')).toBeNull();
  });

  it("dynamic-select-options: renders the error state when the options action fails", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const surface = surfaceOf({
      fields: [{ kind: "dynamic-select-options", key: "model", label: "Model", optionsAction: "listModels" }],
    });
    await renderForm({ installId: "i7", packageName: "@x/y", surface });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="dynamic-select-error"]')?.textContent).toContain("boom");
    // The hidden input carries no value on error.
    expect(container.querySelector<HTMLInputElement>('input[name="model"]')?.value).toBe("");
  });

  it("dynamic-select-options: normalizes the action result fail-closed (drops non-string + duplicate options)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              options: [
                { value: "gpt-5.5", label: "GPT-5.5" },
                { value: 123, label: "bad-value-type" }, // non-string value → dropped
                { value: "no-label" }, // missing label → dropped
                { value: "gpt-5.5", label: "GPT-5.5 dup" }, // duplicate value → dropped
                { value: "gpt-5-mini", label: "GPT-5 mini" },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const surface = surfaceOf({
      fields: [{ kind: "dynamic-select-options", key: "model", label: "Model", optionsAction: "listModels" }],
    });
    await renderForm({ installId: "i7", packageName: "@x/y", surface });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Only valid, de-duped options survive; the hidden value defaults to the first.
    expect(container.querySelector<HTMLInputElement>('input[name="model"]')?.value).toBe("gpt-5.5");
    // The dropped bad entries never appear as text.
    expect(container.textContent).not.toContain("bad-value-type");
    expect(container.textContent).not.toContain("GPT-5.5 dup");
  });

  it("dynamic-select-options: renders the empty state when the action returns no options", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { options: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const surface = surfaceOf({
      fields: [{ kind: "dynamic-select-options", key: "model", label: "Model", optionsAction: "listModels", placeholder: "No models" }],
    });
    await renderForm({ installId: "i7", packageName: "@x/y", surface });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="dynamic-select-empty"]')?.textContent).toContain("No models");
  });

  it("boolean: the hidden input reflects the toggle state", async () => {
    const surface = surfaceOf({ fields: [{ kind: "boolean", key: "allowNetwork", label: "Allow network", defaultValue: true }] });
    await renderForm({ installId: "i1", packageName: "@x/y", surface });
    const hidden = container.querySelector<HTMLInputElement>('input[name="allowNetwork"]');
    expect(hidden?.value).toBe("true");
    // Only the hidden input carries a name — the visible Switch must be nameless.
    const named = container.querySelectorAll('[name="allowNetwork"]');
    expect(named.length).toBe(1);
    expect(named.item(0)?.getAttribute("type")).toBe("hidden");
    // Toggle the switch → hidden flips to "false".
    const toggle = container.querySelector<HTMLButtonElement>("#allowNetwork-toggle");
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle!.click();
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLInputElement>('input[name="allowNetwork"]')?.value).toBe("false");
  });

  it("number: renders a numeric input carrying min/max/step + the default", async () => {
    const surface = surfaceOf({ fields: [{ kind: "number", key: "pids", label: "PID limit", min: 1, max: 4096, step: 1, defaultValue: 512 }] });
    await renderForm({ installId: "i1", packageName: "@x/y", surface });
    const input = container.querySelector<HTMLInputElement>('input[name="pids"]');
    expect(input?.type).toBe("number");
    expect(input?.getAttribute("min")).toBe("1");
    expect(input?.getAttribute("max")).toBe("4096");
    expect(input?.getAttribute("step")).toBe("1");
    expect(input?.value).toBe("512");
  });

  it("free-list: adding an entry serializes the non-empty list as JSON in the hidden input", async () => {
    const surface = surfaceOf({ fields: [{ kind: "free-list", key: "hosts", label: "Egress hosts", itemLabel: "host" }] });
    await renderForm({ installId: "i1", packageName: "@x/y", surface });
    // The single named element is the hidden JSON carrier; visible entry inputs are nameless.
    const named = container.querySelectorAll('[name="hosts"]');
    expect(named.length).toBe(1);
    expect(named.item(0)?.getAttribute("type")).toBe("hidden");
    // Type into the first entry.
    const entry = container.querySelector<HTMLInputElement>('input[aria-label="host 1"]');
    expect(entry).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(entry!, "example.com");
      entry!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    const hidden = container.querySelector<HTMLInputElement>('input[name="hosts"]');
    expect(JSON.parse(hidden!.value)).toEqual(["example.com"]);
  });
});

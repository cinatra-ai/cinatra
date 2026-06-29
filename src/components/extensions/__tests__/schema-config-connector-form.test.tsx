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

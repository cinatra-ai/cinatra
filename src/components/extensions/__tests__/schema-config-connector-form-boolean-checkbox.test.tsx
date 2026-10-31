// @vitest-environment jsdom
//
// The extension settings form's boolean row is a checkbox (cinatra#4309,
// connector-form site; the cron-picker site is #4355).
//
//   pnpm exec vitest run --config vitest.config.ts src/components/extensions/__tests__/schema-config-connector-form-boolean-checkbox.test.tsx
//
// The approved component rule reserves switches for settings that take effect
// at once and checkboxes for choices that a form action confirms. A boolean
// row of a schema-config form is written only when one of the form's own action
// buttons runs, so it is a confirmable form choice: the connectors drawing
// (app-connectors §II, the config tab's on / off rows) draws it as a checkbox
// with its label beside the box. The hidden input stays the only named element
// and still carries exactly "true" or "false". The box's accessible name comes
// only from that label, so the box has an id of its own for each mounted row.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { parseSchemaConfig } from "@/lib/extension-schema-config";
import { SchemaConfigConnectorForm } from "@/components/extensions/schema-config-connector-form";

// jsdom mounts the form outside any app-router context, where `useRouter`
// throws its invariant (the form refreshes the page after a successful action).
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => {},
    push: () => {},
    replace: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
  }),
}));

// Action outcomes toast through the canonical wrapper; stub it.
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LABEL = "Allow network";
const DESCRIPTION = "When enabled, the connector may reach the hosts listed below.";

function surfaceOf(raw: unknown) {
  const parsed = parseSchemaConfig(raw);
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.errors.join("; ")}`);
  return parsed.surface;
}

function booleanSurface(defaultValue: boolean | undefined, withSave = false) {
  return surfaceOf({
    fields: [
      {
        kind: "boolean",
        key: "allowNetwork",
        label: LABEL,
        ...(defaultValue === undefined ? {} : { defaultValue }),
        description: DESCRIPTION,
      },
      ...(withSave ? [{ kind: "named-action", label: "Save", actionId: "saveConfig" }] : []),
    ],
  });
}

function stubFetch() {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify({ result: {} }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function hiddenValues(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLInputElement>('[name="allowNetwork"]')].map(
    (el) => `${el.getAttribute("type")}=${el.value}`,
  );
}

async function renderForm(
  defaultValue: boolean | undefined,
  initialValues: Record<string, string> = {},
  opts: { withSave?: boolean; disabledFieldset?: boolean } = {},
) {
  const form = (
    <SchemaConfigConnectorForm
      installId="i4309"
      packageName="@x/boolean"
      surface={booleanSurface(defaultValue, opts.withSave)}
      initialValues={initialValues}
    />
  );
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(opts.disabledFieldset ? <fieldset disabled>{form}</fieldset> : form);
  });
  return view;
}

describe("schema-config form: the boolean row is a checkbox", () => {
  it("draws a checkbox named by the field's label, with the label beside the box, and no switch", async () => {
    const { container } = await renderForm(true);
    const control = screen.getByRole("checkbox", { name: LABEL });
    expect(control.getAttribute("data-slot")).toBe("checkbox");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(container.querySelector('[data-slot="switch"]')).toBeNull();
    // The label is a <label for> of the box, and it comes after the box.
    const label = container.querySelector<HTMLLabelElement>(`label[for="${control.id}"]`);
    expect(label?.textContent).toBe(LABEL);
    expect(control.compareDocumentPosition(label!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(DESCRIPTION)).toBeTruthy();
    // The visible checkbox is nameless: the hidden input is the only named element.
    expect(control.getAttribute("name")).toBeNull();
    expect(hiddenValues(container)).toEqual(["hidden=true"]);
  });

  it("shows the stored value over the declared default, and the default when nothing is stored", async () => {
    const stored = await renderForm(true, { allowNetwork: "false" });
    expect(screen.getByRole("checkbox", { name: LABEL }).getAttribute("aria-checked")).toBe("false");
    expect(hiddenValues(stored.container)).toEqual(["hidden=false"]);
    cleanup();

    const storedOn = await renderForm(false, { allowNetwork: "true" });
    expect(screen.getByRole("checkbox", { name: LABEL }).getAttribute("aria-checked")).toBe("true");
    expect(hiddenValues(storedOn.container)).toEqual(["hidden=true"]);
    cleanup();

    const none = await renderForm(undefined);
    expect(screen.getByRole("checkbox", { name: LABEL }).getAttribute("aria-checked")).toBe("false");
    expect(hiddenValues(none.container)).toEqual(["hidden=false"]);
  });

  it("sets the description at the row's left edge, below the line of the box and its label", async () => {
    const { container } = await renderForm(true);
    const control = screen.getByRole("checkbox", { name: LABEL });
    const label = container.querySelector<HTMLLabelElement>(`label[for="${control.id}"]`)!;
    const description = screen.getByText(DESCRIPTION);
    // The box and its label share one line, and the description is not on it.
    expect(label.parentElement).toBe(control.parentElement);
    expect(control.parentElement?.contains(description)).toBe(false);
    // The line and the description are both direct children of the row, so the
    // description starts at the row's edge and not under the label text.
    const row = control.closest('[data-slot="field"]');
    expect(control.parentElement?.parentElement).toBe(row);
    expect(description.parentElement).toBe(row);
    expect(description.closest('[data-slot="field-content"]')).toBeNull();
  });

  it("reads a stored value other than exactly \"true\" as false, over a declared default of true", async () => {
    for (const stored of ["TRUE", ""]) {
      const { container } = await renderForm(true, { allowNetwork: stored });
      expect(screen.getByRole("checkbox", { name: LABEL }).getAttribute("aria-checked")).toBe("false");
      expect(hiddenValues(container)).toEqual(["hidden=false"]);
      cleanup();
    }
  });

  it("ticking and unticking, by the box or by its label, flips the hidden input between exactly \"true\" and \"false\" and writes nothing", async () => {
    const fetchMock = stubFetch();
    const { container } = await renderForm(false, {}, { withSave: true });
    const control = screen.getByRole("checkbox", { name: LABEL });
    expect(hiddenValues(container)).toEqual(["hidden=false"]);

    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(hiddenValues(container)).toEqual(["hidden=true"]);

    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(hiddenValues(container)).toEqual(["hidden=false"]);

    // The label points at the box by the box's id, so a click on the label ticks it.
    const label = container.querySelector<HTMLLabelElement>(`label[for="${control.id}"]`)!;
    fireEvent.click(label);
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(hiddenValues(container)).toEqual(["hidden=true"]);
    fireEvent.click(label);
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(hiddenValues(container)).toEqual(["hidden=false"]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is written only by the form's action button, which posts the exact string", async () => {
    const fetchMock = stubFetch();
    await renderForm(true, {}, { withSave: true });
    fireEvent.click(screen.getByRole("checkbox", { name: LABEL }));
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/extensions/i4309/actions/saveConfig");
    expect(JSON.parse(String(init?.body))).toEqual({ allowNetwork: "false" });
  });

  it("respects a disabled form: inside a disabled fieldset the box is disabled and a click changes nothing", async () => {
    const fetchMock = stubFetch();
    const { container } = await renderForm(true, {}, { disabledFieldset: true });
    const control = screen.getByRole("checkbox", { name: LABEL });
    expect(control.matches(":disabled")).toBe(true);

    // HTMLElement.click() on a disabled control does nothing, as in a browser.
    await act(async () => {
      control.click();
    });
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(hiddenValues(container)).toEqual(["hidden=true"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the box's name and label when a sibling field's key is the row's key plus -toggle", async () => {
    const surface = surfaceOf({
      fields: [
        { kind: "text", key: "audit-toggle", label: "Audit destination" },
        { kind: "boolean", key: "audit", label: "Require audit logs" },
      ],
    });
    const { container } = await act(async () =>
      render(<SchemaConfigConnectorForm installId="i4309" packageName="@x/boolean" surface={surface} initialValues={{}} />),
    );
    const control = screen.getByRole("checkbox", { name: "Require audit logs" });
    const sibling = screen.getByRole("textbox", { name: "Audit destination" });
    expect(control.id).not.toBe(sibling.id);

    fireEvent.click(screen.getByText("Require audit logs"));
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector<HTMLInputElement>('[name="audit"]')?.value).toBe("true");
  });

  it("keeps each box's name and label when two mounted forms have the same boolean key", async () => {
    const form = (installId: string) => (
      <SchemaConfigConnectorForm installId={installId} packageName="@x/boolean" surface={booleanSurface(false)} initialValues={{}} />
    );
    const { container } = await act(async () =>
      render(
        <>
          {form("i4309-a")}
          {form("i4309-b")}
        </>,
      ),
    );
    const controls = screen.getAllByRole("checkbox", { name: LABEL });
    expect(controls).toHaveLength(2);
    expect(controls[0].id).not.toBe(controls[1].id);

    // A click on the second form's label ticks only the second form's box.
    fireEvent.click(container.querySelector<HTMLLabelElement>(`label[for="${controls[1].id}"]`)!);
    expect(controls.map((el) => el.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(hiddenValues(container)).toEqual(["hidden=false", "hidden=true"]);
  });
});

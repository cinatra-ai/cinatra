// @vitest-environment jsdom
/**
 * cinatra#4310 — A PER-FIELD BOOLEAN QUESTION HAS ITS OWN CONTINUE.
 *
 * The schema-driven boolean branch drew only a checkbox, and the box sent its
 * answer the moment it changed. The fallback renderer's registry entry declares
 * `drawsOwnSubmit: true`, so neither setup surface drew a Continue of its own
 * beside it: the first tick sent `true`, and `false` could never be sent.
 *
 * What is pinned here, on the renderer itself:
 *   - where the field draws its own control (no `hideSubmit`), the box only
 *     STAGES the answer: ticking and unticking send nothing;
 *   - the box opens CLEAR whatever non-boolean `value` the surface hands it
 *     (both per-field panels hand the whole values envelope), so an untouched
 *     Continue sends `false`, and a ticked one sends `true`;
 *   - one press sends once: presses repeated while the first send is in
 *     flight meet a disabled Continue, and a second press in the SAME tick,
 *     before the first press re-renders, is held by the press ref alone;
 *   - what the box opens on (only a real `true` ticks it), what a later
 *     `value` does to the staged answer, that a window fill does not reach the
 *     box, a disabled field, a refusal that is not an `Error`, and a second
 *     press after a send that landed;
 *   - where the FORM owns the one control (`hideSubmit`: a grouped setup form,
 *     a structured object's sub-field, or the outer Continue of a mid-run
 *     gate), the box is the form's field exactly as before — it writes
 *     through at once and draws no Continue.
 *
 * The two run surfaces are pinned in
 * agentic-run-panel-boolean-setup-continue-4310.test.tsx and
 * orchestrator-stepper-panel-boolean-setup-continue-4310.test.tsx.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/schema-field-renderer-boolean-continue-4310.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Stub lucide-react so jsdom does not hit React-version mismatches (the same
// pattern as setup-required-start-field-is-gated-for-every-kind.test.tsx).
vi.mock("lucide-react", async (orig) => ({
  ...(await orig<typeof import("lucide-react")>()),
  ArrowRight: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "arrow-right", className }),
  Check: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "check", className }),
  CheckIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "check", className }),
  LinkIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "link", className }),
  MailIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "mail", className }),
}));

import { SchemaFieldRenderer } from "../schema-field-renderer";

const FIELD = "sendFollowUps";
const BASE_CONTEXT = { connectedApps: [] as string[] };

type MountOpts = {
  value?: unknown;
  hideSubmit?: boolean;
  disabled?: boolean;
  aiSuggestions?: Record<string, unknown>;
  schema?: Record<string, unknown>;
  onChange?: (next: unknown) => unknown;
};

function mount(opts: MountOpts = {}) {
  const sends: unknown[] = [];
  const onChange =
    opts.onChange ??
    ((next: unknown) => {
      sends.push(next);
    });
  const element = (o: MountOpts) => (
    <SchemaFieldRenderer
      fieldName={FIELD}
      schema={o.schema ?? { type: "boolean", "x-required": true }}
      value={o.value}
      onChange={onChange}
      context={BASE_CONTEXT}
      hideSubmit={o.hideSubmit}
      disabled={o.disabled}
      aiSuggestions={o.aiSuggestions}
    />
  );
  const view = render(element(opts));
  /** Render the same field again with new props, as its surface does. */
  const update = (next: MountOpts) => view.rerender(element({ ...opts, ...next }));
  return { sends, view, update };
}

function box(): HTMLElement {
  const el = document.getElementById(`field-${FIELD}`);
  if (!el) throw new Error(`no #field-${FIELD} on screen`);
  return el;
}

function continueButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /Continue/i });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

afterEach(() => {
  cleanup();
});

describe("cinatra#4310 — the per-field boolean question stages its answer and sends it on Continue", () => {
  it("draws a Continue beneath the box", () => {
    mount();
    expect(continueButton()).not.toBeNull();
  });

  it("ticking and unticking the box sends nothing", async () => {
    const { sends } = mount();
    fireEvent.click(box());
    expect(box().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(box());
    expect(box().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(box());
    await settle();
    expect(sends).toHaveLength(0);
  });

  it("the box opens clear when the surface hands it the values envelope, and an untouched Continue sends false", async () => {
    // Both per-field panels hand a non-object field the whole values envelope
    // as `value`; an object is not a ticked box.
    const { sends } = mount({ value: { offeringCompanyWebsite: "https://example.com" } });
    expect(box().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(sends).toEqual([false]));
  });

  it("a ticked box sends true on Continue", async () => {
    const { sends } = mount();
    fireEvent.click(box());
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(sends).toEqual([true]));
  });

  it("a ticked and then unticked box sends false on Continue", async () => {
    const { sends } = mount();
    fireEvent.click(box());
    fireEvent.click(box());
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(sends).toEqual([false]));
  });

  it("presses repeated while the first send is in flight (the Continue disabled) send nothing more", async () => {
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sends: unknown[] = [];
    mount({
      onChange: async (next: unknown) => {
        sends.push(next);
        await inFlight;
      },
    });
    fireEvent.click(box());
    const press = continueButton()!;
    fireEvent.click(press);
    fireEvent.click(press);
    fireEvent.click(press);
    await settle();
    expect(sends).toEqual([true]);
    release();
    await settle();
    expect(sends).toEqual([true]);
  });

  it("a failed send keeps the answer and shows why, so the next press sends it again", async () => {
    let calls = 0;
    const sends: unknown[] = [];
    mount({
      onChange: async (next: unknown) => {
        calls += 1;
        sends.push(next);
        if (calls === 1) throw new Error("Could not reach the run.");
      },
    });
    fireEvent.click(box());
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(screen.queryByText("Could not reach the run.")).not.toBeNull());
    expect(box().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(sends).toEqual([true, true]));
  });
});

describe("cinatra#4310 — one press, one send, held by the press ref", () => {
  it("two presses in the same tick, before the first press re-renders, send once", async () => {
    // fireEvent wraps each press in its own act, so the first press has
    // re-rendered (and disabled the Continue) before the next one lands; that
    // case is above. Here both presses land inside ONE act: React has not
    // re-rendered between them, the Continue is still enabled, and only the
    // press ref can stop the second send.
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sends: unknown[] = [];
    mount({
      onChange: async (next: unknown) => {
        sends.push(next);
        await inFlight;
      },
    });
    const press = continueButton() as HTMLButtonElement;
    act(() => {
      press.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(press.disabled).toBe(false);
      press.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(sends).toEqual([false]);
    release();
    await settle();
    expect(sends).toEqual([false]);
  });

  it("after a send that landed, the next press sends the answer the box shows now", async () => {
    const { sends } = mount();
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(sends).toEqual([false]));
    await waitFor(() => expect((continueButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(box());
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(sends).toEqual([false, true]));
  });

  it("a send refused with something that is not an Error shows the general message, and the next press sends again", async () => {
    let calls = 0;
    const sends: unknown[] = [];
    mount({
      onChange: async (next: unknown) => {
        calls += 1;
        sends.push(next);
        if (calls === 1) throw "refused";
      },
    });
    fireEvent.click(continueButton()!);
    await waitFor(() =>
      expect(screen.queryByText("Could not submit. Please try again.")).not.toBeNull(),
    );
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(sends).toEqual([false, false]));
  });

  it("a disabled field disables the box and its Continue, and pressing them sends nothing", async () => {
    const { sends } = mount({ disabled: true });
    expect((box() as HTMLButtonElement).disabled).toBe(true);
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box());
    fireEvent.click(continueButton()!);
    await settle();
    expect(box().getAttribute("aria-checked")).toBe("false");
    expect(sends).toHaveLength(0);
  });
});

describe("cinatra#4310 — what the box opens on, and what changes the staged answer", () => {
  it("an initial true opens the box ticked, and an untouched Continue sends true", async () => {
    const { sends } = mount({ value: true });
    expect(box().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(sends).toEqual([true]));
  });

  const NOT_TRUE: Array<[string, unknown]> = [
    ["false", false],
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["an array", [true]],
    ["null", null],
  ];
  for (const [label, initial] of NOT_TRUE) {
    it(`an initial ${label} opens the box clear, and an untouched Continue sends false`, async () => {
      const { sends } = mount({ value: initial });
      expect(box().getAttribute("aria-checked")).toBe("false");
      fireEvent.click(continueButton()!);
      await waitFor(() => expect(sends).toEqual([false]));
    });
  }

  it("a new boolean value from the surface replaces the staged answer", async () => {
    const { sends, update } = mount({ value: false });
    expect(box().getAttribute("aria-checked")).toBe("false");
    update({ value: true });
    await waitFor(() => expect(box().getAttribute("aria-checked")).toBe("true"));
    update({ value: false });
    await waitFor(() => expect(box().getAttribute("aria-checked")).toBe("false"));
    await settle();
    expect(sends).toHaveLength(0);
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(sends).toEqual([false]));
  });

  it("a new value that is not a boolean (a new values envelope, a string, nothing) keeps the answer the person staged", async () => {
    const { sends, update } = mount({ value: { offeringCompanyWebsite: "https://example.com" } });
    fireEvent.click(box());
    expect(box().getAttribute("aria-checked")).toBe("true");
    update({ value: { offeringCompanyWebsite: "https://example.org" } });
    update({ value: "text" });
    update({ value: undefined });
    await settle();
    expect(box().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(sends).toEqual([true]));
  });

  it("a window fill does not reach the box: a placed boolean for this field neither ticks it nor sends", async () => {
    const { sends, update } = mount();
    update({ aiSuggestions: { [FIELD]: true } });
    await settle();
    expect(box().getAttribute("aria-checked")).toBe("false");
    update({ aiSuggestions: { someOtherField: true } });
    await settle();
    expect(box().getAttribute("aria-checked")).toBe("false");
    expect(sends).toHaveLength(0);
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(sends).toEqual([false]));
  });
});

describe("cinatra#4310 — where the form owns the one control, the box is unchanged", () => {
  it("with hideSubmit the box writes through at once and draws no Continue", async () => {
    const { sends } = mount({ hideSubmit: true, value: false });
    expect(continueButton()).toBeNull();
    fireEvent.click(box());
    await settle();
    expect(sends).toEqual([true]);
  });

  it("with hideSubmit the box shows the form's own value", () => {
    mount({ hideSubmit: true, value: true });
    expect(box().getAttribute("aria-checked")).toBe("true");
  });

  it("with hideSubmit unticking a ticked box writes false through at once", async () => {
    const { sends } = mount({ hideSubmit: true, value: true });
    fireEvent.click(box());
    await settle();
    expect(sends).toEqual([false]);
  });

  it("a boolean sub-field of a structured object draws no Continue of its own, and the object's one Continue sends it", async () => {
    const { sends } = mount({
      schema: { type: "object", properties: { [FIELD]: { type: "boolean" } } },
    });
    expect(screen.queryAllByRole("button", { name: /Continue/i })).toHaveLength(1);
    fireEvent.click(box());
    await settle();
    expect(sends).toHaveLength(0);
    fireEvent.click(continueButton()!);
    await waitFor(() => expect(sends).toEqual([{ [FIELD]: true }]));
  });
});

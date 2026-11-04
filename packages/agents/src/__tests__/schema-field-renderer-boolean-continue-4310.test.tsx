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
 *   - one press sends once, even when the press is repeated while the first
 *     send is still in flight;
 *   - where the FORM owns the one control (`hideSubmit`: a grouped setup form,
 *     a structured object's sub-field), the box is the form's field exactly as
 *     before — it writes through at once and draws no Continue.
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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

function mount(opts: {
  value?: unknown;
  hideSubmit?: boolean;
  onChange?: (next: unknown) => unknown;
} = {}) {
  const sends: unknown[] = [];
  const onChange =
    opts.onChange ??
    ((next: unknown) => {
      sends.push(next);
    });
  const view = render(
    <SchemaFieldRenderer
      fieldName={FIELD}
      schema={{ type: "boolean", "x-required": true }}
      value={opts.value}
      onChange={onChange}
      context={BASE_CONTEXT}
      hideSubmit={opts.hideSubmit}
    />,
  );
  return { sends, view };
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

  it("a repeated press while the first send is in flight sends once", async () => {
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
});

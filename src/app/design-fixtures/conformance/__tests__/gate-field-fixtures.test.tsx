// @vitest-environment jsdom
//
// The conformance sample page's EMAIL GATE FIELDS (cinatra#4319): the sender
// field, the drafts review and the recipients review, each under the conformance
// id and the data-state / data-field the approved design spec's drawing
// (specs/app-artifact-review.html, "The email gate fields") gives it.
//
// The renderers are the REAL ones the email extension ships, loaded through the
// build's field-renderer map; so this needs the extension synced into the
// workspace, as the typecheck and the build do. A renderer that did not load
// draws `data-load-state="unavailable"`, which fails every assertion below.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

import { EmailGateConformanceFixtures, bindingForKind } from "../gate-field-fixtures";

afterEach(() => cleanup());

async function mount(id: string, firstText: RegExp | string): Promise<HTMLElement> {
  const { container } = render(<EmailGateConformanceFixtures />);
  const root = container.querySelector<HTMLElement>(`[data-conformance-id="${id}"]`);
  expect(root, `${id}: the page draws the surface`).not.toBeNull();
  await within(root!).findAllByText(firstText, {}, { timeout: 5000 });
  return root!;
}

function reading(root: HTMLElement, variant: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-variant="${variant}"]`);
  expect(el, `reading ${variant}`).not.toBeNull();
  return el!;
}

describe("email gate fields on the conformance sample page", () => {
  it("draws the sender field under its id, state and field", async () => {
    const root = await mount("email-gate-sender-field", "Select a sender address");
    expect(root.getAttribute("data-state")).toBe("empty error kind:artifact");
    expect(root.getAttribute("data-field")).toBe("sender=context.gmailAliases");
    // The label is the field's own, marked * because the field is required.
    expect(within(reading(root, "empty")).getByText("Sender email *")).toBeTruthy();
    expect(within(reading(root, "empty")).getByRole("combobox").textContent).toContain(
      "Select a sender address",
    );
    const error = reading(root, "error");
    expect(within(error).getByText("The address the campaign's emails go out from.")).toBeTruthy();
    expect(within(error).getByText("This field is required.")).toBeTruthy();
    const disabled = within(reading(root, "disabled")).getByRole("combobox");
    expect(disabled.hasAttribute("disabled") || disabled.getAttribute("data-disabled") !== null).toBe(true);
    expect(root.querySelector('[data-load-state="unavailable"]')).toBeNull();
  });

  it("draws the drafts review under its id, state and field", async () => {
    const root = await mount(
      "email-gate-drafts-review-field",
      "Waiting for the agent to generate email drafts…",
    );
    expect(root.getAttribute("data-state")).toBe("empty kind:artifact");
    expect(root.getAttribute("data-field")).toBe("drafts=gate.draftBundle.draftedEmails");
    const initial = reading(root, "initial");
    expect(await within(initial).findByText("Review drafts (2)")).toBeTruthy();
    expect(within(initial).getByText("anna.keller@acme.example")).toBeTruthy();
    expect(within(initial).getAllByText("Subject")).toHaveLength(2);
    expect(within(initial).getAllByText("Body")).toHaveLength(2);
    expect(within(initial).queryByText("Reset")).toBeNull();
    const followUp = reading(root, "follow-up");
    expect(await within(followUp).findByText("Day 4")).toBeTruthy();
    expect(within(followUp).getByText("Day 11")).toBeTruthy();
    expect(await within(reading(root, "no-recipient")).findByText("Unknown recipient")).toBeTruthy();
    expect(root.querySelector('[data-load-state="unavailable"]')).toBeNull();
  });

  it("draws the recipients review under its id, state and field", async () => {
    const root = await mount(
      "email-gate-recipients-review-field",
      "Waiting for the agent to generate the recipient list…",
    );
    expect(root.getAttribute("data-state")).toBe("empty kind:artifact");
    expect(root.getAttribute("data-field")).toBe("recipients=gate.confirmedRecipients");
    const editable = reading(root, "editable");
    expect(await within(editable).findByText("3 recipients")).toBeTruthy();
    expect(within(editable).getByText("Q3 pilot accounts")).toBeTruthy();
    expect(within(editable).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(editable).getByRole("button", { name: "Redo" })).toBeTruthy();
    for (const head of ["Contact", "Title", "Email", "Company"]) {
      expect(within(editable).getByText(head)).toBeTruthy();
    }
    expect(within(editable).getAllByRole("button", { name: "Remove recipient" })).toHaveLength(3);
    // The same table read only: no Undo, no Redo, no remove column.
    const readOnly = reading(root, "read-only");
    expect(await within(readOnly).findByText("3 recipients")).toBeTruthy();
    expect(within(readOnly).queryByRole("button")).toBeNull();
    expect(root.querySelector('[data-load-state="unavailable"]')).toBeNull();
  });
});

// The page names a host renderer kind; bindingForKind picks the build's binding
// for it. Synthetic maps only: no extension is named here either.
describe("bindingForKind", () => {
  const comp = (packageName: string) => ({ packageName });

  it("returns the first binding of the kind that ships a component", () => {
    const bindings = [
      { id: "a:no-component", kind: "k" },
      { id: "b:first", kind: "k" },
      { id: "c:second", kind: "k" },
      { id: "d:other", kind: "other" },
    ];
    const components = { "b:first": comp("p"), "c:second": comp("p"), "d:other": comp("q") };
    expect(bindingForKind("k", bindings, components)).toBe("b:first");
  });

  it("refuses a kind no binding declares, or whose bindings ship no component", () => {
    const bindings = [{ id: "a:x", kind: "k" }];
    expect(bindingForKind("absent", bindings, { "a:x": comp("p") })).toBeNull();
    expect(bindingForKind("k", bindings, {})).toBeNull();
    expect(bindingForKind("", bindings, { "a:x": comp("p") })).toBeNull();
  });

  it("matches the kind exactly, not by case or prefix", () => {
    const bindings = [{ id: "a:x", kind: "k-review" }];
    const components = { "a:x": comp("p") };
    expect(bindingForKind("K-REVIEW", bindings, components)).toBeNull();
    expect(bindingForKind("k", bindings, components)).toBeNull();
  });

  it("refuses a kind whose bindings take components from two packages", () => {
    const bindings = [
      { id: "a:x", kind: "k" },
      { id: "b:y", kind: "k" },
    ];
    expect(bindingForKind("k", bindings, { "a:x": comp("p"), "b:y": comp("q") })).toBeNull();
  });

  it("does not read an inherited member as a component", () => {
    const bindings = [{ id: "toString", kind: "k" }];
    expect(bindingForKind("k", bindings, {})).toBeNull();
  });

  it("finds a binding for each of the page's three kinds in the build", () => {
    for (const kind of ["gmail-sender", "email-drafts-review", "campaign-recipients-review"]) {
      expect(bindingForKind(kind), kind).not.toBeNull();
    }
  });
});

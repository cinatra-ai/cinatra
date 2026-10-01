// @vitest-environment jsdom
//
// cinatra#3340 — the name step disabled Continue at once while the reason for
// the refusal stayed hidden until the namespace field lost focus. The rule is
// unchanged; only WHEN its reason is drawn changes: an untouched field stays
// quiet, and once the field has been edited every validator refusal
// (required, format, reserved) is drawn next to the field while the field is
// still focused, in the form's existing inline-error styling, with Continue
// still disabled.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  InstanceNamespaceInput,
  NamespaceValidationProvider,
  SubmitContinueButton,
} from "../instance-namespace-input";

afterEach(() => cleanup());

function renderNameStep(initialValue = "") {
  return render(
    <NamespaceValidationProvider initialValue={initialValue} initiallyDetached={false}>
      <form>
        <InstanceNamespaceInput defaultValue={initialValue} />
        <SubmitContinueButton />
      </form>
    </NamespaceValidationProvider>,
  );
}

function namespaceInput(): HTMLInputElement {
  return screen.getByPlaceholderText("e.g. acme-group") as HTMLInputElement;
}

function continueButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
}

// Edit the field while it is focused and never blur it.
function editWhileFocused(next: string) {
  const input = namespaceInput();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: next } });
}

describe("name step — validator reason is drawn while the field is being edited", () => {
  it("an untouched empty field stays quiet; an edit draws the refusal pre-blur while Continue stays disabled", () => {
    renderNameStep("");

    // Untouched: quiet.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(continueButton().disabled).toBe(true);
    expect(namespaceInput().getAttribute("aria-invalid")).toBe("false");

    editWhileFocused("proof-lane-cinatra");

    const alert = screen.getByRole("alert");
    // The form's existing inline-error styling.
    expect(alert.className).toContain("text-destructive");
    expect(namespaceInput().getAttribute("aria-invalid")).toBe("true");
    expect(continueButton().disabled).toBe(true);
  });

  it("the reserved-word message names the reserved word and how to fix it, pre-blur", () => {
    renderNameStep("");

    editWhileFocused("proof-lane-cinatra");

    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toContain("cinatra");
    expect(text).toContain("reserved substring");
    expect(text).toContain("pre-registration");
    expect(text).toContain("To request approval");
    expect(screen.getByRole("link", { name: /open a GitHub issue/i })).toBeTruthy();
  });

  describe("every reason is drawn after an edit and before blur", () => {
    it("required", () => {
      renderNameStep("");
      editWhileFocused("   ");
      expect(screen.getByRole("alert").textContent).toContain(
        "Instance namespace is required.",
      );
    });

    it("format", () => {
      renderNameStep("");
      editWhileFocused("A");
      expect(screen.getByRole("alert").textContent).toContain(
        "Use only lowercase letters",
      );
    });

    it("reserved", () => {
      renderNameStep("");
      editWhileFocused("cinatra-group");
      expect(screen.getByRole("alert").textContent).toContain(
        "contains the reserved substring",
      );
    });
  });
});

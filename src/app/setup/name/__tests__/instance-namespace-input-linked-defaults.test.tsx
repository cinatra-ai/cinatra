// @vitest-environment jsdom
//
// Regression test for the `initiallyDetached` prop: a non-empty
// `initialValue` used to unconditionally start the namespace field
// "detached" from the display-name field, which conflated two very different
// cases —
//
//   1. A REAL decision (a saved identity's persisted namespace) that must
//      never be silently overwritten by a display-name edit.
//   2. A machine-generated dev-mode SUGGESTION (getSetupNameDefaults) that
//      nobody has actually chosen yet, which should keep following the
//      display-name field exactly like a genuinely empty starting namespace
//      would.
//
// /setup/name/page.tsx now passes `initiallyDetached={Boolean(identity?.instanceNamespace)}`
// so only case (1) starts detached. This test renders the REAL provider +
// islands under jsdom and drives a real display-name edit to prove both
// starting states behave correctly.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  InstanceDisplayNameInput,
  InstanceNamespaceInput,
  NamespaceValidationProvider,
} from "../instance-namespace-input";

afterEach(() => cleanup());

function renderIslands(props: {
  initialValue: string;
  initialDisplayName: string;
  initiallyDetached?: boolean;
}) {
  return render(
    <NamespaceValidationProvider
      initialValue={props.initialValue}
      initialDisplayName={props.initialDisplayName}
      initiallyDetached={props.initiallyDetached}
    >
      <InstanceDisplayNameInput defaultValue={props.initialDisplayName} />
      <InstanceNamespaceInput defaultValue={props.initialValue} />
    </NamespaceValidationProvider>,
  );
}

function namespaceInput(): HTMLInputElement {
  return screen.getByPlaceholderText("e.g. acme-group") as HTMLInputElement;
}

function displayNameInput(): HTMLInputElement {
  return screen.getByPlaceholderText("e.g. ACME Group") as HTMLInputElement;
}

describe("NamespaceValidationProvider — initiallyDetached", () => {
  it("a dev-mode default (initiallyDetached=false) keeps deriving the namespace from display-name edits", () => {
    renderIslands({
      initialValue: "old-mac-main-260804-120000",
      initialDisplayName: "Old Mac · main · 2026-08-04 12:00:00",
      initiallyDetached: false,
    });

    fireEvent.change(displayNameInput(), { target: { value: "ACME Group" } });

    expect(namespaceInput().value).toBe("acme-group");
  });

  it("a saved identity (initiallyDetached=true) never has its namespace overwritten by a display-name edit", () => {
    renderIslands({
      initialValue: "acme-group",
      initialDisplayName: "ACME Group",
      initiallyDetached: true,
    });

    fireEvent.change(displayNameInput(), { target: { value: "ACME Group Renamed" } });

    // The namespace is the operator's real, saved decision — it must stay
    // exactly as it was, not silently re-derive from the display-name edit.
    expect(namespaceInput().value).toBe("acme-group");
  });

  it("default (omitted initiallyDetached) preserves the old any-non-empty-value-detaches heuristic for other callers", () => {
    renderIslands({
      initialValue: "acme-group",
      initialDisplayName: "ACME Group",
      // initiallyDetached omitted — administration callers rely on this default.
    });

    fireEvent.change(displayNameInput(), { target: { value: "ACME Group Renamed" } });

    expect(namespaceInput().value).toBe("acme-group");
  });

  it("a manual namespace edit always detaches, regardless of the starting state", () => {
    renderIslands({
      initialValue: "old-mac-main-260804-120000",
      initialDisplayName: "Old Mac · main · 2026-08-04 12:00:00",
      initiallyDetached: false,
    });

    fireEvent.change(namespaceInput(), { target: { value: "hand-picked" } });
    fireEvent.change(displayNameInput(), { target: { value: "ACME Group" } });

    expect(namespaceInput().value).toBe("hand-picked");
  });
});

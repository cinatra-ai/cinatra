// @vitest-environment jsdom
/**
 * The Upload screen mounts the STORE's install-scope picker (cinatra#3204,
 * acceptance criteria 11 and 17).
 *
 * Criterion 11 asks for the store's own primitives to be "the ones mounted, not
 * a second implementation of the same rules". Behavioural equivalence is not
 * enough to prove that — two implementations agree right up until one of them
 * changes. So this suite asserts MOUNT IDENTITY: the module the marketplace
 * install panel renders its picker from is the module this form renders, and it
 * receives the server-computed rows, the availability verdict and the server's
 * own default selection unaltered.
 *
 * Criterion 17 asks that the install scope and the pre-existing run-visibility
 * picker are visibly distinct or folded together. The decision recorded for this
 * issue is to keep both and label each with the question it asks, and that is
 * asserted here too.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/upload-screen-install-scope-mount.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const routerState = vi.hoisted(() => ({ push: vi.fn() }));
const mountState = vi.hoisted(() => ({
  props: [] as Record<string, unknown>[],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerState.push }) }));
vi.mock("../import-export-actions", () => ({
  importAgentTemplate: vi.fn(async () => ({ templateId: "t-1", upserted: false, warnings: [] })),
}));
vi.mock("@cinatra-ai/extensions/components/license-warning-dialog", () => ({
  LicenseWarningDialog: () => null,
}));
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
// The RUN-VISIBILITY picker (the pre-existing multi-select). Rendered as an
// identifiable marker so the two questions can be told apart on screen.
vi.mock("@/components/access-combobox", () => ({
  AccessCombobox: () => <div data-testid="run-visibility-combobox" />,
  resolveFlatAccessOption: () => ({ committable: true }),
}));
// THE ASSERTION SEAM: the store's shared install-scope field. If the form ever
// stopped mounting this module — by inlining the rules, or by growing its own
// picker — this spy would record nothing and the suite would fail.
vi.mock("@cinatra-ai/extensions/screens/install-scope-field", () => ({
  InstallScopePickerBody: (props: Record<string, unknown>) => {
    mountState.props.push(props);
    return <div data-testid="mounted-store-install-scope-picker" />;
  },
  resolveInstallScopeSelection: () => ({ target: { level: "workspace", id: "org_1" }, committable: true }),
}));

import { ImportAgentForm } from "../import-form";

const CONTEXT = {
  installTargets: [
    { value: "workspace", label: "Workspace: All", level: "workspace", id: "org_1" },
    { value: "org:org_1", label: "Acme", level: "organization", id: "org_1" },
  ],
  ownerEntityNames: { "org:org_1": "Acme" },
  activeOrgId: "org_1",
  availability: { state: "ready", defaultValue: "workspace" },
} as never;

afterEach(() => {
  mountState.props.length = 0;
  cleanup();
});

describe("the Upload screen's install-scope field", () => {
  it("mounts the STORE's picker module, not a local re-implementation", () => {
    render(<ImportAgentForm installScopeContext={CONTEXT} />);
    expect(screen.getByTestId("mounted-store-install-scope-picker")).toBeTruthy();
    expect(mountState.props).toHaveLength(1);
  });

  it("hands it the server-computed rows and the availability verdict unaltered", () => {
    render(<ImportAgentForm installScopeContext={CONTEXT} />);
    expect(mountState.props[0].context).toBe(CONTEXT);
  });

  it("preselects the server's own default — Workspace: All where it is offered enabled", () => {
    render(<ImportAgentForm installScopeContext={CONTEXT} />);
    expect(mountState.props[0].value).toBe("workspace");
  });

  it("selects nothing when the screen has no installable scope", () => {
    render(
      <ImportAgentForm
        installScopeContext={
          { ...(CONTEXT as Record<string, unknown>), availability: { state: "no-installable-scope" } } as never
        }
      />,
    );
    expect(mountState.props[0].value).toBe("");
  });

  it("asks the two access questions under DIFFERENT labels", () => {
    render(<ImportAgentForm installScopeContext={CONTEXT} availableScopes={{ orgs: [], projects: [], canGrantWorkspace: true } as never} />);
    expect(screen.getByText("Install for")).toBeTruthy();
    expect(screen.getByText("Run visibility")).toBeTruthy();
    // The heading that used to cover BOTH meanings is gone.
    expect(screen.queryByText("Access")).toBeNull();
  });

  it("renders no install-scope picker at all when the screen was given no context", () => {
    render(<ImportAgentForm />);
    expect(screen.queryByTestId("mounted-store-install-scope-picker")).toBeNull();
    expect(mountState.props).toHaveLength(0);
  });
});

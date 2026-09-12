// @vitest-environment jsdom
/**
 * The Upload Extension screen's GITHUB tab (cinatra#3204 leg 3 — criteria 6, 7,
 * 9, 10, 11, 17, and the screen half of CELL2 / CELL3).
 *
 * The claims: the two preconditions are STATED and disable Submit; a resolved
 * repository displays the kind read from the manifest and the immutable commit
 * the ref was pinned to; the scope question is the store's own panel; and the
 * old public-only visibility claim and the second ownership editor are gone.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const routerState = vi.hoisted(() => ({ push: vi.fn() as ReturnType<typeof vi.fn> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerState.push }) }));
// next/link -> a plain anchor built without JSX, the same way the sibling
// suites mock it (src/components/extensions/agent-all-card.test.tsx), so the
// rendered href stays assertable without a raw JSX anchor.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    React.createElement("a", { href, ...rest }, children),
}));

const actions = vi.hoisted(() => ({
  previewSuppliedRepositoryAction: vi.fn(),
  installSuppliedRepositoryAction: vi.fn(),
  readGitHubUploadPreconditionAction: vi.fn(async () => ({ state: "ready" as const })),
}));
vi.mock("../supplied-install-actions", () => actions);

const toastState = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock("@/lib/cinatra-toast", () => ({ toast: toastState }));

import { ImportPackageFromGitHubForm } from "../import-skill-from-github-form";

const INSTALL_SCOPE = {
  installTargets: [
    { value: "workspace", label: "Workspace: All", level: "workspace" as const, id: "org-1", disabled: false },
    { value: "org:org-1", label: "Acme", level: "organization" as const, id: "org-1", disabled: false },
  ],
  ownerEntityNames: { "org:org-1": "Acme" },
  activeOrgId: "org-1",
  availability: { state: "ready" as const, defaultValue: "workspace" },
};

const SHA = "b".repeat(40);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  actions.readGitHubUploadPreconditionAction.mockResolvedValue({ state: "ready" as const });
});

describe("the GitHub tab states its precondition (criterion 9)", () => {
  it("names the missing OWNING CONNECTOR and disables Submit", async () => {
    actions.readGitHubUploadPreconditionAction.mockResolvedValue({
      state: "no-connector",
      message: "The GitHub connector is not installed or not active on this instance.",
      fixHref: "/configuration/marketplace",
      fixLabel: "Open the marketplace",
    } as never);
    render(
      <ImportPackageFromGitHubForm
        installScope={INSTALL_SCOPE}
        precondition={{ state: "ready" }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("github-upload-precondition")).toBeTruthy();
    });
    expect(screen.getByText(/not installed or not active/)).toBeTruthy();
    expect(
      (screen.getByTestId("github-upload-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("names the missing USABLE CONNECTION separately and disables Submit", async () => {
    actions.readGitHubUploadPreconditionAction.mockResolvedValue({
      state: "no-connection",
      message: "The GitHub connector is installed, but this instance has no usable GitHub connection yet.",
      fixHref: "/configuration/connectors",
      fixLabel: "Open connector settings",
    } as never);
    render(
      <ImportPackageFromGitHubForm
        installScope={INSTALL_SCOPE}
        precondition={{ state: "ready" }}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("github-upload-precondition").textContent,
      ).toMatch(/no usable GitHub connection/);
    });
    expect(
      (screen.getByTestId("github-upload-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("the GitHub tab resolves any kind and pins the commit (criteria 6, 7, 10, 11)", () => {
  it("shows the resolved kind, the pinned sha and the store's own scope panel", async () => {
    actions.previewSuppliedRepositoryAction.mockResolvedValue({
      ok: true,
      preview: {
        kind: "connector",
        packageName: "@acme/thing-connector",
        version: "2.1.0",
        contentDigest: "a".repeat(64),
        resolvedSha: SHA,
        repo: "acme/thing",
        ref: "main",
      },
    });
    render(
      <ImportPackageFromGitHubForm
        installScope={INSTALL_SCOPE}
        precondition={{ state: "ready" }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/acme/thing" },
    });
    fireEvent.click(screen.getByTestId("github-upload-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("upload-resolved-kind").textContent).toBe("Connector");
    });
    expect(screen.getByTestId("upload-pinned-sha").textContent).toContain(SHA);
    expect(screen.getByTestId("extension-install-panel-body")).toBeTruthy();
    expect(screen.getByTestId("extension-install-panel-submit")).toBeTruthy();
  });

  it("no longer promises public-only repositories, and asks for ownership only once", () => {
    render(
      <ImportPackageFromGitHubForm
        installScope={INSTALL_SCOPE}
        precondition={{ state: "ready" }}
      />,
    );
    expect(screen.queryByText(/Public github\.com repositories only/)).toBeNull();
    expect(screen.queryByText(/Configure access & ownership/)).toBeNull();
  });
});

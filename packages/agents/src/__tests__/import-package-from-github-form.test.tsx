// @vitest-environment jsdom
/**
 * The Upload Extension screen's GITHUB tab (cinatra#3204 leg 3 — criteria 6, 7,
 * 10, 11, 17 — and the fix leg that removed the connection precondition).
 *
 * THE MAINTAINER'S RULING, in their words: "Anyone can download a ZIP of
 * origin/main of a repo or a ZIP of a release — no need to be logged in at
 * GitHub. The user provides that link and Cinatra gets the ZIP."
 *
 * The claims: a public repository link resolves and offers the import with NO
 * GitHub connection anywhere in sight; the resolved repository names the ref and
 * the archive that will be fetched; a link the anonymous download cannot serve
 * is refused on the toast with the road's own reason; the scope question is the
 * store's own panel; and the old public-only visibility claim and the second
 * ownership editor are gone.
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
});

describe("the GitHub tab asks for a LINK, never for a connection", () => {
  it("offers the import for a public repository link with no GitHub connection", async () => {
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
        archiveUrl: "https://codeload.github.com/acme/thing/zip/main",
      },
    });
    render(<ImportPackageFromGitHubForm installScope={INSTALL_SCOPE} />);

    // Nothing gates the form: no precondition alert, and Submit is live as soon
    // as a link is typed.
    expect(screen.queryByTestId("github-upload-precondition")).toBeNull();
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/acme/thing" },
    });
    expect((screen.getByTestId("github-upload-submit") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("github-upload-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("upload-resolved-kind").textContent).toBe("Connector");
    });
    expect(screen.getByTestId("extension-install-panel-body")).toBeTruthy();
    expect(screen.getByTestId("extension-install-panel-submit")).toBeTruthy();
  });

  it("shows the repository, the ref and the archive it will fetch", async () => {
    actions.previewSuppliedRepositoryAction.mockResolvedValue({
      ok: true,
      preview: {
        kind: "skill",
        packageName: "@acme/thing-skill",
        version: "1.0.0",
        contentDigest: "a".repeat(64),
        resolvedSha: SHA,
        repo: "acme/thing",
        ref: "v1.2.3",
        archiveUrl: "https://codeload.github.com/acme/thing/zip/refs/tags/v1.2.3",
      },
    });
    render(<ImportPackageFromGitHubForm installScope={INSTALL_SCOPE} />);
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/acme/thing/releases/tag/v1.2.3" },
    });
    fireEvent.click(screen.getByTestId("github-upload-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("upload-resolved-source")).toBeTruthy();
    });
    const source = screen.getByTestId("upload-resolved-source").textContent ?? "";
    expect(source).toContain("acme/thing");
    expect(source).toContain("v1.2.3");
    expect(source).toContain("https://codeload.github.com/acme/thing/zip/refs/tags/v1.2.3");
    expect(screen.getByTestId("upload-pinned-sha").textContent).toContain(SHA);
  });

  it("refuses a link the anonymous download cannot serve, naming the reason on the toast", async () => {
    actions.previewSuppliedRepositoryAction.mockResolvedValue({
      ok: false,
      error:
        "GitHub served no archive for acme/private-thing (HTTP 404). This instance downloads the archive anonymously, so a private repository cannot be read.",
    });
    render(<ImportPackageFromGitHubForm installScope={INSTALL_SCOPE} />);
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/acme/private-thing" },
    });
    fireEvent.click(screen.getByTestId("github-upload-submit"));

    await waitFor(() => {
      expect(toastState.error).toHaveBeenCalledWith(expect.stringContaining("HTTP 404"));
    });
    expect(toastState.error).toHaveBeenCalledWith(
      expect.stringContaining("downloads the archive anonymously"),
    );
    expect(screen.queryByTestId("extension-install-panel-body")).toBeNull();
  });

  it("no longer promises public-only repositories, and asks for ownership only once", () => {
    render(<ImportPackageFromGitHubForm installScope={INSTALL_SCOPE} />);
    expect(screen.queryByText(/Public github\.com repositories only/)).toBeNull();
    expect(screen.queryByText(/Configure access & ownership/)).toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * The conformance anchors of the Upload Extension screen (cinatra#3546, design
 * spec Extensions §VIII).
 *
 * The published `app-extensions` conformance manifest declares three Upload
 * surfaces — `upload-extension-screen`, `upload-github-form` and
 * `upload-resolved-install-panel` — with three fields, five actions and two
 * `loading` states between them. The functional-acceptance drivers address each
 * of them through a stable attribute on the REAL component, and
 * scripts/design/check-conformance-testids.mjs re-proves those literals are
 * still in the source. This suite is what proves they are on the RENDERED
 * element rather than only in the file: a literal that survives the grep but
 * never reaches the DOM would pass the gate and red the browser suite.
 *
 * It also pins the harness seam the mounts depend on — a planted preview draws
 * the resolved panel, and the two bound server calls are substitutable — so the
 * conformance mount renders the shipped form rather than a second drawing of
 * it.
 *
 * NOTHING DRAWN IS ASSERTED HERE. Every anchor is an attribute added to an
 * element that already existed; the copy, the classes and the layout are the
 * §VIII suites' (import-package-from-github-form.test.tsx,
 * upload-install-scope-panel-drawn-surface.test.tsx), unchanged.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const routerState = vi.hoisted(() => ({ push: vi.fn() as ReturnType<typeof vi.fn> }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerState.push }),
  usePathname: () => "/configuration/extensions/upload",
}));
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

import { ImportPackageFromGitHubForm } from "../upload-repository-link-form";
import { UploadExtensionScreenBody } from "../upload-extension-screen-body";

const INSTALL_SCOPE = {
  installTargets: [
    {
      value: "workspace",
      label: "Workspace: All",
      level: "workspace" as const,
      id: "org-1",
      disabled: false,
    },
    {
      value: "org:org-1",
      label: "Acme",
      level: "organization" as const,
      id: "org-1",
      disabled: false,
    },
  ],
  ownerEntityNames: { "org:org-1": "Acme" },
  activeOrgId: "org-1",
  availability: { state: "ready" as const, defaultValue: "workspace" },
};

const SHA = "c".repeat(40);

const PREVIEW = {
  kind: "agent" as const,
  packageName: "@acme-labs/research-assistant",
  version: "0.4.2",
  contentDigest: "d".repeat(64),
  resolvedSha: SHA,
  repo: "acme-labs/research-assistant",
  ref: "main",
  archiveUrl: "https://codeload.github.com/acme-labs/research-assistant/zip/main",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("the screen carries the surface id and the header action's name", () => {
  it("draws upload-extension-screen on the screen body and back-to-marketplace on the outline control", () => {
    const { container } = render(<UploadExtensionScreenBody installScope={INSTALL_SCOPE} />);

    const screenRoot = container.querySelector('[data-conformance-id="upload-extension-screen"]');
    expect(screenRoot, "the screen body root carries its manifest surface id").not.toBeNull();

    // The SHIPPED road's own outer element, pinned. The route renders this body
    // with its default props, and that default is the page shell every route
    // draws: a viewport-claiming main. The bare form a mounting can ask for is
    // an opt-in that never reaches the route.
    expect(screenRoot?.tagName.toLowerCase()).toBe("main");
    expect(screenRoot?.classList.contains("min-h-screen")).toBe(true);

    // The drawing: "a single outline action reading Back to Marketplace that
    // points at the marketplace page".
    const back = container.querySelector('[data-conformance-id="back-to-marketplace"]');
    expect(back, "the header's outline control carries the action's own name").not.toBeNull();
    expect(back?.getAttribute("href")).toBe("/configuration/marketplace");
    expect(back?.textContent).toContain("Back to Marketplace");

    // The eyebrow over the title, and exactly two tabs — unchanged readings the
    // driver's `present` also asserts.
    expect(screen.getByRole("heading", { name: "Upload Extension" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["File", "GitHub"]);
  });
});

describe("the GitHub tab carries the form's surface id, its loading state and the resolve action", () => {
  it("names the form, the Continue control, and reads loading only while the lookup is in flight", async () => {
    let release: (() => void) | undefined;
    actions.previewSuppliedRepositoryAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, preview: PREVIEW });
        }),
    );
    const { container } = render(<ImportPackageFromGitHubForm installScope={INSTALL_SCOPE} />);

    const form = container.querySelector('[data-conformance-id="upload-github-form"]');
    expect(form, "the repository form carries its manifest surface id").not.toBeNull();
    // Truthful: no state variant while nothing is in flight.
    expect(form?.getAttribute("data-state")).toBeNull();

    const submit = screen.getByTestId("github-upload-submit");
    expect(
      submit.getAttribute("data-conformance-id"),
      "Continue carries the manifest action's own name beside its shipped testid",
    ).toBe("resolve-reference");

    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/acme-labs/research-assistant" },
    });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(
        container
          .querySelector('[data-conformance-id="upload-github-form"]')
          ?.getAttribute("data-state"),
      ).toBe("loading");
    });

    release?.();
    await waitFor(() => {
      expect(
        container
          .querySelector('[data-conformance-id="upload-github-form"]')
          ?.getAttribute("data-state"),
      ).toBeNull();
    });
  });
});

describe("the resolved panel carries the surface id and its two field readings", () => {
  it("names the panel root and anchors the name and the version the product draws", async () => {
    render(
      <ImportPackageFromGitHubForm
        installScope={INSTALL_SCOPE}
        harness={{ initialPreview: PREVIEW }}
      />,
    );

    const panel = await waitFor(() =>
      screen.getByTestId("upload-install-scope"),
    );
    expect(
      panel.getAttribute("data-conformance-id"),
      "the panel root carries its manifest surface id beside its shipped testid",
    ).toBe("upload-resolved-install-panel");

    // field name = the name reading the product draws for the resolved package.
    // THE MEASURED DEPARTURE (cinatra#3204): the drawing binds this reading to
    // the package's DISPLAY name; the repository road's preview carries no
    // display name yet, so the product draws the package name here. The repair
    // is owned by #3204 and is not made in this leg.
    expect(screen.getByTestId("upload-resolved-name").textContent).toBe(PREVIEW.packageName);
    // field version = manifest.version.
    expect(screen.getByTestId("upload-resolved-version").textContent).toBe(PREVIEW.version);

    // The §I.1 panel beneath the readings, on a mounting with NO card header
    // band — so no corner cross for one to sit in.
    expect(screen.getByTestId("extension-install-panel-body")).toBeTruthy();
    expect(screen.queryByTestId("extension-install-panel-close")).toBeNull();
  });

  it("lets the mount substitute the bound install call and keeps Cancel the whole of the close", async () => {
    const install = vi.fn().mockResolvedValue({
      ok: true,
      kind: PREVIEW.kind,
      packageName: PREVIEW.packageName,
      version: PREVIEW.version,
      observable: { label: "See it in the agents list", href: "" },
      warnings: [],
    });
    render(
      <ImportPackageFromGitHubForm
        installScope={INSTALL_SCOPE}
        harness={{ initialPreview: PREVIEW, installPackage: install }}
      />,
    );

    fireEvent.click(screen.getByTestId("extension-install-panel-submit"));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    // The shipped road's own action was never reached: the mount substitutes
    // only the bound call, exactly as the §I.1 install-panel mount does.
    expect(actions.installSuppliedRepositoryAction).not.toHaveBeenCalled();

    // close-panel -> card-restored: Cancel returns the screen to its
    // choose-a-package state and the panel is GONE, not hidden.
    cleanup();
    render(
      <ImportPackageFromGitHubForm
        installScope={INSTALL_SCOPE}
        harness={{ initialPreview: PREVIEW }}
      />,
    );
    fireEvent.click(screen.getByTestId("extension-install-panel-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("upload-install-scope")).toBeNull();
    });
    expect(screen.getByLabelText("Repository URL")).toBeTruthy();
  });
});

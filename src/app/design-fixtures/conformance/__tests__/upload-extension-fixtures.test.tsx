// @vitest-environment jsdom
//
// The conformance harness mounts for the Upload Extension screen (cinatra#3546,
// design spec Extensions §VIII).
//
// WHAT THIS PINS, and why it is not a second copy of the e2e drivers. The
// functional-acceptance drivers assert the three manifest surfaces in a browser
// against the built app; this asserts what those drivers depend on and what a
// browser run cannot tell you separately — that each mount is the SHIPPED
// component rather than a stand-in, that the screen mount and the shipped route
// render the SAME extracted body (so there is one drawing of this screen in the
// tree, not two), and that the only thing the harness supplies is the bound
// server calls and the resolved state. If a mount ever started drawing a
// reading, a control or a word itself, this is red.

import { readFileSync } from "node:fs";
import path from "node:path";

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
const toastState = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock("@/lib/cinatra-toast", () => ({ toast: toastState }));

import { UploadExtensionConformanceFixtures } from "../upload-extension-fixtures";
import { UPLOAD_CONFORMANCE_PREVIEW } from "../upload-extension-fixture-data";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const source = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function mount(surfaceId: string): HTMLElement {
  const { container } = render(<UploadExtensionConformanceFixtures />);
  const root = container.querySelector(`[data-surface-id="${surfaceId}"]`);
  expect(root, `the harness draws a mount for "${surfaceId}"`).not.toBeNull();
  return root as HTMLElement;
}

describe("the Upload Extension conformance mounts", () => {
  it("draws one mount per published surface, each carrying the product's own conformance id", async () => {
    for (const surfaceId of [
      "upload-extension-screen",
      "upload-github-form",
      "upload-resolved-install-panel",
    ]) {
      const root = mount(surfaceId);
      expect(root.getAttribute("data-variant")).toBe("populated");
      // The mount keys the suite onto the surface; the node INSIDE it that the
      // driver grades is the shipped component's own.
      await waitFor(() => {
        expect(
          root.querySelector(`[data-conformance-id="${surfaceId}"]`),
          `"${surfaceId}" mounts the shipped component, not a stand-in`,
        ).not.toBeNull();
      });
      cleanup();
    }
  });

  it("mounts the SHIPPED screen body — the same component the route renders", () => {
    // No second drawing of this screen: the route's own screen renders the
    // extracted body, and the mount renders that same component.
    expect(source("packages/agents/src/screens.tsx")).toContain("<UploadExtensionScreenBody");
    expect(source("src/app/design-fixtures/conformance/upload-extension-fixtures.tsx")).toContain(
      "<UploadExtensionScreenBody",
    );
    const root = mount("upload-extension-screen");
    expect(screen.getByRole("heading", { name: "Upload Extension" })).toBeTruthy();
    expect(
      root.querySelector('[data-conformance-id="back-to-marketplace"]')?.getAttribute("href"),
    ).toBe("/configuration/marketplace");
  });

  it("opens the repository road at rest so the resolve action is the product's own", () => {
    const root = mount("upload-github-form");
    // No panel before a lookup: the `resolve-reference` action has somewhere to
    // go, and the `loading` variant is a transition rather than a plant.
    expect(root.querySelector('[data-conformance-id="upload-resolved-install-panel"]')).toBeNull();
    expect(root.querySelector('[data-conformance-id="upload-github-form"]')).not.toBeNull();
    expect(
      root.querySelector('[data-conformance-id="upload-github-form"]')?.getAttribute("data-state"),
    ).toBeNull();
  });

  it("draws the resolved panel's readings from the planted package, never from the harness", async () => {
    const root = mount("upload-resolved-install-panel");
    await waitFor(() => {
      expect(root.querySelector('[data-testid="upload-resolved-name"]')).not.toBeNull();
    });
    expect(root.querySelector('[data-testid="upload-resolved-name"]')?.textContent).toBe(
      UPLOAD_CONFORMANCE_PREVIEW.packageName,
    );
    expect(root.querySelector('[data-testid="upload-resolved-version"]')?.textContent).toBe(
      UPLOAD_CONFORMANCE_PREVIEW.version,
    );
    // The §I.1 panel itself, on a mounting with no card header band.
    expect(root.querySelector('[data-testid="extension-install-panel-body"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="extension-install-panel-submit"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="extension-install-panel-close"]')).toBeNull();
    // The outcome is instrumentation the install has not reached yet.
    expect(root.getAttribute("data-outcome")).toBe("");
  });

  it("reaches the installed outcome only through the shipped submit, and lets the product report it", async () => {
    // The `submit-install -> installed` outcome must not be readable off the
    // harness alone: the mount's marker is reached only when the SHIPPED panel
    // forwards the pin the resolve step produced, and the product's own success
    // reading — the toast it writes in its own words — is what says the form
    // presented the result rather than dropping it.
    const root = mount("upload-resolved-install-panel");
    await waitFor(() => {
      expect(root.querySelector('[data-testid="extension-install-panel-submit"]')).not.toBeNull();
    });
    fireEvent.click(root.querySelector('[data-testid="extension-install-panel-submit"]')!);
    await waitFor(() => {
      expect(root.getAttribute("data-outcome")).toBe("installed");
    });
    expect(toastState.success).toHaveBeenCalledWith(
      expect.stringContaining(
        `Installed ${UPLOAD_CONFORMANCE_PREVIEW.packageName} ${UPLOAD_CONFORMANCE_PREVIEW.version}`,
      ),
    );
    expect(toastState.error).not.toHaveBeenCalled();
  });
});

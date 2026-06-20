// @vitest-environment jsdom
/**
 * BecomeAVendorCard vendor-scope copy contract (cinatra#348).
 *
 * The "Become a vendor" card on `/configuration/environment?tab=registries`
 * must NOT claim the vendor scope is "the namespace you set during instance
 * setup" (it is frequently auto-generated), must explain what the scope is and
 * when it matters, and must surface where to rename it:
 *
 *   - When the namespace is still editable (`firstPublishedAt === null`), the
 *     card links to the rename flow on the Instance tab
 *     (`/configuration/environment?tab=instance`).
 *   - Once the instance has published under the namespace
 *     (`firstPublishedAt` set → frozen), the card explains the scope is locked
 *     instead of offering a rename link.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next/link → a plain anchor so the rendered href is assertable in jsdom.
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

// The apply form posts a server action; it is irrelevant to the copy contract.
vi.mock("../vendor-application-actions", () => ({
  applyVendorApplicationAction: vi.fn(),
}));

import { BecomeAVendorCard } from "../become-a-vendor-card";
import type { InstanceIdentity } from "@/lib/instance-identity-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mountedRoots: Root[] = [];

function makeIdentity(overrides: Partial<InstanceIdentity> = {}): InstanceIdentity {
  return {
    instanceNamespace: "curly-african-blonde",
    instanceDisplayName: "ACME Group",
    firstPublishedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    vendorState: "none",
    ...overrides,
  } as InstanceIdentity;
}

function renderCard(identity: InstanceIdentity): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(
      <BecomeAVendorCard
        identity={identity}
        termsVersion="1.0.0"
        termsDigest="sha256:deadbeef"
        termsUrl="https://example.test/terms"
        priorRejectionReason={null}
      />,
    );
  });
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

describe("BecomeAVendorCard vendor-scope copy", () => {
  it("never claims the namespace was 'set during instance setup'", () => {
    const container = renderCard(makeIdentity());
    expect(container.textContent ?? "").not.toMatch(/you set during instance setup/i);
  });

  it("shows the scope and explains it matters when publishing to the Marketplace", () => {
    const container = renderCard(makeIdentity());
    const text = container.textContent ?? "";
    // The scope is rendered with the @-prefix.
    expect(text).toContain("@curly-african-blonde");
    // The explanation ties the scope to Marketplace publishing.
    expect(text).toMatch(/publish/i);
    expect(text).toMatch(/marketplace/i);
  });

  it("links to the Instance tab rename flow while the namespace is editable", () => {
    const container = renderCard(makeIdentity({ firstPublishedAt: null }));
    const renameLink = container.querySelector(
      'a[href="/configuration/environment?tab=instance"]',
    );
    expect(renameLink).not.toBeNull();
    // The link is the rename affordance the issue says was missing.
    expect(renameLink?.textContent ?? "").toMatch(/instance/i);
  });

  it("explains the scope is locked (no rename link) once the instance has published under it", () => {
    const container = renderCard(
      makeIdentity({ firstPublishedAt: "2026-02-01T00:00:00.000Z" }),
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/lock/i);
    // No rename link is offered for a frozen namespace.
    const renameLink = container.querySelector(
      'a[href="/configuration/environment?tab=instance"]',
    );
    expect(renameLink).toBeNull();
  });
});

// Regression test for cinatra#2753: on a host without a configured instance
// namespace, /configuration/extensions used to await
// `loadVerdaccioConfigForReads()` (inside `loadInstalledCardRows`, called from
// the real `RegistryCatalogScreen`) unguarded — throwing
// `InstanceNamespaceNotConfiguredError` and hard-500ing the page, while the
// sibling Environment → Registries tab handled the SAME condition with a
// graceful "Setup required" card.
//
// `RegistryCatalogScreen` is mocked out entirely: this test only needs to
// prove the unconfigured-host branch never reaches it (and so never reaches
// the throwing call), matching the render-tree-walk pattern already used for
// `src/app/configuration/instance/__tests__/page.test.tsx` (no
// `@testing-library/react`, which isn't a workspace root dev-dep).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
}));

// A mocked async server "component" that is JSX-rendered (`<RegistryCatalogScreen ... />`),
// not directly invoked by ExtensionsPage — matching how the real page composes
// it. React (or a real renderer) resolves it at render time, so this test
// proves the STRUCTURAL fact that the element is present with the right props,
// rather than asserting the mock function itself was called.
function registryCatalogScreenStub() {
  return null;
}
vi.mock("@cinatra-ai/extensions/screens", () => ({
  RegistryCatalogScreen: registryCatalogScreenStub,
}));

/** Recursively collect all text strings from a React element tree. */
function collectText(node: unknown): string[] {
  if (node === null || node === undefined || node === false) return [];
  if (typeof node === "string") return [node];
  if (typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (typeof node === "object") {
    const el = node as Record<string, unknown>;
    const results: string[] = [];
    if (el["props"]) {
      const props = el["props"] as Record<string, unknown>;
      if (props["children"]) results.push(...collectText(props["children"]));
    }
    return results;
  }
  return [];
}

/** Find the first element in the tree whose `type` matches, else null. */
function findElementByType(node: unknown, type: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementByType(child, type);
      if (found) return found;
    }
    return null;
  }
  const el = node as Record<string, unknown>;
  if (el["type"] === type) return el;
  const props = el["props"] as Record<string, unknown> | undefined;
  if (props && props["children"]) return findElementByType(props["children"], type);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ExtensionsPage — setup-required card on an unconfigured instance namespace (cinatra#2753)", () => {
  it("renders the setup-required card (not a 500) when no instance identity is configured", async () => {
    const { readInstanceIdentity } = await import("@/lib/instance-identity-store");
    vi.mocked(readInstanceIdentity).mockReturnValue(null);
    const { default: ExtensionsPage } = await import("@/app/configuration/extensions/page");

    const tree = await ExtensionsPage({ searchParams: Promise.resolve({}) });
    const texts = collectText(tree);

    expect(texts.some((t) => t.includes("Setup required"))).toBe(true);
    expect(texts.some((t) => t.includes("Open instance administration"))).toBe(true);
    // The unguarded call that used to throw InstanceNamespaceNotConfiguredError
    // lives inside RegistryCatalogScreen — proving it's never reached is the
    // regression guard for the hard 500.
    expect(findElementByType(tree, registryCatalogScreenStub)).toBeNull();
  });

  it("renders the setup-required card when the identity row has no instanceNamespace", async () => {
    const { readInstanceIdentity } = await import("@/lib/instance-identity-store");
    vi.mocked(readInstanceIdentity).mockReturnValue({ instanceNamespace: "" } as never);
    const { default: ExtensionsPage } = await import("@/app/configuration/extensions/page");

    const tree = await ExtensionsPage({ searchParams: Promise.resolve({}) });
    const texts = collectText(tree);

    expect(texts.some((t) => t.includes("Setup required"))).toBe(true);
    expect(findElementByType(tree, registryCatalogScreenStub)).toBeNull();
  });

  it("delegates to RegistryCatalogScreen (not the setup-required card) once the instance namespace is configured", async () => {
    const { readInstanceIdentity } = await import("@/lib/instance-identity-store");
    vi.mocked(readInstanceIdentity).mockReturnValue({ instanceNamespace: "vendora" } as never);
    const { default: ExtensionsPage } = await import("@/app/configuration/extensions/page");

    const searchParams = Promise.resolve({});
    const result = await ExtensionsPage({ searchParams });
    const texts = collectText(result);

    const screenElement = findElementByType(result, registryCatalogScreenStub);
    expect(screenElement).not.toBeNull();
    expect((screenElement?.["props"] as Record<string, unknown>)?.["searchParams"]).toBe(searchParams);
    expect(texts.some((t) => t.includes("Setup required"))).toBe(false);
  });
});

// @vitest-environment jsdom
//
// Avatar corners in the shared UI package and the owner lists (cinatra#4294).
//
//   pnpm exec vitest run src/components/ui/__tests__/avatar-corners-4294.test.tsx
//
// The drawing (specs/app-components.html, Avatar) gives avatars as "36–40px
// square" boxes, and its four examples draw 8px corners. The app avatar
// (src/components/ui/avatar.tsx) takes the corner strings `rounded-[8px]`,
// `after:rounded-[inherit]` and `rounded-[inherit]` (cinatra#4083). Before
// this change the shared UI package's avatar (packages/sdk-ui/src/ui/avatar.tsx)
// drew circles, and three owner lists added a circle class of their own:
// the shared permissions panel's member list, the app's resource ownership
// panel and the app's draft permissions form.
//
// HOW THE CORNER IS READ. jsdom generates no Tailwind utilities, so
// `getComputedStyle` cannot read a corner. This file compiles each rendered
// element's own class list with Tailwind (`compileAst`, as
// src/components/ui/__tests__/separator-drawing-conformance.test.tsx does)
// and keeps the `border-radius` declarations whose rule selector matches the
// real element (`Element.matches`; a `::after` selector is matched on its
// element). It then resolves the corner: an inline `border-radius` wins over
// a class, `inherit` takes the parent's resolved corner (the parent of a
// `::after` box is its own element), and no declaration gives the initial
// `0px`. Two limits: the condition of an at-rule (`@media`, `@supports`) is
// not checked, so a declaration inside one counts as applying; and when two
// matching declarations remain, the one compiled last wins, not the one of
// higher specificity. On the slots this file reads, no corner class carries
// an at-rule variant, and `cn` leaves at most one corner class for the box
// and one for its `::after`. It reads the utility layer only, not browser
// paint.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { compileAst } from "tailwindcss";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import {
  Avatar as AppAvatar,
  AvatarFallback as AppAvatarFallback,
  AvatarImage as AppAvatarImage,
} from "@/components/ui/avatar";
import {
  Avatar as SharedAvatar,
  AvatarFallback as SharedAvatarFallback,
  AvatarImage as SharedAvatarImage,
} from "../../../../packages/sdk-ui/src/ui/avatar";
import {
  PermissionsPanel,
  type OwnerView as PanelOwnerView,
} from "@cinatra-ai/sdk-ui/permissions-panel";
import {
  ResourceOwnershipPanel,
  type OwnerView as AppOwnerView,
} from "@/components/resource-ownership-panel";
import { PermissionsFormDraft } from "@/components/permissions-form-draft";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The panels' popovers observe their size.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

type AstNode = Parameters<typeof compileAst>[0][number];
type Corners = { own?: string; after?: string };

const PSEUDO_AFTER = /::?after$/;

/** The `border-radius` declarations of the element's own utilities, for the box and for its `::after`. */
async function cornerDeclarations(el: Element): Promise<Corners> {
  const compiler = await compileAst([
    { kind: "at-rule", name: "@tailwind", params: "utilities", nodes: [] },
  ]);
  const corners: Corners = {};
  function visit(nodes: AstNode[], parent = "") {
    for (const node of nodes) {
      if (node.kind === "rule") {
        const selector = parent ? node.selector.replaceAll("&", parent) : node.selector;
        visit(node.nodes, selector);
      } else if (node.kind === "declaration") {
        if (parent && node.property === "border-radius" && node.value !== undefined) {
          const isAfter = PSEUDO_AFTER.test(parent);
          const base = parent.replace(PSEUDO_AFTER, "");
          if (base && el.matches(base)) {
            if (isAfter) corners.after = node.value;
            else corners.own = node.value;
          }
        }
      } else if ("nodes" in node) {
        // at-rules (`@layer`, `@property`) and Tailwind's context wrappers.
        visit(node.nodes, parent);
      }
    }
  }
  visit(compiler.build([...el.classList]));
  return corners;
}

/** The element's resolved corner radius (or its `::after` box's), read as described in the header. */
async function cornerRadius(el: Element, pseudo?: "after"): Promise<string> {
  const decls = await cornerDeclarations(el);
  if (pseudo === "after") {
    const value = decls.after;
    if (value === undefined) return "0px";
    return value === "inherit" ? cornerRadius(el) : value;
  }
  const inline = (el as HTMLElement).style?.borderRadius;
  if (inline) return inline;
  const value = decls.own;
  if (value === undefined) return "0px";
  if (value === "inherit") {
    return el.parentElement ? cornerRadius(el.parentElement) : "0px";
  }
  return value;
}

/** The corner utilities of a class list, in order, with any variant prefix kept. */
function cornerClasses(el: Element): string[] {
  return [...el.classList].filter((c) => /(^|:)rounded(-|$)/.test(c));
}

// Only the browser's image readiness is supplied, so the real Radix image
// mounts (the same port as avatar-drawing-conformance.test.tsx).
function loadedImagePort() {
  const image = document.createElement("img");
  Object.defineProperties(image, {
    complete: { get: () => true },
    naturalWidth: { get: () => 36 },
  });
  return image;
}

function slots(container: HTMLElement) {
  return {
    root: container.querySelector('[data-slot="avatar"]') as HTMLElement,
    fallback: container.querySelector('[data-slot="avatar-fallback"]') as HTMLElement | null,
    image: container.querySelector('[data-slot="avatar-image"]') as HTMLElement | null,
  };
}

describe("the shared UI package's avatar draws the drawing's 8px corners (cinatra#4294)", () => {
  it("reads 8px on the box, on its border (::after) and on the fallback", async () => {
    const { container } = render(
      <SharedAvatar>
        <SharedAvatarFallback accent="plum">AL</SharedAvatarFallback>
      </SharedAvatar>,
    );
    const { root, fallback } = slots(container);
    expect(fallback).not.toBeNull();
    expect(await cornerRadius(root)).toBe("8px");
    expect(await cornerRadius(root, "after")).toBe("8px");
    expect(await cornerRadius(fallback!)).toBe("8px");
  });

  it("reads 8px on the real loaded image", async () => {
    vi.stubGlobal("Image", loadedImagePort);
    const { container } = render(
      <SharedAvatar>
        <SharedAvatarImage src="/owner.png" alt="Owner" />
        <SharedAvatarFallback>AL</SharedAvatarFallback>
      </SharedAvatar>,
    );
    const { image } = slots(container);
    expect(image).not.toBeNull();
    expect(await cornerRadius(image!)).toBe("8px");
  });

  it("uses the same corner strings as the app avatar on every slot", () => {
    vi.stubGlobal("Image", loadedImagePort);
    const shared = slots(
      render(
        <SharedAvatar>
          <SharedAvatarFallback>AL</SharedAvatarFallback>
        </SharedAvatar>,
      ).container,
    );
    const app = slots(
      render(
        <AppAvatar>
          <AppAvatarFallback>AL</AppAvatarFallback>
        </AppAvatar>,
      ).container,
    );
    expect(cornerClasses(shared.root)).toEqual(cornerClasses(app.root));
    expect(cornerClasses(shared.root)).toEqual(["rounded-[8px]", "after:rounded-[inherit]"]);
    expect(cornerClasses(shared.fallback!)).toEqual(cornerClasses(app.fallback!));
    expect(cornerClasses(shared.fallback!)).toEqual(["rounded-[inherit]"]);

    const sharedImage = slots(
      render(
        <SharedAvatar>
          <SharedAvatarImage src="/owner.png" alt="Owner" />
        </SharedAvatar>,
      ).container,
    ).image;
    const appImage = slots(
      render(
        <AppAvatar>
          <AppAvatarImage src="/owner.png" alt="Owner" />
        </AppAvatar>,
      ).container,
    ).image;
    expect(sharedImage).not.toBeNull();
    expect(appImage).not.toBeNull();
    expect(cornerClasses(sharedImage!)).toEqual(cornerClasses(appImage!));
    expect(cornerClasses(sharedImage!)).toEqual(["rounded-[inherit]"]);
  });

  it("still lets a caller's own corner class win, so a caller circle would show", async () => {
    // The pin that makes the three caller cases below meaningful: a caller's
    // `rounded-full` replaces the default corner, so a list that keeps one
    // draws a circle whatever the primitive says.
    const { container } = render(
      <SharedAvatar className="rounded-full">
        <SharedAvatarFallback>AL</SharedAvatarFallback>
      </SharedAvatar>,
    );
    const { root } = slots(container);
    expect(cornerClasses(root)).not.toContain("rounded-[8px]");
    expect(await cornerRadius(root)).not.toBe("8px");
  });
});

const ADA = { userId: "user-ada", name: "Ada Lovelace", email: "ada@example.com", image: null };
const GRACE = { userId: "user-grace", name: "Grace Hopper", email: "grace@example.com", image: null };

/** Every avatar box in the container, with its fallback: each reads 8px and keeps the size the list sets. */
async function expectEveryAvatarSquareCornered(container: HTMLElement, expectedCount: number) {
  const roots = [...container.querySelectorAll<HTMLElement>('[data-slot="avatar"]')];
  expect(roots).toHaveLength(expectedCount);
  for (const root of roots) {
    expect(root.classList.contains("rounded-full")).toBe(false);
    expect(root.classList.contains("h-8")).toBe(true);
    expect(root.classList.contains("w-8")).toBe(true);
    expect(await cornerRadius(root)).toBe("8px");
    expect(await cornerRadius(root, "after")).toBe("8px");
    const fallback = root.querySelector<HTMLElement>('[data-slot="avatar-fallback"]');
    expect(fallback).not.toBeNull();
    expect(await cornerRadius(fallback!)).toBe("8px");
  }
}

/** The shared permissions panel with ADA as the owner and GRACE as a co-owner. */
function renderSharedPanel(): HTMLElement {
  const owner: PanelOwnerView = ADA;
  const coOwner: PanelOwnerView = GRACE;
  return render(
    <PermissionsPanel
      canEdit
      initialPolicy={{
        runListVisibility: ["owner"],
        runDataVisibility: ["owner"],
        runExecuteVisibility: ["owner"],
        allowRunSharing: true,
      }}
      owner={owner}
      coOwners={[coOwner]}
      availableScopes={{ orgs: [], projects: [], canGrantWorkspace: true }}
      currentUserId={owner.userId}
      allowSharing
      selfRemoveRedirect="/connectors"
      actions={{
        savePolicy: async () => ({ ok: true as const }),
        searchCandidates: async () => ({ ok: true as const, results: [], hasMore: false }),
        addCoOwner: async () => ({ ok: true as const }),
        removeCoOwner: async () => ({ ok: true as const }),
      }}
    />,
  ).container;
}

/** The app's resource ownership panel with the same owner and co-owner. */
function renderOwnershipPanel(): HTMLElement {
  const owner: AppOwnerView = ADA;
  const coOwner: AppOwnerView = GRACE;
  return render(
    <ResourceOwnershipPanel
      resourceType="project"
      resourceId="project-1"
      allowSharing
      canEdit
      resourceOwner={owner}
      coOwners={[coOwner]}
      currentUserId={owner.userId}
      onSearch={async () => ({ ok: true as const, results: [] })}
      onAddCoOwner={async () => ({ ok: true as const })}
      onRemoveCoOwner={async () => ({ ok: true as const })}
    />,
  ).container;
}

/** The sorted class set of each Avatar root in the container, in document order. */
function avatarRootClassSets(container: HTMLElement): string[][] {
  return [...container.querySelectorAll<HTMLElement>('[data-slot="avatar"]')].map((root) =>
    [...new Set(root.classList)].sort(),
  );
}

describe("the owner lists add no circle of their own (cinatra#4294)", () => {
  it("the shared permissions panel's member list (packages/sdk-ui/src/permissions-panel.tsx)", async () => {
    await expectEveryAvatarSquareCornered(renderSharedPanel(), 2);
  });

  it("the app's resource ownership panel (src/components/resource-ownership-panel.tsx)", async () => {
    await expectEveryAvatarSquareCornered(renderOwnershipPanel(), 2);
  });

  it("the app's draft permissions form (src/components/permissions-form-draft.tsx)", async () => {
    const { container } = render(
      <PermissionsFormDraft
        value={{
          policy: {
            runListVisibility: ["owner"],
            runDataVisibility: ["owner"],
            runExecuteVisibility: ["owner"],
            allowRunSharing: true,
          },
          coOwners: [ADA, GRACE],
        }}
        onChange={() => {}}
        availableScopes={{ orgs: [], projects: [], canGrantWorkspace: true }}
        searchCandidates={async () => ({ ok: true as const, results: [], hasMore: false })}
        showAccess={false}
      />,
    );
    await expectEveryAvatarSquareCornered(container, 2);
  });
});

describe("the shared member list and the app's ownership panel draw one Avatar root (cinatra#4294)", () => {
  it("the merged class set of each Avatar root is the same in both lists", () => {
    // packages/sdk-ui/src/permissions-panel.tsx pins `size-9` on its member
    // Avatar so that this set equals the app's (the shared Avatar defaults to
    // `size-8`, the app's to `size-9`). Only the root is compared: the two
    // lists' fallbacks differ by design.
    const shared = avatarRootClassSets(renderSharedPanel());
    const app = avatarRootClassSets(renderOwnershipPanel());
    expect(shared).toHaveLength(2);
    expect(app).toHaveLength(2);
    expect(shared).toEqual(app);
    expect(shared[0]).toContain("size-9");
    expect(shared[0]).not.toContain("size-8");
  });
});

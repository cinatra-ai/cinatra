// @vitest-environment jsdom
//
// The app's two owner lists draw each person's avatar from the user avatar
// helper: initials on the categorical accent the person's id seeds, no icon
// (cinatra#4294; specs/app-components.html, Avatar).
//
//   pnpm exec vitest run src/components/__tests__/owner-lists-avatar-accent-4294.test.tsx

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PermissionsFormDraft } from "@/components/permissions-form-draft";
import { ResourceOwnershipPanel } from "@/components/resource-ownership-panel";
import { userAvatarAccent, userInitials } from "@/lib/user-avatar";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(cleanup);

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const ADA = { userId: "user-ada", name: "Ada Lovelace", email: "ada@example.com", image: null };
const GRACE = { userId: "user-grace", name: "Grace Hopper", email: "grace@example.com", image: null };
const NO_NAME = { userId: "user-noname", name: "", email: "linus@example.com", image: null };
const PEOPLE = [ADA, GRACE, NO_NAME];

function ownershipPanel(): HTMLElement {
  return render(
    <ResourceOwnershipPanel
      resourceType="project"
      resourceId="project-1"
      allowSharing
      canEdit
      resourceOwner={ADA}
      coOwners={[GRACE, NO_NAME]}
      currentUserId={ADA.userId}
      onSearch={async () => ({ ok: true as const, results: [] })}
      onAddCoOwner={async () => ({ ok: true as const })}
      onRemoveCoOwner={async () => ({ ok: true as const })}
    />,
  ).container;
}

function expectHelperAvatars(container: HTMLElement): void {
  const fallbacks = [...container.querySelectorAll<HTMLElement>('[data-slot="avatar-fallback"]')];
  expect(fallbacks).toHaveLength(PEOPLE.length);
  fallbacks.forEach((fallback, i) => {
    const person = PEOPLE[i];
    expect(fallback.getAttribute("data-accent")).toBe(userAvatarAccent({ id: person.userId }));
    expect(fallback.textContent).toBe(userInitials(person));
    expect(fallback.querySelector("svg")).toBeNull();
  });
}

describe("the app's owner lists draw avatars from the user avatar helper (cinatra#4294)", () => {
  it("the resource ownership panel: initials on the id's accent, no icon", () => {
    expectHelperAvatars(ownershipPanel());
  });

  it("the draft permissions form: initials on the id's accent, no icon", () => {
    const { container } = render(
      <PermissionsFormDraft
        value={{
          policy: {
            runListVisibility: ["owner"],
            runDataVisibility: ["owner"],
            runExecuteVisibility: ["owner"],
            allowRunSharing: true,
          },
          coOwners: PEOPLE,
        }}
        onChange={() => {}}
        availableScopes={{ orgs: [], projects: [], canGrantWorkspace: true }}
        searchCandidates={async () => ({ ok: true as const, results: [], hasMore: false })}
        showAccess={false}
      />,
    );
    expectHelperAvatars(container);
  });

  it("a person with no name draws the e-mail's initial, not a blank or an icon", () => {
    expect(userInitials(NO_NAME)).not.toBe("?");
    const fallbacks = ownershipPanel().querySelectorAll('[data-slot="avatar-fallback"]');
    expect(fallbacks[2].textContent).toBe(userInitials(NO_NAME));
  });
});

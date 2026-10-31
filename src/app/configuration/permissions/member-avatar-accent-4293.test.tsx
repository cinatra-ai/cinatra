// @vitest-environment jsdom
//
// The permissions page's member list draws each member's avatar on the
// categorical accent the member's id seeds (cinatra#4293;
// specs/app-components.html, Avatar).
//
//   pnpm exec vitest run src/app/configuration/permissions/member-avatar-accent-4293.test.tsx

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const row = (userId: string, name: string, email: string) => ({
  userId,
  name,
  email,
  image: null,
  platformRole: "user",
  relationKind: "workspace",
  relationId: "workspace",
  relationName: "Workspace",
  relationParentName: null,
  relationRole: "user",
});

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  usePathname: () => "/configuration/permissions",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: async () => ({ user: { id: "user-ada" }, session: { activeOrganizationId: null } }),
  isPlatformAdmin: () => true,
}));
vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {
    execute: async () => ({
      rows: [row("user-ada", "Ada Lovelace", "ada@example.com"), row("user-grace", "Grace Hopper", "grace@example.com")],
    }),
  },
}));
vi.mock("@/lib/mcp-server", () => ({ mcpServerMount: { ClientsPage: () => null } }));
vi.mock("@/lib/service-accounts", () => ({ listServiceAccounts: async () => [] }));
vi.mock("./user-actions", () => ({ UserActions: () => null }));
vi.mock("@/components/invite-member-dialog", () => ({ InviteMemberDialog: () => null }));

afterEach(cleanup);

describe("the permissions page's member avatars (cinatra#4293)", () => {
  it("draws each member's fallback on the accent the member's id seeds", async () => {
    const { default: PermissionsPage } = await import("./page");
    const { userAvatarAccent } = await import("@/lib/user-avatar");
    const { container } = render(await PermissionsPage({}));
    const fallbacks = [...container.querySelectorAll<HTMLElement>('[data-slot="avatar-fallback"]')];
    expect(fallbacks.map((f) => f.getAttribute("data-accent"))).toEqual([
      userAvatarAccent({ id: "user-ada" }),
      userAvatarAccent({ id: "user-grace" }),
    ]);
    expect(fallbacks.map((f) => f.textContent)).toEqual(["AL", "GH"]);
  });
});

// The profile page's title is also the trail's leaf (cinatra#4453).
//
// The components drawing, Breadcrumb section: "While a name is genuinely
// unavailable, the crumb shows the id's first eight characters plus an ellipsis".
// The page used the whole user id when the user had neither a name nor an email.
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  profileRows: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: "viewer" },
    session: { activeOrganizationId: "org-1" },
  })),
}));
vi.mock("@/lib/better-auth-db", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => mocks.profileRows,
  };
  return { betterAuthDb: { select: () => chain }, betterAuthUsers: { id: "id" } };
});
vi.mock("@/lib/assistant-thread-store", () => ({
  listAssistantThreadSummariesForOwnerInOrg: vi.fn(() => []),
}));
vi.mock("@/components/layout/main", () => ({
  Main: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/page-content", () => ({
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ title }: { title?: string }) => <header data-title={title} />,
}));

import UserProfilePage from "../page";

const USER_ID = "Zq8xK2mN4pR6tV9wB1cD3fG5hJ7lQ0sY";

function titleIn(tree: unknown): string {
  const html = renderToStaticMarkup(tree as React.ReactElement);
  const m = /data-title="([^"]*)"/.exec(html);
  if (!m) throw new Error("no page title rendered");
  return m[1]!;
}

async function profileTitle(row: Record<string, unknown>) {
  mocks.profileRows = [{ id: USER_ID, ...row }];
  return titleIn(await UserProfilePage({ params: Promise.resolve({ userId: USER_ID }) }));
}

beforeEach(() => {
  mocks.profileRows = [];
});

describe("the user profile page title", () => {
  it("is the name, else the email", async () => {
    expect(await profileTitle({ name: "Ada Lovelace", email: "ada@example.com" })).toBe(
      "Ada Lovelace",
    );
    expect(await profileTitle({ name: null, email: "ada@example.com" })).toBe("ada@example.com");
  });

  it("is the id's first eight characters plus an ellipsis when neither exists", async () => {
    const title = await profileTitle({ name: null, email: null });
    expect(title).toBe(`${USER_ID.slice(0, 8)}…`);
    expect(title).not.toContain(USER_ID);
  });

  it("treats an empty name and an empty email as missing", async () => {
    expect(await profileTitle({ name: "", email: "" })).toBe(`${USER_ID.slice(0, 8)}…`);
  });
});

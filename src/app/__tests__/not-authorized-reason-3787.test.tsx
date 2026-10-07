// @vitest-environment jsdom
//
// cinatra#3787: the refusal page names its REASON.
//
// `/not-authorized` carried one description for every refusal: "This area is
// limited to platform admins." On a team surface that sentence was false twice
// over: the reader was the platform admin, and the thing they lacked was a role
// on the team. So the page takes an optional `reason`, drawn from a closed set,
// and the team surface sends the one value it has. Every other refusal keeps
// today's sentence word for word, which is what the first case pins.
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
vi.mock("@/components/layout/main", () => ({
  Main: ({ children }: { children: ReactNode }) => createElement("main", null, children),
}));
vi.mock("@/components/page-content", () => ({
  PageContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ title, description }: { title: string; description?: string }) =>
    createElement("header", null, createElement("h1", null, title), description),
}));
vi.mock("@/components/crumb-contributions", () => ({
  CrumbContributionsClear: () => null,
}));

import NotAuthorizedPage from "@/app/not-authorized/page";
import {
  DEFAULT_NOT_AUTHORIZED_DESCRIPTION,
  SCOPE_MEMBERSHIP_DESCRIPTION,
  resolveNotAuthorizedDescription,
} from "@/lib/not-authorized-reason";

afterEach(cleanup);

async function draw(searchParams: Record<string, string | string[] | undefined>) {
  render(await NotAuthorizedPage({ searchParams: Promise.resolve(searchParams) }));
}

describe("the refusal page's description follows its reason", () => {
  it("keeps today's platform-admin sentence when no reason is given", async () => {
    await draw({});
    expect(
      screen.getByText(
        "This area is limited to platform admins. Sign in with the admin account or ask an admin to grant your user the admin role.",
      ),
    ).toBeTruthy();
  });

  it("draws the membership sentence for the scope-membership reason", async () => {
    await draw({ reason: "scope-membership" });
    expect(screen.getByText(SCOPE_MEMBERSHIP_DESCRIPTION)).toBeTruthy();
    expect(SCOPE_MEMBERSHIP_DESCRIPTION).toMatch(/not a member of this team/i);
    expect(SCOPE_MEMBERSHIP_DESCRIPTION).toMatch(/manages it/i);
    expect(SCOPE_MEMBERSHIP_DESCRIPTION).toMatch(/team admin or an organization admin/i);
  });

  it("falls back to the default sentence for a value outside the closed set", async () => {
    await draw({ reason: "whatever-a-caller-invents" });
    expect(screen.getByText(DEFAULT_NOT_AUTHORIZED_DESCRIPTION)).toBeTruthy();
  });
});

describe("the reason resolver is total", () => {
  it("answers the default for an absent, repeated or unknown parameter", () => {
    expect(resolveNotAuthorizedDescription(undefined)).toBe(
      DEFAULT_NOT_AUTHORIZED_DESCRIPTION,
    );
    expect(resolveNotAuthorizedDescription(["scope-membership"])).toBe(
      DEFAULT_NOT_AUTHORIZED_DESCRIPTION,
    );
    expect(resolveNotAuthorizedDescription("SCOPE-MEMBERSHIP")).toBe(
      DEFAULT_NOT_AUTHORIZED_DESCRIPTION,
    );
  });

  it("answers the membership sentence for the one value in the set", () => {
    expect(resolveNotAuthorizedDescription("scope-membership")).toBe(
      SCOPE_MEMBERSHIP_DESCRIPTION,
    );
  });
});

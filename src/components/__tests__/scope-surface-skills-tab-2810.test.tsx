// @vitest-environment jsdom
/**
 * THE SKILLS TAB BODY (cinatra#2810, per-scope surfaces S4).
 *
 * The acceptance sentences this file proves, verbatim:
 *
 *   "Rendering reuses the landed list components (`LibraryMode`; the skills
 *    catalog rows)."
 *
 *   "Per-scope ownership fixtures (each scope lists only its owned rows;
 *    workspace = the `WorkspaceVantage` union incl. workspace-tier rows;
 *    malformed missing-owner rows excluded everywhere)"
 *
 * What is pinned here is the BODY's own wiring: that it lists what the gate
 * handed it narrowed by the viewed scope's ownership, that it lists it through
 * the landed catalog rows, and that an empty read is reported as an empty READ
 * rather than as an unfinished tab.
 *
 * That last one is the reason this file exists. A `tabBody` is a React element
 * and therefore truthy even when it renders nothing, so the shell can never
 * fall back to its own empty state for a tab that passes a body — the body has
 * to render it. A body that returned `null` instead would draw a BLANK tab
 * under the strip, which is the one thing neither wording of the empty state is
 * allowed to become.
 */
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
  usePathname: () => "/workspace/skills",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const auth = vi.hoisted(() => ({
  getAuthSession: vi.fn(async () => ({
    user: { id: "user-1" },
    session: { activeOrganizationId: null },
  })),
  requireActorContext: vi.fn(async () => ({ principalId: "user-1" })),
  requireAuthSession: vi.fn(async () => ({ user: { id: "user-1" } })),
  getActorContext: vi.fn(async () => ({ principalId: "user-1" })),
  isPlatformAdmin: vi.fn(() => false),
  signInRedirectTarget: vi.fn(async () => "/sign-in"),
}));
vi.mock("@/lib/auth-session", () => auth);

/** The list GATE, stood in: its own authorization is proven where it lives.
 *  What this suite drives is the ownership narrowing applied to its output. */
const gate = vi.hoisted(() => ({
  listAuthorizedInstalledSkills: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@cinatra-ai/skills/pages", () => gate);

/** The vantage the workspace arm reads. */
const vantageRead = vi.hoisted(() => ({
  readWorkspaceVantage: vi.fn(async (userId: string) => ({
    userId,
    organizations: [{ orgId: "org-a", teamIds: ["team-a"], projectIds: ["project-a"] }],
  })),
}));
vi.mock("@/lib/scope-surface-workspace-vantage", () => vantageRead);

import { ScopeSurfaceSkillsTab } from "@/components/scope/scope-surface-skills-tab";

function skill(id: string, name: string, ownership: Record<string, unknown>) {
  return {
    id,
    name,
    slug: id,
    description: `${name} description`,
    packageId: "pkg-1",
    packageName: "@cinatra-ai/example-skills",
    packageSlug: "example-skills",
    content: "",
    usedBy: [],
    ...ownership,
  };
}

const PERSONAL_SKILL = skill("skill-personal", "Personal skill", {
  level: "personal",
  scope: "personal",
  ownerUserId: "user-1",
});
const TEAM_SKILL = skill("skill-team", "Team skill", { level: "team", scope: "team-a" });
const MALFORMED_SKILL = skill("skill-malformed", "Malformed skill", {
  level: "team",
  scope: null,
});

async function renderTab(scope: Parameters<typeof ScopeSurfaceSkillsTab>[0]["scope"]) {
  const tree = await ScopeSurfaceSkillsTab({ scope });
  render(tree as ReactNode);
}

function renderedSkillNames(): string[] {
  return [...document.querySelectorAll("h2")].map((h) => h.textContent?.trim() ?? "");
}

beforeEach(() => {
  gate.listAuthorizedInstalledSkills.mockResolvedValue([
    PERSONAL_SKILL,
    TEAM_SKILL,
    MALFORMED_SKILL,
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the Skills tab body lists the scope's own skills", () => {
  it("the personal tab draws the actor's own skill through the catalog rows", async () => {
    await renderTab({ kind: "personal" });
    expect(renderedSkillNames()).toEqual(["Personal skill"]);
    expect(document.querySelector('a[href="/skills/skill-personal"]')).toBeTruthy();
  });

  it("the team tab draws that team's skill and not the actor's", async () => {
    await renderTab({ kind: "team", id: "team-a" });
    expect(renderedSkillNames()).toEqual(["Team skill"]);
  });

  it("the workspace tab draws the vantage union", async () => {
    await renderTab({ kind: "workspace" });
    expect(renderedSkillNames()).toEqual(["Personal skill", "Team skill"]);
  });

  it("draws the MALFORMED skill nowhere", async () => {
    for (const scope of [
      { kind: "personal" },
      { kind: "organization", id: "org-a" },
      { kind: "team", id: "team-a" },
      { kind: "project", id: "project-a" },
      { kind: "workspace" },
    ] as Parameters<typeof renderTab>[0][]) {
      await renderTab(scope);
      expect(renderedSkillNames()).not.toContain("Malformed skill");
      cleanup();
    }
  });

  it("reads the workspace vantage without an active organization", async () => {
    await renderTab({ kind: "workspace" });
    expect(vantageRead.readWorkspaceVantage).toHaveBeenCalledWith("user-1");
    // The session in this suite carries NO active organization, and the tab
    // still listed: the workspace read never consulted one.
    expect(renderedSkillNames().length).toBeGreaterThan(0);
  });
});

describe("an empty read is reported as an empty READ, never as a blank tab", () => {
  it("draws the shared empty state when the scope owns no skill", async () => {
    await renderTab({ kind: "organization", id: "org-a" });
    const empty = screen.getByTestId("scope-skills-empty");
    expect(empty).toBeTruthy();
    const copy = empty.textContent ?? "";
    expect(copy).toMatch(/No skills here yet/i);
    // The read happened, so the tab must not call itself unfinished.
    expect(copy).not.toMatch(/not ready yet/i);
  });

  it("draws the shared empty state when the gate returns nothing at all", async () => {
    gate.listAuthorizedInstalledSkills.mockResolvedValue([]);
    await renderTab({ kind: "workspace" });
    expect(screen.getByTestId("scope-skills-empty")).toBeTruthy();
  });

  it("never renders a blank body", async () => {
    await renderTab({ kind: "project", id: "project-with-nothing" });
    expect(document.body.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });
});

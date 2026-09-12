// @vitest-environment jsdom
/**
 * THE WORKSPACE TABS READ WITHOUT AN ACTIVE ORGANIZATION (cinatra#2810,
 * per-scope surfaces S4).
 *
 * The acceptance sentence this file proves, verbatim:
 *
 *   "The workspace tab does not inherit the `/artifacts` active-org redirect
 *    (org-independent read)."
 *
 * `/artifacts` sends a reader with no active organization to sign-in:
 *
 *   const orgId = session.session?.activeOrganizationId ?? null;
 *   if (!orgId) redirect(await signInRedirectTarget());
 *
 * The workspace is the scope ABOVE every organization and its `WorkspaceVantage`
 * is defined without reference to an active one, so that redirect must not
 * follow the list onto the workspace tab. This suite renders the two workspace
 * tab routes with NO active organization in the session and pins that they
 * render their page and mount their tab body rather than redirecting. The four
 * concrete scopes are rendered on the same session for the same reason: none of
 * the ten tab routes carries that redirect.
 */
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

/** A redirect is a THROW in Next; this stand-in records it and throws too. */
const nav = vi.hoisted(() => {
  const redirect = vi.fn((target: string) => {
    throw new Error(`REDIRECTED:${target}`);
  });
  return {
    redirect,
    notFound: vi.fn(),
    usePathname: () => "/",
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
  };
});
vi.mock("next/navigation", () => nav);

/** NO ACTIVE ORGANIZATION anywhere in this suite. */
const auth = vi.hoisted(() => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: "user_1" },
    session: { activeOrganizationId: null },
  })),
  getAuthSession: vi.fn(async () => ({
    user: { id: "user_1" },
    session: { activeOrganizationId: null },
  })),
  requireActorContext: vi.fn(async () => ({ principalId: "user_1" })),
  getActorContext: vi.fn(async () => ({ principalId: "user_1" })),
  isPlatformAdmin: vi.fn(() => false),
  signInRedirectTarget: vi.fn(async () => "/sign-in"),
  resolveOrgRoleForUser: vi.fn(async () => null),
}));
vi.mock("@/lib/auth-session", () => auth);

vi.mock("@/lib/scope-surface-entity-name", () => ({
  readScopeSurfaceEntityName: vi.fn(async () => null),
}));

/**
 * The tab BODIES are stood in for here on purpose: this suite is about the
 * ROUTE's redirect behaviour, and the bodies' own reads are proven in their own
 * suites. A stand-in that rendered nothing would let a body that redirects pass
 * unnoticed, so each one renders a marker the assertions look for.
 */
vi.mock("@/components/scope/scope-surface-artifacts-tab", () => ({
  ScopeSurfaceArtifactsTab: () => createElement("div", { "data-testid": "artifacts-body" }),
}));
vi.mock("@/components/scope/scope-surface-skills-tab", () => ({
  ScopeSurfaceSkillsTab: () => createElement("div", { "data-testid": "skills-body" }),
}));

async function renderRoute(
  load: () => Promise<{ default: (props: never) => Promise<unknown> }>,
  props?: unknown,
) {
  const mod = await load();
  const tree = await mod.default((props ?? {}) as never);
  render(tree as ReactNode);
}

beforeEach(() => {
  nav.redirect.mockClear();
  auth.requireAuthSession.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the workspace Artifacts and Skills tabs read without an active organization", () => {
  for (const [tab, load, marker] of [
    ["artifacts", () => import("../workspace/artifacts/page"), "artifacts-body"],
    ["skills", () => import("../workspace/skills/page"), "skills-body"],
  ] as const) {
    describe(`/workspace/${tab}`, () => {
      it("renders rather than redirecting", async () => {
        await renderRoute(load);
        expect(nav.redirect).not.toHaveBeenCalled();
      });

      it("mounts its tab body", async () => {
        await renderRoute(load);
        expect(document.querySelector(`[data-testid="${marker}"]`)).toBeTruthy();
      });

      it("keeps naming the workspace in its heading", async () => {
        await renderRoute(load);
        expect(document.querySelector("h1")?.textContent?.trim()).toBe("Workspace");
      });
    });
  }
});

describe("the four concrete scopes route to their own tab bodies", () => {
  for (const [name, tab, load, props, marker] of [
    ["personal", "artifacts", () => import("../personal/artifacts/page"), undefined, "artifacts-body"],
    ["personal", "skills", () => import("../personal/skills/page"), undefined, "skills-body"],
    [
      "organization",
      "artifacts",
      () => import("../organizations/[id]/artifacts/page"),
      { params: Promise.resolve({ id: "o1" }) },
      "artifacts-body",
    ],
    [
      "team",
      "skills",
      () => import("../teams/[teamId]/skills/page"),
      { params: Promise.resolve({ teamId: "t1" }) },
      "skills-body",
    ],
    [
      "project",
      "artifacts",
      () => import("../projects/[projectId]/artifacts/page"),
      { params: Promise.resolve({ projectId: "p1" }) },
      "artifacts-body",
    ],
    [
      "project",
      "skills",
      () => import("../projects/[projectId]/skills/page"),
      { params: Promise.resolve({ projectId: "p1" }) },
      "skills-body",
    ],
  ] as const) {
    it(`the ${name} ${tab} tab mounts its body and never redirects`, async () => {
      await renderRoute(load, props);
      expect(document.querySelector(`[data-testid="${marker}"]`)).toBeTruthy();
      expect(nav.redirect).not.toHaveBeenCalled();
    });
  }
});

/**
 * THE RUN WIZARD ROUTE OF AN INSTALLED, SCOPED-PACKAGE AGENT (cinatra#3369).
 *
 * Mounts the route `/agents/cinatra-ai/list-curator-agent/new` — the page module
 * itself — for an agent of the shape the issue names: a scoped package name, the
 * template published, an active canonical install row, and a REQUIRED skill
 * dependency (`@cinatra-ai/list-curation-skill`) that carries no canonical row
 * because the boot seeder anchors one only for the `required` set.
 *
 * MEASURED on a development boot of this branch before the fix: the route
 * answered 200 and drew the application's own not-found boundary. The two roads the issue names first are
 * both sound — the route reconstructs `@cinatra-ai/list-curator-agent` from the
 * URL segments and the template lookup finds the published row. What refused was
 * the launch gate inside `SetupScreen`'s `new` fast path, whose non-ok result the
 * screen turns into `notFound()`. The gate's reading is pinned in
 * `packages/agents/src/__tests__/list-curator-run-wizard-skill-dependency.test.ts`;
 * this suite pins what the ROUTE does with it.
 *
 * Only the IO is stubbed — the session, the template row, the canonical install
 * status, the authority mint and the launch coordinator. The route, the screen
 * resolver, the screen and the gate are the real ones, so a regression in any of
 * them fails here.
 *
 * Run:
 *   npx vitest run --config vitest.config.ts --no-coverage \
 *     "src/app/agents/[vendor]/[packageName]/[instanceId]/__tests__/run-wizard-route-installed-scoped-agent.test.tsx"
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const AGENT = "@cinatra-ai/list-curator-agent";
const SKILL = "@cinatra-ai/list-curation-skill";
const SCRAPE = "@cinatra-ai/web-scrape-agent";

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  getAuthSession: vi.fn(),
  readAgentTemplateBySlug: vi.fn(),
  readAgentTemplateByConnectorAndRemoteId: vi.fn(),
  verifySessionAuthority: vi.fn(),
  launchAgentRun: vi.fn(),
  readEffectiveStatusByPackageNames: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));
vi.mock("@/lib/auth-session", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAuthSession: mocks.getAuthSession,
}));
vi.mock("@cinatra-ai/agents/store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readAgentTemplateBySlug: mocks.readAgentTemplateBySlug,
  readAgentTemplateByConnectorAndRemoteId: mocks.readAgentTemplateByConnectorAndRemoteId,
}));
vi.mock("@/lib/org-write/authority", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifySessionAuthority: mocks.verifySessionAuthority,
}));
vi.mock("@cinatra-ai/extensions/canonical-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readEffectiveStatusByPackageNames: mocks.readEffectiveStatusByPackageNames,
}));
vi.mock("../../../../../../../packages/agents/src/lifecycle-coordinator", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  launchAgentRun: mocks.launchAgentRun,
}));

/** The `agent_templates` row MEASURED on the boot for this agent. */
const TEMPLATE = {
  id: "97b61aaa-5fe9-41e5-95c1-d192b3d22985",
  name: "List Curator Agent",
  packageName: AGENT,
  packageVersion: "0.2.0",
  status: "published",
  orgId: "org-1",
  creatorId: null,
};

const SESSION = {
  user: { id: "user-1", role: "admin" },
  session: { activeOrganizationId: "org-1" },
};

/** The canonical install rows MEASURED on the boot: the agent and its required
 *  agent dependency active, the required SKILL with no row at all. */
function statusesWith(extra: Record<string, "active" | "archived"> = {}) {
  const all: Record<string, "active" | "archived"> = {
    [AGENT]: "active",
    [SCRAPE]: "active",
    ...extra,
  };
  return async (names: string[]) =>
    new Map(names.filter((n) => all[n] !== undefined).map((n) => [n, all[n]]));
}

async function mountWizardRoute() {
  const page = (await import("../page")).default;
  return page({
    params: Promise.resolve({
      vendor: "cinatra-ai",
      packageName: "list-curator-agent",
      instanceId: "new",
    }),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notFound.mockImplementation(() => {
    throw new Error("NOT_FOUND");
  });
  mocks.redirect.mockImplementation((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  });
  mocks.getAuthSession.mockResolvedValue(SESSION);
  mocks.readAgentTemplateBySlug.mockResolvedValue(TEMPLATE);
  mocks.readAgentTemplateByConnectorAndRemoteId.mockResolvedValue(null);
  mocks.verifySessionAuthority.mockResolvedValue({ kind: "session", userId: "user-1" });
  mocks.launchAgentRun.mockResolvedValue({
    carrier: { kind: "run", run: { id: "run-3369" } },
  });
  mocks.readEffectiveStatusByPackageNames.mockImplementation(statusesWith());
});

describe("/agents/cinatra-ai/list-curator-agent/new (cinatra#3369)", () => {
  it("opens the wizard for the installed list curator instead of the not-found boundary", async () => {
    await expect(mountWizardRoute()).rejects.toThrow(/^REDIRECT:/);
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(mocks.launchAgentRun).toHaveBeenCalledTimes(1);
    const to = mocks.redirect.mock.calls[0]?.[0] as string;
    expect(to).toContain("/agents/cinatra-ai/list-curator-agent/");
    expect(to).toContain("run-3369");
  });

  it("resolves the scoped package name from the two URL segments", async () => {
    await expect(mountWizardRoute()).rejects.toThrow(/^REDIRECT:/);
    // Both lookups on this road — the screen resolver's and the screen's own —
    // are handed the vendor/name pair the route rebuilt `@` onto.
    for (const call of mocks.readAgentTemplateBySlug.mock.calls) {
      expect(call[0]).toBe("cinatra-ai/list-curator-agent");
    }
    expect(mocks.readAgentTemplateBySlug.mock.calls.length).toBeGreaterThan(0);
  });

  it("still draws the not-found boundary when the template does not resolve", async () => {
    mocks.readAgentTemplateBySlug.mockResolvedValue(null);
    await expect(mountWizardRoute()).rejects.toThrow("NOT_FOUND");
  });

  it("still refuses when the required skill's canonical row is ARCHIVED", async () => {
    mocks.readEffectiveStatusByPackageNames.mockImplementation(
      statusesWith({ [SKILL]: "archived" }),
    );
    await expect(mountWizardRoute()).rejects.toThrow("NOT_FOUND");
    expect(mocks.launchAgentRun).not.toHaveBeenCalled();
  });
});

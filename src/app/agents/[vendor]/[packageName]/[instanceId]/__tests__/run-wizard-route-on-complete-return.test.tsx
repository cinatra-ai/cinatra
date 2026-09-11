/**
 * THE RUN WIZARD ROUTE CARRIES THE LAUNCH'S RETURN DESTINATION (cinatra#3369,
 * acceptance item 2).
 *
 * The list picker's "Build a list with AI" CTA links to
 * `/agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker`. That
 * route mints a run and redirects to it, and a proof round on a development
 * boot measured that the destination URL carried NO QUERY AT ALL: the run the
 * CTA opened held no record of what it had been opened for, so nothing on it
 * could return the operator to the picker.
 *
 * This suite pins the redirect's target. It is the sibling of
 * `run-wizard-route-installed-scoped-agent.test.tsx` and mounts the same real
 * road — the route module, the screen resolver and the screen — with only the
 * IO stubbed.
 *
 * Run:
 *   npx vitest run --config vitest.config.ts --no-coverage \
 *     "src/app/agents/[vendor]/[packageName]/[instanceId]/__tests__/run-wizard-route-on-complete-return.test.tsx"
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const AGENT = "@cinatra-ai/list-curator-agent";
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

function statusesWith(extra: Record<string, "active" | "archived"> = {}) {
  const all: Record<string, "active" | "archived"> = {
    [AGENT]: "active",
    [SCRAPE]: "active",
    ...extra,
  };
  return async (names: string[]) =>
    new Map(names.filter((n) => all[n] !== undefined).map((n) => [n, all[n]]));
}

async function mountWizardRoute(
  searchParams?: Record<string, string | string[] | undefined>,
) {
  const page = (await import("../page")).default;
  return page({
    params: Promise.resolve({
      vendor: "cinatra-ai",
      packageName: "list-curator-agent",
      instanceId: "new",
    }),
    ...(searchParams ? { searchParams: Promise.resolve(searchParams) } : {}),
  } as never);
}

/** The one argument the route handed `redirect()`. */
async function redirectTargetFor(
  searchParams?: Record<string, string | string[] | undefined>,
): Promise<string> {
  await expect(mountWizardRoute(searchParams)).rejects.toThrow(/^REDIRECT:/);
  expect(mocks.notFound).not.toHaveBeenCalled();
  return mocks.redirect.mock.calls[0]?.[0] as string;
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

describe("/agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker (cinatra#3369)", () => {
  it("carries onComplete onto the fresh run's address", async () => {
    const to = await redirectTargetFor({ onComplete: "list-picker" });
    expect(to).toContain("/agents/cinatra-ai/list-curator-agent/run-3369");
    expect(to).toBe("/agents/cinatra-ai/list-curator-agent/run-3369?onComplete=list-picker");
  });

  it("carries it for the CTA's own link shape, where the param repeats", async () => {
    // A repeated query param arrives as an array. The first value still names
    // the destination, and the address is written once.
    const to = await redirectTargetFor({ onComplete: ["list-picker", "list-picker"] });
    expect(to).toBe("/agents/cinatra-ai/list-curator-agent/run-3369?onComplete=list-picker");
  });

  it("adds no query when the launcher was opened without one", async () => {
    const to = await redirectTargetFor();
    expect(to).toBe("/agents/cinatra-ai/list-curator-agent/run-3369");
  });

  it("does not echo an onComplete destination the product does not define", async () => {
    const to = await redirectTargetFor({ onComplete: "https://example.invalid/steal" });
    expect(to).toBe("/agents/cinatra-ai/list-curator-agent/run-3369");
    expect(to).not.toContain("example.invalid");
  });
});

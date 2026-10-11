/**
 * THE SKILLS PANE HAS A RUN ACCESS DOOR (cinatra#3693, convergence round 1,
 * finding 1).
 *
 * The pane lists a run's skill ledger, and both of its reads are plain SQL over
 * `run_id` with no actor: they enforce nothing themselves, so whatever stands in
 * front of them IS the door. Nothing did — and this leg mounts the pane under
 * every scope base, which would have made one hole reachable at five more
 * addresses.
 *
 * `readAgentRunById` with the actor is that door, the same call the run page and
 * the Permissions pane make. What is pinned here:
 *
 *   1. the door is asked BEFORE either ledger is read;
 *   2. a run the door refuses (AuthzError) is answered not-found, and no ledger
 *      is read at all, so a refused reader is not told the run exists;
 *   3. a run that does not exist is answered the same way;
 *   4. a reader with no session is sent to sign in.
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  AuthzError: class AuthzErrorStub extends Error {},
  getAuthSession: vi.fn(),
  readAgentRunById: vi.fn(),
  listSkillsUsedForRun: vi.fn(() => []),
  readRunSelectedSkillRevisions: vi.fn(() => []),
}));


vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

vi.mock("@/lib/authz", () => ({ AuthzError: mocks.AuthzError }));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  isPlatformAdmin: () => false,
  resolveOrgRoleForSession: vi.fn(async () => "member"),
  signInRedirectTarget: vi.fn(async () => "/sign-in"),
}));

vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: mocks.readAgentRunById,
}));

vi.mock("@/lib/agent-run-skills-used", () => ({
  listSkillsUsedForRun: mocks.listSkillsUsedForRun,
}));

vi.mock("@/lib/run-selected-skill-revisions", () => ({
  readRunSelectedSkillRevisions: mocks.readRunSelectedSkillRevisions,
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
vi.mock("@/components/crumb-contributions", () => ({
  CrumbContributions: ({ entries }: { entries: unknown }) => (
    <span data-crumbs={JSON.stringify(entries)} />
  ),
}));

import AgentPackageInstanceSkillsPage from "@/app/agents/[vendor]/[packageName]/[instanceId]/skills/page";

const RUN_ID = "run-3693";

function params() {
  return Promise.resolve({
    vendor: "fixture-vendor",
    packageName: "blog-draft-writer-agent",
    instanceId: RUN_ID,
  });
}

async function thrownBy(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

beforeEach(() => {
  mocks.getAuthSession.mockResolvedValue({
    user: { id: "u1" },
    session: { activeOrganizationId: "org-1" },
  });
  mocks.readAgentRunById.mockResolvedValue({ id: RUN_ID });
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the scoped skills pane asks the run's access door first (cinatra#3693)", () => {
  it("reads the ledger only for a run the door allows, and passes the actor", async () => {
    const tree = await AgentPackageInstanceSkillsPage({ params: params() });
    expect(renderToStaticMarkup(tree as React.ReactElement)).toContain("No skills recorded");
    expect(mocks.readAgentRunById).toHaveBeenCalledTimes(1);
    const [id, actor, roles] = mocks.readAgentRunById.mock.calls[0]!;
    expect(id).toBe(RUN_ID);
    expect(actor).toEqual({ actorType: "human", source: "ui", userId: "u1" });
    expect(roles).toEqual({
      platformRole: "member",
      orgRole: "member",
      actorOrganizationId: "org-1",
    });
    expect(mocks.listSkillsUsedForRun).toHaveBeenCalledTimes(1);
  });

  it("answers not-found for a run the door refuses, and reads no ledger", async () => {
    mocks.readAgentRunById.mockRejectedValue(new mocks.AuthzError("refused"));
    expect(await thrownBy(() => AgentPackageInstanceSkillsPage({ params: params() }))).toBe(
      "NEXT_NOT_FOUND",
    );
    expect(mocks.listSkillsUsedForRun).not.toHaveBeenCalled();
    expect(mocks.readRunSelectedSkillRevisions).not.toHaveBeenCalled();
  });

  it("answers not-found for a run that is not there, and reads no ledger", async () => {
    mocks.readAgentRunById.mockResolvedValue(null);
    expect(await thrownBy(() => AgentPackageInstanceSkillsPage({ params: params() }))).toBe(
      "NEXT_NOT_FOUND",
    );
    expect(mocks.listSkillsUsedForRun).not.toHaveBeenCalled();
  });

  it("sends a reader with no session to sign in, and reads no ledger", async () => {
    mocks.getAuthSession.mockResolvedValue(null);
    expect(await thrownBy(() => AgentPackageInstanceSkillsPage({ params: params() }))).toBe(
      "REDIRECT:/sign-in",
    );
    expect(mocks.readAgentRunById).not.toHaveBeenCalled();
    expect(mocks.listSkillsUsedForRun).not.toHaveBeenCalled();
  });

  it("names the scope in its trail when it is mounted under one", async () => {
    const tree = await AgentPackageInstanceSkillsPage({
      params: params(),
      scopeBase: "/organizations/o1",
      launchScope: { kind: "organization", id: "o1" },
      scopeTitle: "Acme",
    });
    expect(renderToStaticMarkup(tree as React.ReactElement)).toContain("data-crumbs");
  });
});

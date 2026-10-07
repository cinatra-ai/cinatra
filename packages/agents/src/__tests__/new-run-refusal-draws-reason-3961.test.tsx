// @vitest-environment jsdom
/** #3961: actual async launcher and approved Extensions §IV.2 refusal; framework and data ports only. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { buildAgentInstancePath, buildAgentWorkspacePath } from "@/lib/agent-url";
import { getCrumbSnapshot, clearCrumbContributions } from "@/lib/breadcrumb-contributions";
import { launchScopeAnchorForScope } from "@/lib/launch-scope-anchor";

const ORG_A = "org-A";
const AGENT_ID = "fixture-vendor/blog-idea-generator";

const mocks = vi.hoisted(() => ({
  viewerIsAdmin: false,
  createAndTriggerRunWithContext: vi.fn(),
  readScopeSurfaceOrganizationId: vi.fn(),
  getAuthSession: vi.fn(),
  readAgentTemplateBySlug: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  isPlatformAdmin: () => mocks.viewerIsAdmin,
  resolveOrgRoleForSession: vi.fn(async () => "member"),
  requireActorContext: vi.fn(),
  resolveActorGrantsForUserInOrg: vi.fn(async () => []),
}));

vi.mock("@/lib/scope-surface-eligibility.server", () => ({
  readScopeSurfaceOrganizationId: mocks.readScopeSurfaceOrganizationId,
}));

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { select: () => ({ from: () => ({ where: async () => [] }) }) },
  betterAuthUsers: {},
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readProjectOrganizationFacts: vi.fn(async () => []),
  readProjectAgentTemplateBindings: vi.fn(async () => []),
}));

vi.mock("../store", () => ({
  readAgentTemplateBySlug: mocks.readAgentTemplateBySlug,
  readAgentRunById: vi.fn(async () => null),
  readAgentRunMessages: vi.fn(async () => []),
  readAgentTemplates: vi.fn(async () => ({ items: [] })),
  ensureRunTitle: vi.fn(async () => "A run"),
  readRunCoOwners: vi.fn(async () => []),
}));

vi.mock("../auth-policy", () => ({
  resolveEffectivePolicy: vi.fn(() => ({ runDataVisibility: "owner" })),
  buildScopeReason: vi.fn(() => null),
  resolveTemplateVisibilityActor: vi.fn(async () => ({})),
}));

vi.mock("../run-actions", () => ({
  createAndTriggerRunWithContext: mocks.createAndTriggerRunWithContext,
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: false })),
  readRunOutputEvidence: vi.fn(async () => ({ hasOutput: false, hasArtifacts: false })),
}));

vi.mock("../run-sharing-actions", () => ({ removeRunOwner: vi.fn() }));

// The rest of the run page's data layer, stubbed as its other suites stub it:
// the launcher reads none of it, but the module graph imports it.
vi.mock("../artifact-review-gate-store", () => ({
  listReviewGatesForRun: vi.fn(async () => []),
  readReviewGate: vi.fn(async () => null),
  readRunReviewSlot: vi.fn(async () => ({ reviewTaskId: null, awaiting: false })),
  readVerificationRecordsForGates: vi.fn(async () => []),
}));
vi.mock("../lifecycle-policy-store", () => ({
  readLifecycleDecisionsForRun: vi.fn(async () => []),
}));
vi.mock("../recommendation-hold", () => ({
  readRecommendationParkForRun: vi.fn(async () => null),
}));
vi.mock("../hitl-context", () => ({
  deriveRunHitlContext: vi.fn(async () => null),
}));
vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => null),
}));
vi.mock("../trigger-schedule-proposal-store", () => ({
  readProposalConsumeByRunId: vi.fn(async () => null),
}));
vi.mock("../input-schema-resolver", () => ({
  resolveTemplateInputSchema: vi.fn(async () => null),
}));
vi.mock("@/lib/artifacts/run-made-artifacts", () => ({
  listRunMadeArtifacts: vi.fn(async () => []),
}));
vi.mock("../trigger-duration-estimate", () => ({
  estimateRunDuration: vi.fn(async () => ({ seconds: 60 })),
}));
vi.mock("@/lib/lifecycle/run-window-turn", () => ({
  canRespondInRunWindow: vi.fn(async () => true),
}));
vi.mock("../run-recommendation-core", () => ({
  recommendationDecidedForRun: vi.fn(() => false),
  resolveRecommendationHoldStateForActor: vi.fn(async () => null),
}));

import { SetupScreen } from "../instance-screens";

const TEMPLATE = { id: "template-3961", name: "Blog Idea Generator", packageName: "@fixture-vendor/blog-idea-generator", packageVersion: "1.0.0" };
const REASON = "Agent cannot run: @fixture-vendor/blog-idea-generator requires Context Selection (@cinatra-ai/context-selection-skill), which is not installed. Install the missing extension from the marketplace first.";
const MISSING = [{ packageName: "@cinatra-ai/context-selection-skill", displayName: "Context Selection", kind: "skill", reason: "not-installed" as const }];
const INSTALL_REFUSAL = { kind: "missing-required-dependency" as const, missing: MISSING };
const SESSION = { user: { id: "user-1", name: "A", email: "a@b.c" }, session: { activeOrganizationId: ORG_A } };

beforeEach(() => {
  vi.clearAllMocks();
  clearCrumbContributions();
  mocks.viewerIsAdmin = false;
  mocks.getAuthSession.mockResolvedValue(SESSION);
  mocks.readAgentTemplateBySlug.mockResolvedValue(TEMPLATE);
  mocks.readScopeSurfaceOrganizationId.mockResolvedValue("scope-org");
  mocks.createAndTriggerRunWithContext.mockResolvedValue({ ok: false, error: REASON, installRefusal: INSTALL_REFUSAL });
});
afterEach(cleanup);

// Navigation sentinels are handled only to turn the current false-gate routing
// into a behavior assertion. Import/setup/unexpected errors are never swallowed.
async function outcome(props: Parameters<typeof SetupScreen>[0] = { agentId: AGENT_ID, instanceId: "new" }) {
  try { return { tree: await SetupScreen(props), navigation: null }; }
  catch (error) {
    if (error instanceof Error && (error.message === "NEXT_NOT_FOUND" || error.message.startsWith("REDIRECT:"))) {
      return { tree: null, navigation: error.message };
    }
    throw error;
  }
}

describe("a refused /new run explains the refusal (cinatra#3961)", () => {
  it("shows the exact actionable dependency reason instead of routing to not-found", async () => {
    const result = await outcome();
    expect(mocks.createAndTriggerRunWithContext).toHaveBeenCalledExactlyOnceWith("user-1", ORG_A, TEMPLATE, null);
    expect(result.navigation).toBeNull();
    render(<>{result.tree}</>);
    const panel = screen.getByRole("alert");
    expect(panel.getAttribute("data-conformance-id")).toBe("agent-start-refused");
    expect(panel.textContent).toContain("Blog Idea Generator can't start");
    expect(panel.textContent).toContain("It requires Context Selection @cinatra-ai/context-selection-skill, which is not installed. Ask a platform administrator to install it, then start the agent again.");
    expect(screen.getByText("@cinatra-ai/context-selection-skill").className).toContain("font-mono");
    expect(screen.queryByRole("link", { name: "View requirements" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Agents" }).getAttribute("href")).toBe("/agents");
    expect(panel.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(panel.className).toContain("border-destructive/[0.34]");
    expect(panel.className).toContain("max-w-[560px]");
  });

  it("an administrator gets the real marketplace listing and install recourse", async () => {
    mocks.viewerIsAdmin = true;
    const result = await outcome();
    expect(result.navigation).toBeNull();
    render(<>{result.tree}</>);
    expect(screen.getByRole("link", { name: "View requirements" }).getAttribute("href")).toBe("/configuration/marketplace/fixture-vendor/blog-idea-generator");
    expect(screen.getByRole("alert").textContent).toContain("Install it from the marketplace, then start the agent again.");
    expect(screen.getByRole("alert").textContent).not.toContain("Ask a platform administrator");
  });

  it.each(["/workspace", "/organizations/scope-org", "/teams/team-1", "/projects/project-1", "/personal"])("Back to Agents keeps the authenticated launch base %s", async (scopeBase) => {
    const result = await outcome({ agentId: AGENT_ID, instanceId: "new", scopeBase });
    expect(result.navigation).toBeNull();
    render(<>{result.tree}</>);
    expect(screen.getByRole("link", { name: "Back to Agents" }).getAttribute("href")).toBe(`${scopeBase}/agents`);
  });

  it("publishes Agent run and the authenticated scope name instead of a vanished run name", async () => {
    const scope = { kind: "organization", id: "scope-org" } as const;
    const scopeBase = "/organizations/scope-org";
    render(<>{(await outcome({ agentId: AGENT_ID, instanceId: "new", scopeBase, launchScope: scope, scopeTitle: "Engineering" })).tree}</>);
    const entries = getCrumbSnapshot()?.entries;
    expect(entries).toContainEqual({ prefix: buildAgentWorkspacePath(AGENT_ID, { scopeBase }), label: "Agent run" });
    expect(entries).toContainEqual(expect.objectContaining({ prefix: scopeBase, label: "Engineering" }));
    expect(entries?.some(entry => entry.label === TEMPLATE.name)).toBe(false);
  });

  it("draws every missing dependency's actual name and mono identity, with plural recourse", async () => {
    mocks.createAndTriggerRunWithContext.mockResolvedValue({ ok: false, error: REASON, installRefusal: { ...INSTALL_REFUSAL, missing: [...MISSING, { packageName: "@fixture-vendor/another-skill", displayName: null, kind: "skill", reason: "archived" }] } });
    render(<>{(await outcome()).tree}</>);
    const panel = screen.getByRole("alert");
    expect(panel.textContent).toContain("Context Selection @cinatra-ai/context-selection-skill, @fixture-vendor/another-skill @fixture-vendor/another-skill, which are not installed.");
    expect(panel.textContent).toContain("Ask a platform administrator to install them, then start the agent again.");
    expect(panel.querySelectorAll("span.font-mono")).toHaveLength(2);
  });

  it("uses the package identity when the dependency has no usable display name", async () => {
    mocks.createAndTriggerRunWithContext.mockResolvedValue({ ok: false, error: REASON, installRefusal: { ...INSTALL_REFUSAL, missing: [{ ...MISSING[0], displayName: "  " }] } });
    render(<>{(await outcome()).tree}</>);
    expect(screen.getByRole("alert").querySelector("b")?.textContent).toBe(MISSING[0].packageName);
  });

  it("keeps unrelated returned refusals on their existing road instead of claiming an install failure", async () => {
    mocks.createAndTriggerRunWithContext.mockResolvedValue({ ok: false, error: "Configure a connector", code: "CONNECTOR_NOT_CONFIGURED", settingsHref: "/settings/connectors" });
    expect((await outcome()).navigation).toBe("NEXT_NOT_FOUND");
  });

  it("never infers install-gate metadata from matching error words", async () => {
    mocks.createAndTriggerRunWithContext.mockResolvedValue({ ok: false, error: REASON });
    expect((await outcome()).navigation).toBe("NEXT_NOT_FOUND");
  });

  it("draws dependency data as escaped React text, without raw backend diagnostics", async () => {
    const displayName = "<script>private()</script>";
    mocks.createAndTriggerRunWithContext.mockResolvedValue({ ok: false, error: "PRIVATE_BACKEND_TRACE", installRefusal: { ...INSTALL_REFUSAL, missing: [{ ...MISSING[0], displayName }] } });
    render(<>{(await outcome()).tree}</>);
    const panel = screen.getByRole("alert");
    expect(panel.textContent).toContain(displayName);
    expect(panel.querySelector("script")).toBeNull();
    expect(panel.textContent).not.toContain("PRIVATE_BACKEND_TRACE");
  });

  it.each([
    ["no session", () => mocks.getAuthSession.mockResolvedValue(null)],
    ["no active organization", () => mocks.getAuthSession.mockResolvedValue({ ...SESSION, session: { activeOrganizationId: null } })],
    ["actor-visible template unavailable", () => mocks.readAgentTemplateBySlug.mockResolvedValue(null)],
  ])("retains not-found and no launch for %s", async (_name, arrange) => {
    arrange();
    expect((await outcome()).navigation).toBe("NEXT_NOT_FOUND");
    expect(mocks.createAndTriggerRunWithContext).not.toHaveBeenCalled();
  });

  it("refuses an unauthorized scoped organization before launching", async () => {
    mocks.readScopeSurfaceOrganizationId.mockResolvedValue(null);
    const scope = { kind: "organization", id: "denied-org" } as const;
    expect((await outcome({ agentId: AGENT_ID, instanceId: "new", launchScope: scope, scopeBase: "/organizations/denied-org" })).navigation).toBe("NEXT_NOT_FOUND");
    expect(mocks.readScopeSurfaceOrganizationId).toHaveBeenCalledExactlyOnceWith(scope);
    expect(mocks.createAndTriggerRunWithContext).not.toHaveBeenCalled();
  });

  it("keeps successful scoped launch organization, human anchor and encoded actual run address", async () => {
    const scope = { kind: "organization", id: "scope-org" } as const;
    const scopeBase = "/organizations/scope-org";
    const runId = "created run/3961";
    mocks.createAndTriggerRunWithContext.mockResolvedValue({ ok: true, runId });
    const result = await outcome({ agentId: AGENT_ID, instanceId: "new", launchScope: scope, scopeBase });
    expect(mocks.createAndTriggerRunWithContext).toHaveBeenCalledExactlyOnceWith("user-1", "scope-org", TEMPLATE, launchScopeAnchorForScope(scope, "user-1"));
    expect(result.navigation).toBe(`REDIRECT:${buildAgentInstancePath(AGENT_ID, encodeURIComponent(runId), { scopeBase })}`);
  });

  it("does not translate a thrown backend failure into a returned refusal or reveal it", async () => {
    const failure = new Error("private backend failure");
    mocks.createAndTriggerRunWithContext.mockRejectedValue(failure);
    await expect(outcome()).rejects.toBe(failure);
  });
});

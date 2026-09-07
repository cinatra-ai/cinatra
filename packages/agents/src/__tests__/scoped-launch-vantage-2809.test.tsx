// @vitest-environment jsdom
/**
 * THE VANTAGE REACHES THE SCREEN, AND THE SCOPED RUN PAGE NAMES ITS SCOPE
 * (cinatra#2809, per-scope surfaces S3 — forward + fix leg 2).
 *
 * The first proof round read two failures against issue #2809's third
 * acceptance item and the ratified drawing's Breadcrumb section:
 *
 *   "the first crumb on every scoped page is the scope's NAME (a resolved label
 *    via the contribution channel, never the raw id) linking to the scope
 *    landing; on a persisted instance it is the instance's HOME scope, never the
 *    path wandered in through"
 *
 *   "While a name is genuinely unavailable, the crumb shows the id's first eight
 *    characters plus an ellipsis ('9c0dfce6…') — never a title-cased raw id."
 *
 * Failure 1: the plugin-registry boundary re-built the screen's props by hand
 * and copied three of them, so `scopeBase` and `launchScope` — the vantage the
 * scoped route passes — never reached the screen. The launcher therefore minted
 * no anchor and sent the fresh run to the bare global route.
 *
 * Failure 2: the run page's layout published its instance crumb at the BARE
 * `/agents/<vendor>/<package>/<run>` path and published nothing for the scope,
 * so on a scoped address neither crumb resolved: the trail's head fell back to
 * the scope id's abbreviation and its instance crumb to the run id's.
 *
 * Both are fixed where they are caused — at the boundary that resolves the
 * props, and at the layout that owns the page's ONE crumb publish.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/scoped-launch-vantage-2809.test.tsx
 */
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  clearCrumbContributions,
  selectCrumbContributions,
} from "@/lib/breadcrumb-contributions";
import { buildBreadcrumbTrail } from "@/lib/breadcrumb-trail";
import { scopeSurfaceCrumbEntries, type ScopeSurfaceRef } from "@/lib/scope-surfaces";

const ORG_ID = "88c63f08-4d2e-4c7a-9f1b-2a0d6e5c4b31";
const ORG_SCOPE: ScopeSurfaceRef = { kind: "organization", id: ORG_ID };
const ORG_BASE = `/organizations/${ORG_ID}`;
const AGENT_ID = "cinatra-ai/blog-draft-writer-agent";
const INSTANCE_ID = "run-2809";
const SCOPED_RUN_PATH = `${ORG_BASE}/agents/${AGENT_ID}/${INSTANCE_ID}`;
const BARE_RUN_PATH = `/agents/${AGENT_ID}/${INSTANCE_ID}`;
const RUN_NAME = "Blog Draft Writer Agent (1)";
const EPOCH = "anon";

vi.mock("lucide-react", () => ({
  Info: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "info", className }),
  Check: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "check", className }),
  Pencil: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "pencil", className }),
}));
const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../run-name-actions", () => ({
  saveRunName: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/components/agent-instance-nav", () => ({
  AgentInstanceNav: () => null,
}));
vi.mock("@cinatra-ai/sdk-ui", () => ({
  InlinePageTitle: React.forwardRef(function InlinePageTitleStub(
    { value, placeholder }: { value: string; placeholder: string },
    _ref: React.Ref<unknown>,
  ) {
    return <h1>{value || placeholder}</h1>;
  }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentPageLayout } from "../agent-page-layout";
import { resolveAgentScreenProps } from "../screen-props";

function repoFile(relative: string): string {
  const cwd = process.cwd();
  for (const candidate of [`${cwd}/${relative}`, `${cwd}/../../${relative}`]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error(`file not found: ${relative}`);
}

beforeEach(() => {
  clearCrumbContributions();
  nav.pathname = SCOPED_RUN_PATH;
});

afterEach(() => {
  cleanup();
  clearCrumbContributions();
});

// ---------------------------------------------------------------------------
// Item 1 — the vantage survives the plugin-registry boundary.
// ---------------------------------------------------------------------------

describe("the scoped route's props reach the instance screen (issue #2809 item 1)", () => {
  it("carries EVERY prop through, awaiting only the search params", async () => {
    const resolved = await resolveAgentScreenProps({
      agentId: AGENT_ID,
      instanceId: "new",
      scopeBase: ORG_BASE,
      launchScope: ORG_SCOPE,
      searchParams: Promise.resolve({ tab: "run" }),
    });
    expect(resolved).toEqual({
      agentId: AGENT_ID,
      instanceId: "new",
      scopeBase: ORG_BASE,
      launchScope: ORG_SCOPE,
      searchParams: { tab: "run" },
    });
  });

  it("leaves the BARE route's props exactly as they were", async () => {
    expect(await resolveAgentScreenProps({ agentId: AGENT_ID, instanceId: INSTANCE_ID })).toEqual({
      agentId: AGENT_ID,
      instanceId: INSTANCE_ID,
    });
  });

  it("routes the registry's instance screens through the resolver, never a hand-copied list", () => {
    const source = repoFile("packages/agents/src/screens.tsx");
    expect(source).toContain("resolveAgentScreenProps");
    // The hand-copied list is what dropped the vantage: a prop the boundary
    // does not name is a prop the screen never sees.
    expect(source).not.toContain("agentId: props.agentId");
  });
});

// ---------------------------------------------------------------------------
// Item 3 — the first crumb on a scoped run page is the scope's NAME.
// ---------------------------------------------------------------------------

function renderScopedRun(scopeTitle: string | undefined) {
  return render(
    <TooltipProvider>
      <AgentPageLayout
        agentId={AGENT_ID}
        instanceId={INSTANCE_ID}
        activeTab="run"
        templateName="Blog Draft Writer Agent"
        initialRunName={RUN_NAME}
        runId={INSTANCE_ID}
        scopeBase={ORG_BASE}
        scopeCrumbEntries={scopeSurfaceCrumbEntries(ORG_SCOPE, "agents", scopeTitle)}
      >
        <section data-reading="work">Drafted the post</section>
      </AgentPageLayout>
    </TooltipProvider>,
  );
}

function trailOn(pathname: string) {
  return buildBreadcrumbTrail(pathname, {
    contributions: selectCrumbContributions(pathname, EPOCH),
  }).map((c) => ({ label: c.label, href: c.href }));
}

describe("the scoped run page's trail (issue #2809 item 3)", () => {
  it("heads the trail with the scope's resolved NAME, linked to the scope landing", () => {
    renderScopedRun("Northwind Labs");
    expect(trailOn(SCOPED_RUN_PATH)).toEqual([
      { label: "Northwind Labs", href: ORG_BASE },
      { label: "Agents", href: `${ORG_BASE}/agents` },
      { label: RUN_NAME, href: SCOPED_RUN_PATH },
    ]);
  });

  it("publishes the instance crumb at the SCOPED path, not the bare one", () => {
    renderScopedRun("Northwind Labs");
    const published = selectCrumbContributions(SCOPED_RUN_PATH, EPOCH);
    expect(published.map((c) => c.prefix)).toContain(SCOPED_RUN_PATH);
    expect(published.map((c) => c.prefix)).not.toContain(BARE_RUN_PATH);
  });

  it("shows the id's first eight characters plus an ellipsis while the name is unavailable", () => {
    renderScopedRun(undefined);
    const labels = trailOn(SCOPED_RUN_PATH).map((c) => c.label);
    expect(labels).toEqual([`${ORG_ID.slice(0, 8)}…`, "Agents", RUN_NAME]);
    // Never a title-cased raw id.
    expect(labels[0]).not.toContain("-4d2e");
  });

  it("keeps the BARE run page exactly as it was", () => {
    nav.pathname = BARE_RUN_PATH;
    render(
      <TooltipProvider>
        <AgentPageLayout
          agentId={AGENT_ID}
          instanceId={INSTANCE_ID}
          activeTab="run"
          templateName="Blog Draft Writer Agent"
          initialRunName={RUN_NAME}
          runId={INSTANCE_ID}
        >
          <section data-reading="work">Drafted the post</section>
        </AgentPageLayout>
      </TooltipProvider>,
    );
    expect(selectCrumbContributions(BARE_RUN_PATH, EPOCH).map((c) => ({
      prefix: c.prefix,
      label: c.label,
    }))).toEqual([{ prefix: BARE_RUN_PATH, label: RUN_NAME }]);
    expect(trailOn(BARE_RUN_PATH)).toEqual([
      { label: "Agents", href: "/agents" },
      { label: RUN_NAME, href: BARE_RUN_PATH },
    ]);
  });
});

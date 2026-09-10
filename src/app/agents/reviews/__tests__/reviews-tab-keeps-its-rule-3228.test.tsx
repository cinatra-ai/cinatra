// @vitest-environment jsdom
/**
 * The Reviews tab (`/agents/reviews`) mounts NO toolbar, so it keeps the tab
 * strip's etched paired rule (cinatra#3228).
 *
 * The ratified drawing (the components reference, Toolbar): "The toolbar sits
 * directly below the page header and replaces the section rule for that view —
 * never stack a toolbar and the etched paired rule." The replacement is
 * conditional on a toolbar being there: a view with no toolbar keeps the rule,
 * which closes the header the page suppressed with `divider={false}`. This is
 * the third arm of the per-tab count — All Agents (toolbar 1 / rule 0,
 * `packages/agents/src/__tests__/agents-toolbar-replaces-rule-3228.test.tsx`),
 * Executions (toolbar 1 / rule 0,
 * `packages/dashboards/src/components/__tests__/executions-toolbar-replaces-rule-3228.test.tsx`),
 * Reviews (rule 1 / toolbar 0, here) — so a later change that mounts a toolbar
 * on this view without handing it the rule turns this red.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const h = vi.hoisted(() => ({
  access: { ok: false, reason: "forbidden" } as
    | { ok: false; reason: string }
    | { ok: true; orgId: string },
  // The real `OrgReviewGateVolume` shape, empty backlog — the chrome under
  // test (strip, rule, toolbar) is the same at any volume.
  volume: {
    orgId: "org-1",
    totalOpen: 0,
    oldestOpenAt: null as Date | null,
    aging: { under24h: 0, under7d: 0, over7d: 0 },
    byArtifactType: [] as ReadonlyArray<{ key: string; open: number }>,
    byDestinationClass: [] as ReadonlyArray<{ key: string; open: number }>,
    byOriginKind: [] as ReadonlyArray<{ key: string; open: number }>,
    openGates: [] as ReadonlyArray<Record<string, unknown>>,
    rollupScanned: 0,
    rollupTruncated: false,
  },
}));

vi.mock("@cinatra-ai/agents/lifecycle-policy-store", () => ({
  readOrgReviewGateVolume: vi.fn(async () => h.volume),
}));
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/artifacts/lifecycle-policy-access", () => ({
  resolveGateVolumeReadAccess: vi.fn(async () => h.access),
  lifecycleAccessMessage: () => "You cannot read this organization's review volume.",
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({ user: { id: "user-1" } })),
  getActorContext: vi.fn(async () => ({ organizationId: "org-1", orgRole: "member" })),
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  actorFromSession: () => ({ userId: "user-1", organizationId: "org-1" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  },
  usePathname: () => "/agents/reviews",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

import AgentReviewsPage from "../page";

afterEach(cleanup);

const RULE = '[data-slot="separator"][data-major]';
const TOOLBAR = '[data-slot="toolbar"]';
const STRIP = '[data-slot="agents-tab-nav"]';

async function renderReviews(): Promise<HTMLElement> {
  const element = await AgentReviewsPage();
  return render(element).container;
}

describe("/agents/reviews — no toolbar, so the strip keeps its rule (cinatra#3228)", () => {
  it("mounts the tab strip with its trailing rule and no toolbar", async () => {
    h.access = { ok: true, orgId: "org-1" };
    const container = await renderReviews();
    const strip = container.querySelector(STRIP)!;
    expect(strip, "the reviews view mounts the tab strip").toBeTruthy();
    expect(strip.querySelectorAll(RULE).length).toBe(1);
    expect(container.querySelectorAll(TOOLBAR).length).toBe(0);
  });

  it("keeps the same reading when the volume read is denied", async () => {
    h.access = { ok: false, reason: "forbidden" };
    const container = await renderReviews();
    const strip = container.querySelector(STRIP)!;
    expect(strip.querySelectorAll(RULE).length).toBe(1);
    expect(container.querySelectorAll(TOOLBAR).length).toBe(0);
  });
});

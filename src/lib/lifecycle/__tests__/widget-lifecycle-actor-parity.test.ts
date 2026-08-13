// AC-2 (cinatra#2574, epic #2564 S8a) — PER-ROW PARITY.
//
// "Per-row access on widget reads matches in-app results for the same
// principal." This file is that fixture, and it is deliberately built so the
// only thing it can be measuring is the actor:
//
//   • ONE principal (`user-1`) in ONE org, and BOTH lineages resolve their
//     org/team/project axes from the SAME bundle — the shared
//     `resolveActorGrantsForUserInOrg`, which is the single function both call
//     in production.
//   • ONE reader — S1's real `resolveLifecycleCardState`, unmocked.
//   • ONE decision — the REAL `enforceRunAccess` from the agents package, over
//     synthetic run rows. The owner short-circuit, the co-owner branch, the
//     cross-org guard, the kernel `can()` and the visibility-token matcher all
//     execute; only the row STORAGE is synthetic. A per-row access test that
//     stubbed the access decision would assert nothing.
//   • A run matrix that reaches every axis the degraded runtime context drops:
//     a team-visible run, a project-visible run, an org-admin-visible run.
//
// The two lineages now differ in NO way at all (cinatra#2674, epic #2564 S8e).
// S8a left exactly one intended divergence — the widget's platform-role floor —
// and this file asserted a strict SUBSET for a platform admin. S8e removed that
// floor in the change set that removed its justification (the embedding site's
// possession of the widget bearer), so the assertion is now EQUALITY on every
// principal, platform admins included. A re-introduced floor and an escalation
// both turn this file red, which is what the #2574 parity criterion asks for.

import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// The ref codec is keyed off the app secret; the suite pins one (same posture as
// the S1 refetch suite).
process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-parity";

import { buildActorContext } from "@/lib/authz/enforce";
import type { ProjectGrant } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// The one grant bundle both lineages read.
// ---------------------------------------------------------------------------
const USER_ID = "user-1";
const ORG_ID = "org-A";

const PROJECT_GRANTS: ProjectGrant[] = [
  { projectId: "proj-1", effectiveRole: "write", accessSource: "user" },
];
const GRANT_BUNDLE = {
  orgRole: "member" as "org_owner" | "org_admin" | "member" | undefined,
  teamIds: ["team-1"],
  teamRoles: { "team-1": "member" as const },
  projectGrants: PROJECT_GRANTS,
};

/** The session the in-app lineage sees. `role` drives the platform tier. */
let sessionRole: string | null = null;

const claimsForToken = () => ({
  userId: USER_ID,
  orgId: ORG_ID,
  siteId: "site-1",
  client: "wordpress",
  siteOrigin: "https://wp.test",
  agentSlug: "wordpress-content-editor",
  instanceId: "inst-1",
  jti: "jti-1",
  grantedScopes: ["lifecycle.read"],
});

// ---------------------------------------------------------------------------
// The mocked DB LEAVES. Everything above them is the real code.
//
// `requireActorContext` is transcribed here from its production body — session
// in, `buildActorContext(session, {teamIds, teamRoles, orgRole, projectGrants})`
// out, over the grant bundle. That is the whole function minus its two DB reads,
// which is exactly what a fixture may replace.
// ---------------------------------------------------------------------------
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => ({
    user: { id: USER_ID, role: sessionRole },
    session: { id: "sess-1", activeOrganizationId: ORG_ID },
  }),
  requireActorContext: async () =>
    buildActorContext(
      {
        user: { id: USER_ID, role: sessionRole },
        session: { activeOrganizationId: ORG_ID },
      } as never,
      {
        teamIds: GRANT_BUNDLE.teamIds,
        teamRoles: GRANT_BUNDLE.teamRoles,
        ...(GRANT_BUNDLE.orgRole ? { orgRole: GRANT_BUNDLE.orgRole } : {}),
        projectGrants: GRANT_BUNDLE.projectGrants,
      },
    ),
  resolveActorGrantsForUserInOrg: async (userId: string, orgId: string) => {
    // Pin the anchor: both lineages must ask for the SAME (user, org).
    expect(userId).toBe(USER_ID);
    expect(orgId).toBe(ORG_ID);
    return GRANT_BUNDLE;
  },
  resolveOrgRoleForUser: async () => GRANT_BUNDLE.orgRole,
  isPlatformAdmin: () => sessionRole === "admin",
}));

vi.mock("@/lib/widget-user-auth", () => ({
  consumeUserWidgetToken: () => ({ ok: true, claims: claimsForToken() }),
}));
// The platform tier the widget lineage resolves live (cinatra#2674). It reads
// the SAME `sessionRole` the in-app lineage's session carries, so the two
// lineages are being asked about one person with one standing — which is the
// only way an equality assertion between them means anything.
vi.mock("@/lib/better-auth-db", () => ({
  readUserIsPlatformAdmin: async () => sessionRole === "admin",
}));
vi.mock("@/lib/widget-auth-audit", () => ({ emitWidgetAuthAudit: () => {} }));

// ---------------------------------------------------------------------------
// The run matrix + the gate store seam. `enforceReviewRunAccess` delegates to
// the REAL run-access decision; the rest is row storage.
// ---------------------------------------------------------------------------
type RunRow = {
  id: string;
  orgId: string;
  runBy: string;
  authPolicy: {
    runListVisibility: string[];
    runDataVisibility: string[];
    runExecuteVisibility: string[];
    allowRunSharing: boolean;
  };
  coOwnerUserIds?: string[];
};

const policy = (visibility: string) => ({
  runListVisibility: [visibility],
  runDataVisibility: [visibility],
  runExecuteVisibility: [visibility],
  allowRunSharing: false,
});

/**
 * Every access shape a lifecycle reader can hold, including the three the
 * degraded runtime actor cannot express (team, project, org-admin).
 */
const RUNS: RunRow[] = [
  { id: "run-owned", orgId: ORG_ID, runBy: USER_ID, authPolicy: policy("owner") },
  { id: "run-workspace", orgId: ORG_ID, runBy: "someone-else", authPolicy: policy("workspace") },
  { id: "run-team-hit", orgId: ORG_ID, runBy: "someone-else", authPolicy: policy("team:team-1") },
  { id: "run-team-miss", orgId: ORG_ID, runBy: "someone-else", authPolicy: policy("team:team-9") },
  { id: "run-project-hit", orgId: ORG_ID, runBy: "someone-else", authPolicy: policy("project:proj-1") },
  { id: "run-project-miss", orgId: ORG_ID, runBy: "someone-else", authPolicy: policy("project:proj-9") },
  { id: "run-admin-tier", orgId: ORG_ID, runBy: "someone-else", authPolicy: policy("admin") },
  { id: "run-owner-other", orgId: ORG_ID, runBy: "someone-else", authPolicy: policy("owner") },
  {
    id: "run-coowner",
    orgId: ORG_ID,
    runBy: "someone-else",
    authPolicy: policy("owner"),
    coOwnerUserIds: [USER_ID],
  },
  { id: "run-foreign-org", orgId: "org-B", runBy: "someone-else", authPolicy: policy("workspace") },
];

const runById = new Map(RUNS.map((r) => [r.id, r]));

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", async () => {
  const { enforceRunAccess } = await import("@cinatra-ai/agents/auth-policy");
  const { AuthzError } = await import("@/lib/authz");
  return {
    enforceReviewRunAccess: async (
      runId: string,
      actor: unknown,
      op: string,
      roles: unknown,
    ) => {
      const run = runById.get(runId) ?? null;
      const runForCheck = run
        ? { ...run, effectivePolicy: run.authPolicy, coOwnerUserIds: run.coOwnerUserIds ?? [] }
        : null;
      try {
        await enforceRunAccess(
          runForCheck as never,
          actor as never,
          op as never,
          roles as never,
        );
        return { ok: true };
      } catch (err) {
        if (err instanceof AuthzError) return { ok: false, status: err.statusCode };
        throw err;
      }
    },
    // Every run in the matrix carries one PENDING gate; what varies is access.
    readReviewGateState: async () => ({ status: "pending", targets: [] }),
    readReviewGate: async () => ({ id: "gate-1", pinnedTargets: [] }),
  };
});
vi.mock("@cinatra-ai/agents/lifecycle-verification-read-store", () => ({
  readVerificationRecordForGate: async () => null,
}));

import { encodeLifecycleGateRef, resolveLifecycleCardState } from "../lifecycle-card-refetch";
import { resolveWidgetLifecycleActorContext } from "../widget-lifecycle-actor";
import { resolveReviewActorContext } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

/** The set of runs whose review-gate card actually DRAWS for this reader. */
async function visibleSet(actorCtx: ReviewActorContext): Promise<string[]> {
  const visible: string[] = [];
  for (const run of RUNS) {
    const ref = encodeLifecycleGateRef({ runId: run.id, reviewTaskId: "task-1" })!;
    const state = await resolveLifecycleCardState({
      viewType: "artifact_review_gate",
      ref,
      actorCtx,
    });
    if (state.state !== "absent") visible.push(run.id);
  }
  return visible;
}

async function inAppActor(): Promise<ReviewActorContext> {
  const ctx = await resolveReviewActorContext();
  if (!ctx) throw new Error("in-app actor did not resolve");
  return ctx;
}

async function widgetActor(): Promise<ReviewActorContext> {
  const r = await resolveWidgetLifecycleActorContext({
    token: "cwu_fixture",
    agentSlug: "wordpress-content-editor",
    requestOrigin: "https://wp.test",
  });
  if (!r.ok) throw new Error(`widget actor denied: ${r.reason}`);
  return r.actorCtx;
}

beforeEach(() => {
  sessionRole = null;
  GRANT_BUNDLE.orgRole = "member";
});

describe("AC-2 — the same principal sees the same rows on both surfaces", () => {
  it("ordinary member: the visible sets are IDENTICAL, row for row", async () => {
    const [inApp, widget] = await Promise.all([inAppActor(), widgetActor()]);
    const a = await visibleSet(inApp);
    const b = await visibleSet(widget);
    expect(b).toEqual(a);
    // And the fixture is not vacuously equal: it discriminates.
    expect(a).toEqual([
      "run-owned",
      "run-workspace",
      "run-team-hit",
      "run-project-hit",
      "run-coowner",
    ]);
    expect(a).not.toContain("run-team-miss");
    expect(a).not.toContain("run-project-miss");
    expect(a).not.toContain("run-owner-other");
    expect(a).not.toContain("run-foreign-org");
  });

  it("the TEAM row is what the degraded runtime actor would have lost", async () => {
    // The degraded context carries `teamIds: []` / `projectGrants: []`. Prove the
    // difference is real by running the same reader with those axes emptied: the
    // team- and project-granted runs disappear, which is precisely the silent
    // under-grant this slice exists to prevent.
    const widget = await widgetActor();
    const degraded: ReviewActorContext = {
      ...widget,
      roleHints: {
        ...widget.roleHints,
        teamIds: [],
        teamRoles: {},
        projectGrants: [],
      },
    };
    const full = await visibleSet(widget);
    const stunted = await visibleSet(degraded);
    expect(full).toContain("run-team-hit");
    expect(full).toContain("run-project-hit");
    expect(stunted).not.toContain("run-team-hit");
    expect(stunted).not.toContain("run-project-hit");
  });

  it("org ADMIN standing carries across identically (the `admin` visibility tier)", async () => {
    GRANT_BUNDLE.orgRole = "org_admin";
    const [inApp, widget] = await Promise.all([inAppActor(), widgetActor()]);
    const a = await visibleSet(inApp);
    const b = await visibleSet(widget);
    expect(b).toEqual(a);
    expect(a).toContain("run-admin-tier");
  });

  it("a foreign org's run is invisible on BOTH surfaces", async () => {
    const [inApp, widget] = await Promise.all([inAppActor(), widgetActor()]);
    expect(await visibleSet(inApp)).not.toContain("run-foreign-org");
    expect(await visibleSet(widget)).not.toContain("run-foreign-org");
  });
});

// ---------------------------------------------------------------------------
// codex round 0, finding 5 — an honest boundary on what the fixture above can
// prove, and a structural answer for the rest.
//
// The fixture proves the ACTOR ASSEMBLY and the REAL per-row decision. It
// cannot prove that the two lineages READ THE SAME ROWS, because it hands both
// the same bundle. That half is not left to a comment: it is a property of the
// code — one shared resolver, called by both — and these assertions pin it, so
// a future edit that re-forks the session lineage fails here rather than
// silently drifting from the widget one.
// ---------------------------------------------------------------------------
describe("the shared resolution lineage", () => {
  const AUTH_SESSION_SRC = readFileSync(
    path.resolve(__dirname, "../../auth-session.ts"),
    "utf8",
  );
  const WIDGET_ACTOR_SRC = readFileSync(
    path.resolve(__dirname, "../widget-lifecycle-actor.ts"),
    "utf8",
  );
  // cinatra#2577 split the LIVE-STANDING half into its own leaf (so the MCP
  // pull's widget branch does not drag the `cwu_` token store onto four
  // route-locked graphs). The lineage assertion follows the resolution, so it
  // reads the leaf; the door module is still read for what must NOT be there.
  const WIDGET_STANDING_SRC = readFileSync(
    path.resolve(__dirname, "../widget-lifecycle-frame-actor.ts"),
    "utf8",
  );

  /** The body of one top-level `async function <name>(` declaration. */
  function bodyOf(source: string, name: string): string {
    const start = source.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf("\nexport ", start + 1);
    return source.slice(start, next === -1 ? source.length : next);
  }

  it("the SESSION lineage resolves through the shared resolver, not its own queries", () => {
    const body = bodyOf(AUTH_SESSION_SRC, "resolveSessionGrantsAndTeams");
    expect(body).toContain("resolveActorGrantsForUserInOrg(");
    // No second copy of the grant/team reads inside the session path.
    expect(body).not.toContain("readProjectGrantsForUser(");
    expect(body).not.toContain("readTeamsForUser(");
  });

  it("the WIDGET lineage resolves through the SAME shared resolver, and nothing else", () => {
    expect(WIDGET_STANDING_SRC).toContain("resolveActorGrantsForUserInOrg(");
    for (const src of [WIDGET_STANDING_SRC, WIDGET_ACTOR_SRC]) {
      expect(src).not.toContain("readProjectGrantsForUser(");
      expect(src).not.toContain("readTeamsForUser(");
    }
  });

  it("cinatra#2577: the split left exactly ONE standing resolution, in the leaf", () => {
    // The split's whole risk is a second copy appearing in the door. The door
    // must call the leaf and never the resolver, so the two entries can never
    // resolve a reader differently.
    expect(WIDGET_ACTOR_SRC).not.toContain("resolveActorGrantsForUserInOrg(");
    expect(WIDGET_ACTOR_SRC).toContain("resolveWidgetLifecycleStanding(");
    // And the leaf must not have acquired the token door on its way out.
    expect(WIDGET_STANDING_SRC).not.toContain("consumeUserWidgetToken");
  });

  it("the app's actor entry points still go THROUGH the session helper", () => {
    // codex round 1: pinning the helper is not transitive on its own — a
    // refactor could fork `requireActorContext` and leave the helper behind,
    // intact and unused. Both public entry points are pinned to it here.
    for (const fn of ["getActorContext", "requireActorContext"]) {
      const body = bodyOf(AUTH_SESSION_SRC, fn);
      expect(body).toContain("resolveSessionGrantsAndTeams(session)");
    }
  });

  it("the shared resolver threads teams and role INTO the project-grant query", () => {
    // The options are load-bearing: a project reachable only through a team, or
    // only through org standing, is invisible without them. Both lineages get
    // this because there is one call site.
    const body = bodyOf(AUTH_SESSION_SRC, "resolveActorGrantsForUserInOrg");
    expect(body).toContain("readTeamsForUser(userId, orgId)");
    expect(body).toContain("readProjectGrantsForUser(userId, orgId, {");
    expect(body).toContain("teamIds");
    expect(body).toContain("teamRoles");
    expect(body).toContain("orgRole");
  });
});

// ---------------------------------------------------------------------------
// cinatra#2674 (epic #2564 S8e) — THE LAST FLOORED AXIS IS GONE.
//
// The AC: "A platform-admin widget user retains `platform_admin` through the
// verified widget principal … The #2574 parity criterion holds with no floored
// axis." The two cases below are the read-surface leg of that; the OBO-token,
// request-frame, carrier-run and assigned-skill legs are asserted in
// `widget-platform-parity.test.ts`.
//
// NEGATIVE CONTROL FIRST: the fixture must still be able to tell the two tiers
// apart, or an equality assertion would pass for the wrong reason.
// ---------------------------------------------------------------------------
describe("cinatra#2674 — the platform tier is carried, not floored", () => {
  it("the fixture DISCRIMINATES: platform standing unlocks a row an ordinary member cannot see", async () => {
    sessionRole = null;
    const memberSet = await visibleSet(await inAppActor());
    sessionRole = "admin";
    const adminSet = await visibleSet(await inAppActor());
    expect(memberSet).not.toContain("run-owner-other");
    expect(adminSet).toContain("run-owner-other");
  });

  it("a PLATFORM ADMIN carries `platform_admin` through the widget, and sees the SAME rows", async () => {
    sessionRole = "admin";
    const [inApp, widget] = await Promise.all([inAppActor(), widgetActor()]);
    expect(inApp.roleHints?.platformRole).toBe("platform_admin");
    expect(widget.roleHints?.platformRole).toBe("platform_admin");

    const a = await visibleSet(inApp);
    const b = await visibleSet(widget);
    expect(b).toEqual(a);
    // The row platform standing unlocks is visible on BOTH surfaces now.
    expect(b).toContain("run-owner-other");
  });

  it("an ORDINARY member is NOT elevated — the removal did not turn into a grant", async () => {
    sessionRole = null;
    const widget = await widgetActor();
    expect(widget.roleHints?.platformRole).toBe("member");
    expect(await visibleSet(widget)).not.toContain("run-owner-other");
  });
});

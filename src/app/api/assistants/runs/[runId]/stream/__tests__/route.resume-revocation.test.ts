import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// AC-10 STREAM RESUME cell (cinatra#2573, epic #2564 S7 acceptance).
//
// The program's revocation-after-emission matrix asks: link, site, membership
// or token revoked BETWEEN a lifecycle DATA_PART's emission and the next
// consuming action — does it fail closed? Three of the matrix's four cells
// were proven at their own seam (review-island-serving.test.ts for the card
// refetch / island paint, capture-capability-serving.test.ts for the capture
// GET, decide/route.test.ts for the decision). This file is the fourth: the
// broker widget's AG-UI STREAM RESUME
// (GET /api/assistants/runs/[runId]/stream, MODE 2 — cinatra#1221 option A).
//
// THE SEAM. src/app/api/assistants/runs/[runId]/stream/route.ts lines ~153-193:
// a sessionless GET verifies the run-bound resume token, then asks TWO live
// questions of the ONE `cwu_` row it names (`resumeActor.parentJti`), and
// EITHER refusing is a fail-closed 401 before the durable event log is ever
// touched:
//   1. readWidgetTokenParentLiveness(parentJti) !== "live"   (cinatra#2684 —
//      is the sign-in behind the token still there)
//   2. isWidgetBrokerSessionLive({...})                       (cinatra#2575 —
//      is the row still bound as claimed, held by a member: site active,
//      credential generation unrotated, org membership intact)
//
// WHAT WAS MISSING (the S7 gap this closes). Every existing suite over this
// seam (route.resume-token.test.ts, route.middleware-seam.test.ts) proves the
// AUTHORIZATION GATE in isolation — a token is minted, a liveness mock is
// flipped, the SAME call 401s. None of them narrate the matrix's actual claim:
// a stream that was ALREADY OPEN and had ALREADY DELIVERED a lifecycle
// DATA_PART, whose credential is THEN revoked, THEN reconnected to. This file
// adds that temporal shape — open-with-DATA_PART, revoke, resume — once per
// revocation kind the matrix names, so AC-10's stream-resume cell stops being
// "proven only indirectly."
//
// THE FOUR KINDS, AS THIS SEAM'S OWN FIXTURES DISTINGUISH THEM. The route asks
// exactly two questions, so TOKEN is its own distinguishable fixture
// (`readWidgetTokenParentLiveness`) while LINK, SITE and MEMBERSHIP funnel
// through the ONE `isWidgetBrokerSessionLive` probe. That probe's own doc
// ("NO REASONS OUT... One boolean") and its own suite
// (widget-broker-liveness.test.ts, "the four withdrawals stop the next
// reconnect") already collapse SITE SUSPENSION and credential ROTATION
// (LINK) into the identical `readLiveWidgetCapturePrincipal -> null` fixture,
// while MEMBERSHIP is the one branch that fixture DOES distinguish
// (`resolveActorGrantsForUserInOrg` answering no `orgRole`). This file mirrors
// that exact split rather than inventing a finer one the seam does not have:
// TOKEN gets its own case, SITE+LINK collapse into one case (comment below),
// MEMBERSHIP gets its own case.
//
// `isWidgetBrokerSessionLive` is deliberately left UNMOCKED here (unlike the
// sibling suites) so a MEMBERSHIP fixture can be expressed at all: its two
// collaborators (`readLiveWidgetCapturePrincipal`, `resolveActorGrantsForUserInOrg`)
// are mocked instead, and the real probe runs on top of them.
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const resolveActorGrantsForUserInOrg = vi.fn();
const findAssistantTurnByRunId = vi.fn();
const getAssistantThread = vi.fn();
const loadChatThreadForActorAccess = vi.fn();
const subscribeToAgUiEventsWithId = vi.fn();
const readLiveWidgetCapturePrincipal = vi.fn();

const parentLiveness = vi.fn((_jti: unknown) => "live" as "live" | "dead" | "unknown");

// cinatra#2684 — the resume token is derived from a `cwu_` row, so the route
// re-asks whether that row's Better Auth session is still signed in. Mocked as
// a data switch, exactly as the sibling seam suites mock it: "live" is a
// signed-in person, anything else is a sign-out (TOKEN revoked).
vi.mock("@/lib/widget-session-binding", () => ({
  readWidgetTokenParentLiveness: (jti: unknown) => parentLiveness(jti),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
  // The REAL isWidgetBrokerSessionLive (unmocked, below) calls this directly —
  // it is the MEMBERSHIP rung.
  resolveActorGrantsForUserInOrg: (...a: unknown[]) =>
    resolveActorGrantsForUserInOrg(...a),
}));
vi.mock("@/lib/assistant-thread-store", () => ({
  findAssistantTurnByRunId: (id: string) => findAssistantTurnByRunId(id),
  getAssistantThread: (id: string) => getAssistantThread(id),
}));
vi.mock("@/lib/chat-thread-store", () => ({
  loadChatThreadForActorAccess: (i: unknown) => loadChatThreadForActorAccess(i),
}));
// The REAL isWidgetBrokerSessionLive (@/lib/widget-broker-liveness) is left
// UNMOCKED so its own site/credential-generation and membership rungs both run
// for real; only its jti-keyed collaborator is mocked — the SITE+LINK rung.
vi.mock("@/lib/lifecycle/widget-capture-principal", () => ({
  readLiveWidgetCapturePrincipal: (jti: unknown) => readLiveWidgetCapturePrincipal(jti),
}));

vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({
  subscribeToAgUiEventsWithId: (runId: string, opts: unknown) =>
    subscribeToAgUiEventsWithId(runId, opts),
}));

import { GET } from "../route";
import { issueWidgetChatResumeToken } from "@/lib/widget-chat-resume-token";
import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";

const RUN = "run-ac10-resume";
const GATE = { runId: RUN, reviewTaskId: "task-ac10-1" };
const PARENT_JTI = "cwu-ac10-parent";
const SITE_ID = "site-ac10";
const USER_ID = "user-ac10";
const ORG_ID = "org-ac10";
const INSTANCE_ID = "inst-ac10-canonical";

/** The live `cwu_` principal the resume token's claim must match. */
const LIVE_PRINCIPAL = {
  userId: USER_ID,
  orgId: ORG_ID,
  siteId: SITE_ID,
  client: "wordpress",
  instanceId: INSTANCE_ID,
  agentSlug: "wordpress-content-editor",
  siteOrigin: "https://wp.example.test",
};

function req(
  opts: { authHeader?: string; lastEventId?: string } = {},
): [Request, { params: Promise<{ runId: string }> }] {
  const headers: Record<string, string> = {};
  if (opts.authHeader) headers["authorization"] = opts.authHeader;
  if (opts.lastEventId) headers["last-event-id"] = opts.lastEventId;
  return [
    new Request(`https://app.test/api/assistants/runs/${RUN}/stream`, { headers }),
    { params: Promise.resolve({ runId: RUN }) },
  ];
}

function mintResume(): string {
  return issueWidgetChatResumeToken({
    userId: USER_ID,
    orgId: ORG_ID,
    instanceId: INSTANCE_ID,
    kind: "wordpress",
    runId: RUN,
    jti: "run-nonce-ac10",
    parentJti: PARENT_JTI,
    siteId: SITE_ID,
  });
}

/**
 * A real lifecycle DATA_PART — `{ viewType, schemaVersion, ref }`, the closed
 * wire shape every lifecycle card rides (packages/agent-ui-protocol/src/
 * renderable-views/lifecycle-cards.ts: "THE WIRE PAYLOAD IS A REF, NEVER
 * CONTENT"). Built lazily (called only once the generator below is iterated at
 * test time) because the ref codec needs BETTER_AUTH_SECRET, which beforeAll
 * sets — module-load time is too early.
 */
function lifecycleDataPart() {
  return {
    type: "DATA_PART",
    data: {
      viewType: "artifact_review_gate",
      schemaVersion: 1,
      ref: encodeLifecycleGateRef(GATE)!,
    },
  };
}

/** The open stream's ONE frame: a lifecycle DATA_PART with a real SSE id. */
async function* controlStream() {
  yield { id: "5-0", event: lifecycleDataPart() };
}

const BEFORE_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-ac10-resume-revocation";
});
afterAll(() => {
  if (BEFORE_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = BEFORE_AUTH_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: everything live — the sign-in, the `cwu_` row's site/credential
  // binding, and the org membership.
  parentLiveness.mockReturnValue("live");
  readLiveWidgetCapturePrincipal.mockReturnValue({ ...LIVE_PRINCIPAL });
  resolveActorGrantsForUserInOrg.mockResolvedValue({
    orgRole: "member",
    teamIds: [],
    teamRoles: {},
    projectGrants: [],
  });
  // Broker path: no in-app session.
  getAuthSession.mockResolvedValue(null);
  isPlatformAdmin.mockReturnValue(false);
  findAssistantTurnByRunId.mockReturnValue({ id: "turn-ac10", threadId: "th-ac10", runId: RUN });
  getAssistantThread.mockReturnValue(null);
  loadChatThreadForActorAccess.mockReturnValue(null);
  subscribeToAgUiEventsWithId.mockImplementation(controlStream);
});

/** Opens the stream and asserts the lifecycle DATA_PART really rode it — the
 * matrix's precondition ("DATA_PART emission") has to be a proven fact, not an
 * assumption, before a later refusal means anything. */
async function openWithDataPart(): Promise<void> {
  const opened = await GET(...req({ authHeader: `Bearer ${mintResume()}` }));
  expect(opened.status).toBe(200);
  const body = await opened.text();
  expect(body).toContain("id: 5-0");
  expect(body).toContain('"viewType":"artifact_review_gate"');
}

/** Asserts a reconnect attempt failed closed: 401, no stream, no replayed or
 * leaked lifecycle content, and the durable log never re-touched. */
async function expectResumeFailsClosed(): Promise<void> {
  const resumed = await GET(
    ...req({ authHeader: `Bearer ${mintResume()}`, lastEventId: "5-0" }),
  );
  expect(resumed.status).toBe(401);
  expect(resumed.headers.get("content-type")).not.toBe("text/event-stream");
  const body = await resumed.text();
  // The fixed, generic refusal — never the lifecycle ref, the reviewTaskId or
  // the runId. No oracle for which of the two live checks said no.
  expect(body).toBe("Unauthorized");
  expect(body).not.toContain(GATE.reviewTaskId);
  expect(body).not.toContain(RUN);
  // ONE call total — the earlier control open. The reconnect never re-reads
  // the durable log, so no DATA_PART (this one or a later one) is even
  // fetched, let alone delivered.
  expect(subscribeToAgUiEventsWithId).toHaveBeenCalledTimes(1);
}

describe("AC-10 stream resume: a revocation landing between DATA_PART emission and reconnect fails closed", () => {
  it("NEGATIVE CONTROL: nothing revoked — the DATA_PART rides the open stream, and the Last-Event-ID resume still succeeds", async () => {
    await openWithDataPart();

    const resumed = await GET(
      ...req({ authHeader: `Bearer ${mintResume()}`, lastEventId: "5-0" }),
    );
    expect(resumed.status).toBe(200);
    expect(subscribeToAgUiEventsWithId).toHaveBeenLastCalledWith(
      RUN,
      expect.objectContaining({ fromId: "5-0" }),
    );
  });

  it("TOKEN: the sign-in behind the resume token ends after the DATA_PART emits — the reconnect fails closed (cinatra#2684)", async () => {
    await openWithDataPart();

    parentLiveness.mockReturnValue("dead"); // the sign-out, landing after emission

    await expectResumeFailsClosed();
  });

  it("SITE + LINK: the connect site is suspended, or its credential is rotated, after the DATA_PART emits — the reconnect fails closed (cinatra#2575)", async () => {
    // Collapsed into ONE fixture deliberately, not for lack of trying: SITE
    // suspension/revocation and a LINK credential rotation (reconnect bumping
    // `credential_version`) are re-checked by the SAME jti-keyed read
    // (readLiveWidgetCapturePrincipal — src/lib/lifecycle/widget-capture-
    // principal.ts) and answer with the SAME `null` on either failure; the
    // probe above it (isWidgetBrokerSessionLive) is documented "NO REASONS
    // OUT... One boolean" for exactly this reason. widget-broker-liveness.
    // test.ts's own suite makes the identical call under the heading "SITE
    // SUSPENSION / revocation / credential rotation — the probe refuses". This
    // test proves the STREAM-RESUME seam honours that one answer; the two
    // real-world causes behind it are unit-proven individually at their own
    // seam (review-island-serving.test.ts: "REFUSES a revoked site" / "REFUSES
    // a ROTATED credential generation").
    await openWithDataPart();

    readLiveWidgetCapturePrincipal.mockReturnValue(null); // site gone OR re-keyed

    await expectResumeFailsClosed();
  });

  it("MEMBERSHIP: the org membership is removed after the DATA_PART emits — the reconnect fails closed (cinatra#2575)", async () => {
    await openWithDataPart();

    // The `cwu_` row survives a membership removal — it is bound to a site and
    // a person, not a grant — so this is the rung that catches it (mirrors
    // widget-broker-liveness.test.ts's own "MEMBERSHIP REMOVAL" case).
    resolveActorGrantsForUserInOrg.mockResolvedValue({
      teamIds: [],
      teamRoles: {},
      projectGrants: [],
    }); // no orgRole

    await expectResumeFailsClosed();
  });
});

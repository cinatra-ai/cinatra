// The WIDGET decision entry (cinatra#2575, epic #2564 S8b).
//
// The suite is the issue's acceptance criteria, in order:
//
//   AC-2  a `cwu_` alone — replayed server-side, exactly as a hostile site
//         admin can — is refused HERE, before anything about a gate is touched;
//   AC-3  the capability misuse matrix: expired, replayed, wrong-gate,
//         wrong-site, wrong-audience, wrong-principal, all refused
//         PRE-DISCLOSURE (no store read, no gate read, no decision call);
//   AC-1  the happy path reaches the ONE decision module with the SAME
//         arguments the first-party entries pass, so the audit row it writes is
//         indistinguishable in shape from an in-app decision.
//
// Plus the S6b semantics the widget path must INHERIT rather than re-implement:
// an idempotent retry and a conflict are the decision core's answers, returned
// verbatim, and this route never pre-empts them by refusing a settled gate.
//
// "Pre-disclosure" is asserted as a claim about CALLS, not about wording: the
// mocks record whether the burn, the run-access check, the gate read and the
// decision helper were reached at all. A refusal that had already read the gate
// would pass a body-shape test and fail these.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-broker-decide";

const resolveWidgetLifecycleActorContext = vi.fn();
const consumeActionCapability = vi.fn();
const enforceReviewRunAccess = vi.fn();
const readReviewGatePinnedTargets = vi.fn();
const submitReviewDecisionAction = vi.fn();

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: (...args: unknown[]) => enforceReviewRunAccess(...args),
}));

vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  readReviewGatePinnedTargets: (...args: unknown[]) => readReviewGatePinnedTargets(...args),
}));

vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions",
  () => ({
    submitReviewDecisionAction: (...args: unknown[]) => submitReviewDecisionAction(...args),
  }),
);

vi.mock("@/lib/lifecycle/widget-action-capability-store", async (importOriginal) => {
  // PARTIAL: only the burn is doubled. `actionCapabilityRowBinding` is the ONE
  // row->binding mapping the confirmation and the redemption share, so doubling
  // it here would hide exactly the drift it exists to prevent.
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    consumeActionCapability: (...args: unknown[]) => consumeActionCapability(...args),
  };
});

vi.mock("@/lib/lifecycle/widget-lifecycle-actor", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveWidgetLifecycleActorContext: (...args: unknown[]) =>
      resolveWidgetLifecycleActorContext(...args),
  };
});

import {
  ACTION_CAPABILITY_DECIDE_ROUTE_PATH,
  ACTION_CAPABILITY_HEADER,
  ACTION_CAPABILITY_PURPOSE_DECIDE,
  decisionPayloadDigest,
  mintActionCapability,
  pinnedTargetsDigest,
  type ActionCapabilityPayload,
} from "@/lib/lifecycle/widget-action-capability";
import { WIDGET_LIFECYCLE_DECIDE_GRANT } from "@/lib/lifecycle/widget-lifecycle-actor";

import { POST } from "../route";

const TARGETS = [{ artifactId: "art-1", representationRevisionId: "rev-1" }];

const CLAIMS = {
  userId: "user-1",
  orgId: "org-1",
  siteId: "site-1",
  client: "wordpress",
  siteOrigin: "https://shop.example",
  agentSlug: "wordpress-content-editor",
  instanceId: "inst-1",
  jti: "wjti-1",
  grantedScopes: ["lifecycle.read", "lifecycle.decide"],
};

const ACTOR = {
  actor: { actorType: "human", userId: "user-1", source: "a2a", orgId: "org-1" },
  orgId: "org-1",
  roleHints: { platformRole: "member", actorOrganizationId: "org-1" },
};

const BASE: ActionCapabilityPayload = {
  capabilityId: "cap-1",
  purpose: ACTION_CAPABILITY_PURPOSE_DECIDE,
  audience: ACTION_CAPABILITY_DECIDE_ROUTE_PATH,
  orgId: CLAIMS.orgId,
  userId: CLAIMS.userId,
  jti: CLAIMS.jti,
  siteId: CLAIMS.siteId,
  client: CLAIMS.client,
  instanceId: CLAIMS.instanceId,
  agentSlug: CLAIMS.agentSlug,
  runId: "run-1",
  reviewTaskId: "gate-1",
  disposition: "approve",
  targetsDigest: pinnedTargetsDigest(TARGETS),
  decisionDigest: decisionPayloadDigest({ disposition: "approve", comment: null }),
};

/**
 * The row the consume edge would return for the LAST capability sealed here.
 *
 * The route compares the burnt row's binding against the sealed one, so a test
 * double that always returned `BASE` would make every override look like a
 * store/capability disagreement rather than the axis under test. Sealing and
 * recording the row together keeps the double honest: the store agrees with the
 * capability unless a test deliberately makes it disagree.
 */
let storedRow: ActionCapabilityPayload = BASE;

function seal(overrides: Partial<ActionCapabilityPayload> = {}): string {
  const payload = { ...BASE, ...overrides };
  storedRow = payload;
  return mintActionCapability(payload) as string;
}

function rowFor(payload: ActionCapabilityPayload) {
  return {
    ...payload,
    widgetJti: payload.jti,
    subjectLabel: "Autumn sale (Blog)",
    commentText: null,
    confirmed: true,
    consumed: true,
  };
}

function post(options: {
  capability?: string | null;
  token?: string | null;
  body?: unknown;
}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.capability !== null) {
    headers[ACTION_CAPABILITY_HEADER] = options.capability ?? seal();
  }
  if (options.token !== null) {
    headers["X-Cinatra-Widget-User-Token"] = options.token ?? "cwu_live";
  }
  headers["X-Cinatra-Widget-Origin"] = "https://shop.example";
  return new Request("https://app.example/api/lifecycle-views/broker-decide", {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? { assistant: "wordpress", comment: null }),
  });
}

/** Nothing about the gate, the run or the decision was touched. */
function expectPreDisclosure(): void {
  expect(consumeActionCapability).not.toHaveBeenCalled();
  expect(enforceReviewRunAccess).not.toHaveBeenCalled();
  expect(readReviewGatePinnedTargets).not.toHaveBeenCalled();
  expect(submitReviewDecisionAction).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveWidgetLifecycleActorContext.mockResolvedValue({
    ok: true,
    actorCtx: ACTOR,
    claims: CLAIMS,
  });
  storedRow = BASE;
  consumeActionCapability.mockImplementation(async (capabilityId: string) =>
    rowFor({ ...storedRow, capabilityId }),
  );
  enforceReviewRunAccess.mockResolvedValue({ ok: true });
  readReviewGatePinnedTargets.mockResolvedValue(TARGETS);
  submitReviewDecisionAction.mockResolvedValue({
    kind: "decided",
    disposition: "approve",
    idempotent: false,
  });
});

describe("AC-2 — the widget bearer alone decides nothing", () => {
  it("a request with a valid `cwu_` and NO capability is refused pre-disclosure", async () => {
    const res = await POST(post({ capability: null }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      outcome: { kind: "not-permitted" },
    });
    expectPreDisclosure();
    // ...and the bearer was never even consumed: the capability rung is first.
    expect(resolveWidgetLifecycleActorContext).not.toHaveBeenCalled();
  });

  it("a missing capability and a gate the caller cannot read answer IDENTICALLY", async () => {
    const withoutCapability = await POST(post({ capability: null }));
    enforceReviewRunAccess.mockResolvedValue({ ok: false });
    const notYours = await POST(post({}));
    expect(withoutCapability.status).toBe(notYours.status);
    expect(await withoutCapability.json()).toEqual(await notYours.json());
  });
});

describe("AC-3 — the capability misuse matrix, all refused pre-disclosure", () => {
  it("EXPIRED", async () => {
    const stale = mintActionCapability(BASE, {
      nowSeconds: Math.floor(Date.now() / 1000) - 3600,
    }) as string;
    const res = await POST(post({ capability: stale }));
    await expect(res.json()).resolves.toMatchObject({ outcome: { kind: "not-permitted" } });
    expectPreDisclosure();
  });

  it("WRONG AUDIENCE — a capability minted for another endpoint", async () => {
    // Minting at another audience is refused outright, so the only way to hold
    // one is to have it sealed elsewhere; either way this endpoint never opens it.
    expect(
      mintActionCapability({ ...BASE, audience: "/api/lifecycle-views/decide" }),
    ).toBeNull();
    const res = await POST(post({ capability: "not-one-of-ours" }));
    await expect(res.json()).resolves.toMatchObject({ outcome: { kind: "not-permitted" } });
    expectPreDisclosure();
  });

  it("WRONG PRINCIPAL — sealed for another person in the same org", async () => {
    const res = await POST(post({ capability: seal({ userId: "user-2" }) }));
    await expect(res.json()).resolves.toMatchObject({ outcome: { kind: "not-permitted" } });
    expect(consumeActionCapability).not.toHaveBeenCalled();
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });

  it("WRONG SITE / CLIENT / INSTANCE / AGENT / ORG / SESSION — every binding axis", async () => {
    const axes: Array<Partial<ActionCapabilityPayload>> = [
      { siteId: "site-2" },
      { client: "drupal" },
      { instanceId: "inst-2" },
      { agentSlug: "drupal-content-editor" },
      { orgId: "org-2" },
      { jti: "wjti-2" },
    ];
    for (const axis of axes) {
      vi.clearAllMocks();
      resolveWidgetLifecycleActorContext.mockResolvedValue({
        ok: true,
        actorCtx: ACTOR,
        claims: CLAIMS,
      });
      consumeActionCapability.mockImplementation(async (capabilityId: string) =>
        rowFor({ ...storedRow, capabilityId }),
      );
      const res = await POST(post({ capability: seal(axis) }));
      await expect(res.json(), JSON.stringify(axis)).resolves.toMatchObject({
        outcome: { kind: "not-permitted" },
      });
      expect(consumeActionCapability, JSON.stringify(axis)).not.toHaveBeenCalled();
      expect(submitReviewDecisionAction, JSON.stringify(axis)).not.toHaveBeenCalled();
    }
  });

  it("REPLAYED — the burn is what refuses, and it refuses before the decision", async () => {
    consumeActionCapability.mockResolvedValueOnce(null);
    const res = await POST(post({}));
    await expect(res.json()).resolves.toMatchObject({ outcome: { kind: "not-permitted" } });
    expect(consumeActionCapability).toHaveBeenCalledTimes(1);
    expect(enforceReviewRunAccess).not.toHaveBeenCalled();
    expect(readReviewGatePinnedTargets).not.toHaveBeenCalled();
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });

  it("WRONG GATE — a capability cannot be pointed at a gate other than its own", async () => {
    // The strongest form of this property is structural rather than a refusal:
    // the request body has NO field through which a gate could be named, so a
    // capability sealed for gate-2 can only ever decide gate-2. There is
    // nothing for a caller to substitute, which is why the "wrong gate"
    // refusals below are about a gate that MOVED, not one that was swapped.
    const res = await POST(post({ capability: seal({ reviewTaskId: "gate-2" }) }));
    expect(res.status).toBe(200);
    expect(submitReviewDecisionAction).toHaveBeenCalledWith(
      "run-1",
      "gate-2",
      "approve",
      null,
      ACTOR,
      null,
    );
  });

  it("WRONG GATE — a capability whose gate no longer has a pinned set", async () => {
    readReviewGatePinnedTargets.mockResolvedValue(null);
    const res = await POST(post({}));
    await expect(res.json()).resolves.toMatchObject({ outcome: { kind: "not-permitted" } });
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });

  it("A SUBSTITUTED BODY — the presented decision must digest to the confirmed one", async () => {
    const res = await POST(post({ body: { assistant: "wordpress", comment: "changed" } }));
    await expect(res.json()).resolves.toMatchObject({ outcome: { kind: "not-permitted" } });
    expectPreDisclosure();
  });

  it("A SUGGESTION PARTITION is refused at the SCHEMA — the widget path carries none", async () => {
    // codex round 0, finding 1. A confirmation is worth only what its window can
    // show, and this window cannot render suggestion labels. So the field is not
    // "validated" here, it does not EXIST here: `.strict()` makes sending one a
    // 400, which is a refusal a caller cannot mistake for a dropped field.
    const res = await POST(
      post({
        body: {
          assistant: "wordpress",
          comment: null,
          suggestionDecisions: { accepted: ["s1"], dismissed: [] },
        },
      }),
    );
    expect(res.status).toBe(400);
    expectPreDisclosure();
  });

  it("A RE-PINNED GATE — the representation revisions must still be the confirmed ones", async () => {
    readReviewGatePinnedTargets.mockResolvedValue([
      { artifactId: "art-1", representationRevisionId: "rev-2" },
    ]);
    const res = await POST(post({}));
    await expect(res.json()).resolves.toMatchObject({ outcome: { kind: "not-permitted" } });
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });

  it("NO RUN READ — refused with the SAME answer, and the gate is never read", async () => {
    enforceReviewRunAccess.mockResolvedValue({ ok: false });
    const res = await POST(post({}));
    await expect(res.json()).resolves.toMatchObject({ outcome: { kind: "not-permitted" } });
    expect(readReviewGatePinnedTargets).not.toHaveBeenCalled();
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });
});

describe("the credential rungs", () => {
  it("a rejected `cwu_` is a 401 carrying the re-login marker, not a decision outcome", async () => {
    resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "token_rejected" });
    const res = await POST(post({}));
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Cinatra-Widget-Auth")).toBe("required");
    expect(consumeActionCapability).not.toHaveBeenCalled();
  });

  it("an unknown assistant handle cannot reach the token verifier at all", async () => {
    const res = await POST(post({ body: { assistant: "cinatra", comment: null } }));
    expect(res.status).toBe(401);
    expect(resolveWidgetLifecycleActorContext).not.toHaveBeenCalled();
  });

  it("consumes the bearer under the DECIDE grant — its own audience, BOTH scopes", async () => {
    await POST(post({}));
    expect(resolveWidgetLifecycleActorContext).toHaveBeenCalledWith(
      expect.objectContaining({ grant: WIDGET_LIFECYCLE_DECIDE_GRANT }),
    );
    expect(WIDGET_LIFECYCLE_DECIDE_GRANT.routePath).toBe(ACTION_CAPABILITY_DECIDE_ROUTE_PATH);
    expect([...WIDGET_LIFECYCLE_DECIDE_GRANT.requiredScopes].sort()).toEqual([
      "lifecycle.decide",
      "lifecycle.read",
    ]);
  });

  it("a malformed body is a 400 and nothing else — it depends on no gate", async () => {
    const res = await POST(post({ body: { assistant: "wordpress", ref: "sneaky" } }));
    expect(res.status).toBe(400);
    expectPreDisclosure();
  });
});

describe("AC-1 — it reaches the ONE decision module, unchanged", () => {
  it("passes the SEALED run, gate and act, the ONE actor context, and no partition", async () => {
    const digest = decisionPayloadDigest({ disposition: "approve", comment: "looks right" });
    const res = await POST(
      post({
        capability: seal({ decisionDigest: digest }),
        body: { assistant: "wordpress", comment: "looks right" },
      }),
    );
    expect(res.status).toBe(200);
    expect(submitReviewDecisionAction).toHaveBeenCalledWith(
      "run-1",
      "gate-1",
      "approve",
      "looks right",
      ACTOR,
      // Explicitly null, not omitted: the absence is a decision, not a
      // forgotten argument, and the ONE helper must see it as "none".
      null,
    );
  });

  it("the run-access pre-check uses the SAME actor context the decision op will", async () => {
    await POST(post({}));
    expect(enforceReviewRunAccess).toHaveBeenCalledWith(
      "run-1",
      ACTOR.actor,
      "read",
      ACTOR.roleHints,
    );
  });

  it("burns the capability BEFORE the decision runs", async () => {
    const order: string[] = [];
    consumeActionCapability.mockImplementation(async (capabilityId: string) => {
      order.push("burn");
      return rowFor({ ...storedRow, capabilityId });
    });
    submitReviewDecisionAction.mockImplementation(async () => {
      order.push("decide");
      return { kind: "decided", disposition: "approve", idempotent: false };
    });
    await POST(post({}));
    expect(order).toEqual(["burn", "decide"]);
  });

  it("returns the decision core's outcome VERBATIM — including a conflict", async () => {
    submitReviewDecisionAction.mockResolvedValue({ kind: "blocked", reason: "conflict" });
    const res = await POST(post({}));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: { kind: "blocked", reason: "conflict" } });
  });

  it("returns an IDEMPOTENT success verbatim — a settled gate is the core's answer, not this route's", async () => {
    submitReviewDecisionAction.mockResolvedValue({
      kind: "decided",
      disposition: "approve",
      idempotent: true,
    });
    const res = await POST(post({}));
    await expect(res.json()).resolves.toEqual({
      outcome: { kind: "decided", disposition: "approve", idempotent: true },
    });
  });

  it("never caches an answer", async () => {
    const res = await POST(post({}));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

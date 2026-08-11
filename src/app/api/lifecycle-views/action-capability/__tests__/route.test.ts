// The ASK half of the widget decision path (cinatra#2575, epic #2564 S8b).
//
// This endpoint authorizes nothing, so the suite is not about what it permits —
// it is about what it DISCLOSES and what it WRITES DOWN.
//
//   • it holds the same bar as a lifecycle READ (run access before the gate is
//     touched) plus the DECIDE grant, and answers every denial identically;
//   • the binding it records comes from SERVER state only: the principal and
//     site from the just-validated token, the gate from the server-minted ref,
//     the representation revisions from the live gate. Nothing a caller sends
//     can retarget it;
//   • what it returns is a PATH, not a credential.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-action-capability-route";

const resolveWidgetLifecycleActorContext = vi.fn();
const requestActionCapability = vi.fn();
const enforceReviewRunAccess = vi.fn();
const readReviewGatePinnedTargets = vi.fn();
const readArtifactForDetail = vi.fn();

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: (...args: unknown[]) => enforceReviewRunAccess(...args),
}));

vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  readReviewGatePinnedTargets: (...args: unknown[]) => readReviewGatePinnedTargets(...args),
}));

vi.mock("@/lib/lifecycle/widget-action-capability-store", () => ({
  requestActionCapability: (...args: unknown[]) => requestActionCapability(...args),
}));

vi.mock("@/lib/artifacts/artifact-service", () => ({
  readArtifactForDetail: (...args: unknown[]) => readArtifactForDetail(...args),
}));

vi.mock("@/lib/lifecycle/widget-lifecycle-actor", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveWidgetLifecycleActorContext: (...args: unknown[]) =>
      resolveWidgetLifecycleActorContext(...args),
  };
});

import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import {
  ACTION_CAPABILITY_DECIDE_ROUTE_PATH,
  ACTION_CAPABILITY_PURPOSE_DECIDE,
  decisionPayloadDigest,
  pinnedTargetsDigest,
  WIDGET_COMMENT_MAX_CHARS,
} from "@/lib/lifecycle/widget-action-capability";
import { WIDGET_LIFECYCLE_DECIDE_REQUEST_GRANT } from "@/lib/lifecycle/widget-lifecycle-actor";

import { POST } from "../route";

const TARGETS = [{ artifactId: "art-1", representationRevisionId: "rev-1" }];
const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "gate-1" })!;

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

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://app.example/api/lifecycle-views/action-capability", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cinatra-Widget-User-Token": "cwu_live",
      "X-Cinatra-Widget-Origin": "https://shop.example",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const VALID = { assistant: "wordpress", ref: REF, disposition: "approve", comment: null };

beforeEach(() => {
  vi.clearAllMocks();
  resolveWidgetLifecycleActorContext.mockResolvedValue({
    ok: true,
    actorCtx: ACTOR,
    claims: CLAIMS,
  });
  enforceReviewRunAccess.mockResolvedValue({ ok: true });
  readReviewGatePinnedTargets.mockResolvedValue(TARGETS);
  requestActionCapability.mockResolvedValue("cap-uuid-1");
  readArtifactForDetail.mockReturnValue({
    kind: "ok",
    artifact: { title: "Autumn sale", objectType: "@cinatra-ai/blog:post" },
  });
});

describe("what it records", () => {
  it("binds the principal and site from the TOKEN, and the gate from the REF", async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(requestActionCapability).toHaveBeenCalledWith({
      purpose: ACTION_CAPABILITY_PURPOSE_DECIDE,
      audience: ACTION_CAPABILITY_DECIDE_ROUTE_PATH,
      orgId: "org-1",
      userId: "user-1",
      widgetJti: "wjti-1",
      siteId: "site-1",
      client: "wordpress",
      instanceId: "inst-1",
      agentSlug: "wordpress-content-editor",
      runId: "run-1",
      reviewTaskId: "gate-1",
      disposition: "approve",
      targetsDigest: pinnedTargetsDigest(TARGETS),
      decisionDigest: decisionPayloadDigest({ disposition: "approve", comment: null }),
      subjectLabel: "Autumn sale (Blog)",
      commentText: null,
    });
  });

  it("records the WHOLE rationale — the window shows all of it, so the row holds all of it", async () => {
    // codex round 1, finding 1. An excerpt would let a benign opening hide a
    // consequential ending behind the click that confirms it.
    const long = "x".repeat(WIDGET_COMMENT_MAX_CHARS);
    await POST(post({ ...VALID, disposition: "comment", comment: long }));
    const recorded = requestActionCapability.mock.calls[0][0] as {
      decisionDigest: string;
      commentText: string;
    };
    expect(recorded.commentText).toBe(long);
    expect(recorded.decisionDigest).toBe(
      decisionPayloadDigest({ disposition: "comment", comment: long }),
    );
  });

  it("REFUSES a rationale longer than a window can honestly show", async () => {
    const res = await POST(
      post({ ...VALID, disposition: "comment", comment: "x".repeat(WIDGET_COMMENT_MAX_CHARS + 1) }),
    );
    expect(res.status).toBe(400);
    expect(requestActionCapability).not.toHaveBeenCalled();
  });

  it("REFUSES a suggestion partition outright — the window cannot show one", async () => {
    // codex round 0, finding 1. `.strict()` turns it into a 400 rather than a
    // silently dropped field, so a caller cannot believe per-item choices were
    // recorded when nothing was confirmed about them.
    const res = await POST(
      post({ ...VALID, suggestionDecisions: { accepted: ["s1"], dismissed: [] } }),
    );
    expect(res.status).toBe(400);
    expect(requestActionCapability).not.toHaveBeenCalled();
  });

  it("names WHAT is under review, from an authorized read of the pinned artifacts", async () => {
    await POST(post(VALID));
    const recorded = requestActionCapability.mock.calls[0][0] as { subjectLabel: string };
    // Title AND type: two decoys are easier to tell apart by kind than by two
    // titles somebody chose to make look alike (codex round 1, finding 2).
    expect(recorded.subjectLabel).toBe("Autumn sale (Blog)");
  });

  it("falls back to the TYPE when the artifact cannot be named, never to nothing", async () => {
    readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { title: null, objectType: "@cinatra-ai/blog:post" },
    });
    await POST(post(VALID));
    const recorded = requestActionCapability.mock.calls[0][0] as { subjectLabel: string };
    expect(recorded.subjectLabel).toBe("Blog");
  });

  it("an artifact this reader may not read contributes no title", async () => {
    readArtifactForDetail.mockReturnValue({ kind: "denied" });
    await POST(post(VALID));
    const recorded = requestActionCapability.mock.calls[0][0] as { subjectLabel: string };
    expect(recorded.subjectLabel).toBe("An item");
  });

  it("counts the rest rather than listing a whole gate", async () => {
    readReviewGatePinnedTargets.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        artifactId: `art-${i}`,
        representationRevisionId: `rev-${i}`,
      })),
    );
    await POST(post(VALID));
    const recorded = requestActionCapability.mock.calls[0][0] as { subjectLabel: string };
    // The COUNT is stated outright, so a gate of one and a gate of six never
    // read alike however similar their titles are.
    expect(recorded.subjectLabel).toBe(
      "6 items: Autumn sale (Blog), Autumn sale (Blog), Autumn sale (Blog) and 3 more",
    );
  });

  it("returns a PATH to the confirmation window, not a credential", async () => {
    const res = await POST(post(VALID));
    const body = (await res.json()) as { confirmPath: string; outcome: { kind: string } };
    expect(body.outcome.kind).toBe("confirmation-required");
    expect(body.confirmPath).toBe("/widget-decision?t=cap-uuid-1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("what it discloses", () => {
  it("consumes the bearer under the DECIDE-REQUEST grant — its own audience, BOTH scopes", async () => {
    await POST(post(VALID));
    expect(resolveWidgetLifecycleActorContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSlug: "wordpress-content-editor",
        requestOrigin: "https://shop.example",
        grant: WIDGET_LIFECYCLE_DECIDE_REQUEST_GRANT,
      }),
    );
    expect([...WIDGET_LIFECYCLE_DECIDE_REQUEST_GRANT.requiredScopes].sort()).toEqual([
      "lifecycle.decide",
      "lifecycle.read",
    ]);
  });

  it("checks run READ BEFORE it touches the gate", async () => {
    enforceReviewRunAccess.mockResolvedValue({ ok: false });
    const res = await POST(post(VALID));
    await expect(res.json()).resolves.toMatchObject({ outcome: { kind: "not-permitted" } });
    expect(readReviewGatePinnedTargets).not.toHaveBeenCalled();
    expect(requestActionCapability).not.toHaveBeenCalled();
  });

  it("answers an undecodable ref, an unreadable run and an absent gate IDENTICALLY", async () => {
    const badRef = await POST(post({ ...VALID, ref: "not-a-ref" }));
    enforceReviewRunAccess.mockResolvedValue({ ok: false });
    const noAccess = await POST(post(VALID));
    enforceReviewRunAccess.mockResolvedValue({ ok: true });
    readReviewGatePinnedTargets.mockResolvedValue(null);
    const noGate = await POST(post(VALID));

    expect(badRef.status).toBe(noAccess.status);
    expect(noAccess.status).toBe(noGate.status);
    const bodies = await Promise.all([badRef.json(), noAccess.json(), noGate.json()]);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
  });

  it("a rejected `cwu_` is a 401 with the re-login marker and reaches no gate", async () => {
    resolveWidgetLifecycleActorContext.mockResolvedValue({ ok: false, reason: "token_rejected" });
    const res = await POST(post(VALID));
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Cinatra-Widget-Auth")).toBe("required");
    expect(enforceReviewRunAccess).not.toHaveBeenCalled();
  });

  it("an unknown assistant handle never reaches the verifier", async () => {
    const res = await POST(post({ ...VALID, assistant: "cinatra" }));
    expect(res.status).toBe(401);
    expect(resolveWidgetLifecycleActorContext).not.toHaveBeenCalled();
  });

  it("a missing bearer is a 401, not a gate probe", async () => {
    const req = new Request("https://app.example/api/lifecycle-views/action-capability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(resolveWidgetLifecycleActorContext).not.toHaveBeenCalled();
  });

  it("a malformed body is a 400 and depends on no gate", async () => {
    for (const body of [
      { assistant: "wordpress", ref: REF },
      { assistant: "wordpress", ref: REF, disposition: "escalate" },
      { assistant: "wordpress", ref: REF, disposition: "approve", extra: true },
      {
        assistant: "wordpress",
        ref: REF,
        disposition: "approve",
        suggestionDecisions: { accepted: [], dismissed: [] },
      },
    ]) {
      const res = await POST(post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(enforceReviewRunAccess).not.toHaveBeenCalled();
  });

  it("a store that refuses the row answers like every other refusal", async () => {
    requestActionCapability.mockResolvedValue(null);
    const res = await POST(post(VALID));
    await expect(res.json()).resolves.toMatchObject({ outcome: { kind: "not-permitted" } });
  });
});

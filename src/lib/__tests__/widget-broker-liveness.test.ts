import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// cinatra#2575 (epic #2564 S8b) — NO STANDALONE-TOKEN TRUST on the broker
// stream resume.
//
// The resume token is a ten-minute HMAC. Before this slice, holding one was the
// whole authorization: a person signed out mid-run, a site suspended by its
// owner, a connection revoked or re-keyed, and a membership removed all left the
// stream running until the signature aged out. These are the four withdrawals,
// each proven to stop the next reconnect, plus the rule that makes them
// meaningful — a token whose claims disagree with its own live session is
// refused rather than reconciled.
// ---------------------------------------------------------------------------

const readLiveWidgetCapturePrincipal = vi.fn();
const resolveActorGrantsForUserInOrg = vi.fn();

vi.mock("@/lib/lifecycle/widget-capture-principal", () => ({
  readLiveWidgetCapturePrincipal: (...args: unknown[]) =>
    readLiveWidgetCapturePrincipal(...args),
}));

vi.mock("@/lib/auth-session", () => ({
  resolveActorGrantsForUserInOrg: (...args: unknown[]) =>
    resolveActorGrantsForUserInOrg(...args),
}));

import { isWidgetBrokerSessionLive } from "@/lib/widget-broker-liveness";

const CLAIM = {
  widgetJti: "wjti-1",
  siteId: "site-1",
  userId: "user-1",
  orgId: "org-1",
  instanceId: "inst-1",
};

const LIVE = {
  userId: "user-1",
  orgId: "org-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "inst-1",
  agentSlug: "wordpress-content-editor",
  siteOrigin: "https://shop.example",
};

beforeEach(() => {
  vi.clearAllMocks();
  readLiveWidgetCapturePrincipal.mockReturnValue(LIVE);
  resolveActorGrantsForUserInOrg.mockResolvedValue({ orgRole: "member" });
});

describe("a live widget session resumes", () => {
  it("passes when the session, the site and the membership all still hold", async () => {
    await expect(isWidgetBrokerSessionLive(CLAIM)).resolves.toBe(true);
    expect(readLiveWidgetCapturePrincipal).toHaveBeenCalledWith("wjti-1");
    expect(resolveActorGrantsForUserInOrg).toHaveBeenCalledWith("user-1", "org-1");
  });
});

describe("the four withdrawals stop the next reconnect", () => {
  it("SIGN-OUT / token sweep — the session row is gone", async () => {
    readLiveWidgetCapturePrincipal.mockReturnValue(null);
    await expect(isWidgetBrokerSessionLive(CLAIM)).resolves.toBe(false);
    // The membership is never even asked: the session is the first rung.
    expect(resolveActorGrantsForUserInOrg).not.toHaveBeenCalled();
  });

  it("SITE SUSPENSION / revocation / credential rotation — the probe refuses", async () => {
    // All three are the same answer from the jti-keyed probe, which re-checks
    // the live connect site's org, origin, client and credential GENERATION.
    readLiveWidgetCapturePrincipal.mockReturnValue(null);
    await expect(isWidgetBrokerSessionLive(CLAIM)).resolves.toBe(false);
  });

  it("MEMBERSHIP REMOVAL — the token row survives it, so this is the rung that catches it", async () => {
    resolveActorGrantsForUserInOrg.mockResolvedValue({});
    await expect(isWidgetBrokerSessionLive(CLAIM)).resolves.toBe(false);
  });
});

describe("disagreement refuses rather than reconciles", () => {
  it.each([
    ["person", { userId: "user-2" }],
    ["org", { orgId: "org-2" }],
    ["site", { siteId: "site-2" }],
    ["canonical instance", { instanceId: "inst-2" }],
  ])("a token claiming a different %s is refused", async (_label, drift) => {
    readLiveWidgetCapturePrincipal.mockReturnValue({ ...LIVE, ...drift });
    await expect(isWidgetBrokerSessionLive(CLAIM)).resolves.toBe(false);
    expect(resolveActorGrantsForUserInOrg).not.toHaveBeenCalled();
  });

  it("a claim missing any axis is refused before any store is touched", async () => {
    for (const axis of ["widgetJti", "siteId", "userId", "orgId", "instanceId"] as const) {
      vi.clearAllMocks();
      await expect(
        isWidgetBrokerSessionLive({ ...CLAIM, [axis]: "" }),
        axis,
      ).resolves.toBe(false);
      expect(readLiveWidgetCapturePrincipal, axis).not.toHaveBeenCalled();
    }
  });
});

describe("it never throws", () => {
  it("a store failure is a refusal, not a distinguishable error", async () => {
    readLiveWidgetCapturePrincipal.mockImplementation(() => {
      throw new Error("pg down");
    });
    await expect(isWidgetBrokerSessionLive(CLAIM)).resolves.toBe(false);

    readLiveWidgetCapturePrincipal.mockReturnValue(LIVE);
    resolveActorGrantsForUserInOrg.mockRejectedValue(new Error("pg down"));
    await expect(isWidgetBrokerSessionLive(CLAIM)).resolves.toBe(false);
  });
});

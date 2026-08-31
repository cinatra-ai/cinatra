// @vitest-environment jsdom
//
// THE SECOND PERSON (cinatra#2934, the FIFTH graded proof set).
//
// A plain member of the run's OWN organization opened the schedule address of a
// run that was not theirs and got a flat not-found page — while the trail above
// it still named the run and the tab. Two sentences, and they contradict each
// other: one says the page is not there, the other says it is. The drawing
// allows neither. It says: "A viewer with no access to the run at all never
// reaches the surface: it opens to the standard not-authorized panel, never to
// the target." The page exists; this person may not act on it; that is what the
// page must say, with no live control, no placement, no confirmation of
// anything, and nothing of the run's own content on it.
//
// THE THREE PERSON CLASSES ARE NOT ONE ANSWER, and this file is where that is
// measured rather than asserted. The authorization layer already tells them
// apart, and it does so deliberately:
//
//   OWNER              — allowed. The surface draws.
//   ORGANIZATION MEMBER of the run's own organization — the kernel grants the
//                        member `run.read`, so existence is NOT hidden from
//                        them; the run's OWN configured policy is what refuses,
//                        and it refuses with 403 / forbidden. This is exactly
//                        "the page exists, you may not act on it", and it is
//                        the person the fifth graded proof set found staring at a 404.
//   OUTSIDER           — outside the run's organization the kernel denies the
//                        READ, and a denied read is deliberately downgraded to
//                        404 / hidden so that nobody can discover which run ids
//                        exist by telling 403 apart from 404. That existence
//                        hiding is a real defence and this fix does not weaken
//                        it: the outsider still gets the flat not-found, and
//                        SHOULD.
//
// So the fix is not "never answer not-found". It is: answer with the reason the
// authorization layer actually gave. `runScreenAccessAnswer` is that mapping,
// and the halves below pin both the layer's verdict per person class and the
// screen's answer to it.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { AuthzError } from "@/lib/authz";

import { enforceRunAccess } from "../auth-policy";
import type { ActorRoleHints, AgentAuthPolicy } from "../auth-policy";
import { runScreenAccessAnswer } from "../instance-screens";
import { RunNotAuthorizedPanel } from "../run-not-authorized-panel";

const RUN = { id: "run-1", runBy: "user-owner", orgId: "org-A" };

/** The run's own configured policy: only the owner may read its data. This is
 *  the default tier and the one the second person met. */
const OWNER_ONLY: AgentAuthPolicy = {
  runListVisibility: ["owner"],
  runDataVisibility: ["owner"],
  runExecuteVisibility: ["owner"],
  allowRunSharing: false,
};

type Hints = ActorRoleHints & { actorOrganizationId?: string | null };

async function readAs(
  userId: string,
  roles: Hints,
): Promise<{ ok: true } | { ok: false; statusCode: number; reason: string }> {
  try {
    await enforceRunAccess(
      { ...RUN, effectivePolicy: OWNER_ONLY },
      { actorType: "human", source: "ui", userId },
      "read",
      roles,
    );
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthzError) {
      return { ok: false, statusCode: err.statusCode, reason: String(err.reason) };
    }
    throw err;
  }
}

const ORG_MEMBER: Hints = { platformRole: "member", orgRole: "member", actorOrganizationId: "org-A" };
const OUTSIDER: Hints = { platformRole: "member", orgRole: "member", actorOrganizationId: "org-B" };

describe("the person classes, measured against the authorization layer itself", () => {
  it("the OWNER may read their own run", async () => {
    expect(await readAs("user-owner", ORG_MEMBER)).toEqual({ ok: true });
  });

  it("a plain ORGANIZATION MEMBER is refused with the run's existence intact", async () => {
    const verdict = await readAs("user-colleague", ORG_MEMBER);
    expect(verdict).toEqual({ ok: false, statusCode: 403, reason: "forbidden" });
  });

  it("an OUTSIDER is refused with the run's existence hidden — and that stays", async () => {
    const verdict = await readAs("user-stranger", OUTSIDER);
    expect(verdict).toEqual({ ok: false, statusCode: 404, reason: "hidden" });
  });
});

describe("the screen answers with the reason it was given, not with one answer for all three", () => {
  it("a refusal that KEPT the run's existence opens the standard not-authorized panel", async () => {
    const verdict = await readAs("user-colleague", ORG_MEMBER);
    expect(verdict.ok).toBe(false);
    expect(
      runScreenAccessAnswer(
        new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
      ),
    ).toBe("not-authorized");
  });

  it("a refusal that HID the run's existence still opens the flat not-found", async () => {
    expect(
      runScreenAccessAnswer(
        new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." }),
      ),
    ).toBe("not-found");
  });

  it("anything that is not an authorization refusal is not swallowed", () => {
    expect(runScreenAccessAnswer(new Error("the database fell over"))).toBe("rethrow");
  });
});

describe("the panel itself leaks nothing of the run it refuses", () => {
  it("carries the reason, no control, no placement and no confirmation", () => {
    const { container } = render(
      <RunNotAuthorizedPanel surface="Schedule" conformanceId="run-not-authorized" />,
    );
    const panel = container.querySelector('[data-conformance-id="run-not-authorized"]');
    expect(panel).not.toBeNull();
    // THE TRUE REASON, in the drawing's own terms: the page is there and this
    // person may not act on it.
    expect(panel!.textContent).toContain("You don't have access to this run");
    expect(panel!.textContent).not.toContain("not found");
    expect(panel!.textContent).not.toContain("does not exist");
    // NO LIVE CONTROL, NO PLACEMENT, NO FALSE CONFIRMATION.
    expect(container.querySelectorAll("button, input, select, textarea").length).toBe(0);
    for (const word of ["Confirm", "Save changes", "Cancel schedule", "Continue", "Regenerate"]) {
      expect(container.textContent).not.toContain(word);
    }
    // AND NOTHING OF THE RUN — no identifier, no title, no exchange.
    for (const leak of ["run-1", "user-owner", "org-A"]) {
      expect(container.textContent).not.toContain(leak);
    }
  });
});

// The canonical scoped-agent dispatch form must STREAM (cinatra#2820).
//
// DEFECT. A message whose only mention token is a scoped agent reference —
// `use @cinatra-ai/<slug> to do X`, the form the `chat-assistant-core` skill
// documents as canonical — never reached an assistant request. `classifyMentions`
// correctly classifies the token as `agent-dispatch` (a registry MISS is exactly
// what makes a scoped ref eligible for `agent_run`), but `decideMessageRouting`
// then fell into the "carried @-tokens, none resolved to an assistant" branch and
// returned the HONEST NO-RESPONDER plan. `resolveDispatchPlan` turned that into
// `{ kind: "none" }`, so the client POSTed nothing — and the deterministic
// explicit-dispatch pre-router (`src/app/api/chat/explicit-dispatch.ts`), which
// exists to force `agent_run` for exactly this wording, is server-side and so
// never ran. The documented form was dead on arrival.
//
// RULING IMPLEMENTED (see the PR body). The documented canonical form is the
// contract; the router defect is the bug. An `agent-dispatch` classification is
// therefore a REQUEST FOR THE HOST, not a no-responder: the host Cinatra reply
// streams, the pre-router sees the message, and the run plays out on the inline
// card. The classifier is untouched — the fix does NOT re-teach the broadcast
// classifier about agents.
//
// The three guards that must survive the change are pinned below: the two-token
// form, a NON-agent unresolved mention (the classifier's legitimate no-responder),
// and the legacy `cinatra_<slug>` underscore form.

import { describe, expect, it } from "vitest";
import { decideMessageRouting } from "../route-decision";
import { classifyMentions, type AudienceScopedAssistantResolver } from "../classify-mentions";
import { resolveDispatchPlan, shouldEnterSlackModeOnSend, countMentions } from "../chat-routing";
import type { AssistantDeliveryLookup } from "../dispatch-planner";

const CINATRA_HOST_ID = "cin-host";
/** The builtin's CANONICAL handle — the bare `cinatra` is only a reserved alias. */
const CINATRA_CANONICAL = "cinatra-2";

/** The audience-scoped registry as the real reader presents it: the host is the
 *  only installed assistant, so `@cinatra-ai/contact-discovery-agent` MISSES
 *  `byPackageRef` and classifies `agent-dispatch` (an agent template is never
 *  published as an assistant — AC#7 of #1873). */
const HOST_ONLY_REGISTRY: AudienceScopedAssistantResolver = {
  async byPackageRef(packageRef) {
    return packageRef === "@cinatra-ai/cinatra-assistant"
      ? { assistantUserId: CINATRA_HOST_ID, handle: CINATRA_CANONICAL, packageName: packageRef }
      : null;
  },
  async byHandle(handle) {
    return handle === "cinatra" || handle === CINATRA_CANONICAL
      ? {
          assistantUserId: CINATRA_HOST_ID,
          handle: CINATRA_CANONICAL,
          packageName: "@cinatra-ai/cinatra-assistant",
        }
      : null;
  },
};

const NO_DELIVERY: AssistantDeliveryLookup = () => undefined;

/** Lex → classify → decide, the whole client route decision for one message. */
async function route(content: string) {
  const classified = await classifyMentions(content, HOST_ONLY_REGISTRY);
  return decideMessageRouting({
    classified,
    deliveryFor: NO_DELIVERY,
    cinatraHostId: CINATRA_HOST_ID,
  });
}

const AGENT_ONLY = "use @cinatra-ai/contact-discovery-agent to find leads at Acme";

describe("cinatra#2820 — the canonical scoped-agent-only form streams", () => {
  it("REPRO — a scoped-agent-only message reaches the host stream, not the no-call plan", async () => {
    const r = await route(AGENT_ONLY);

    // The host Cinatra reply, attributed to the host principal — the SAME shape as
    // the no-mention default. Not a broadcast: nothing was tagged.
    expect(r.shouldCallLlm).toBe(true);
    expect(r.hostAssistantUserId).toBe(CINATRA_HOST_ID);
    expect(r.isBroadcast).toBeUndefined();
    expect(r.externalMentions).toBeUndefined();
    expect(r.hostRuntimeMention).toBeUndefined();
    // No declared host-runtime assistant → the default assistants endpoint.
    expect(r.chatEndpoint).toBeUndefined();

    // …and that is the plan the client acts on: an actual POST, so the server-side
    // explicit-dispatch pre-router finally sees the message.
    expect(resolveDispatchPlan(r, undefined)).toEqual({
      kind: "stream",
      endpoint: "/api/assistants/chat",
      authorUserId: CINATRA_HOST_ID,
    });
  });

  it("REPRO — the classifier is unchanged: the token is still an agent-dispatch candidate", async () => {
    const classified = await classifyMentions(AGENT_ONLY, HOST_ONLY_REGISTRY);
    expect(classified).toHaveLength(1);
    expect(classified[0].kind).toBe("agent-dispatch");
  });

  it("the ONE token keeps the thread in DEFAULT layout, so the inline run card renders", () => {
    // Slack mode suppresses message parts and with them the inline run card. One
    // mention token and no tagged participant → default layout. This is why the
    // fix goes in the router and not in the also-address-the-assistant workaround.
    expect(countMentions(AGENT_ONLY)).toBe(1);
    expect(
      shouldEnterSlackModeOnSend({
        isSlackMode: false,
        taggedAssistantCount: 0,
        mentionCount: countMentions(AGENT_ONLY),
      }),
    ).toBe(false);
  });

  it("an agent ref alongside an unresolved human tag still streams", async () => {
    const r = await route("@alice use @cinatra-ai/contact-discovery-agent on this");
    expect(r.shouldCallLlm).toBe(true);
    expect(r.hostAssistantUserId).toBe(CINATRA_HOST_ID);
  });

  it("no seeded host principal → still streams, just without host attribution", async () => {
    const classified = await classifyMentions(AGENT_ONLY, HOST_ONLY_REGISTRY);
    const r = decideMessageRouting({
      classified,
      deliveryFor: NO_DELIVERY,
      cinatraHostId: null,
    });
    expect(r).toEqual({ shouldCallLlm: true });
  });
});

describe("cinatra#2820 — the guards that must survive the router change", () => {
  it("GUARD — the two-token workaround form is unchanged (still streams)", async () => {
    const r = await route("@cinatra use @cinatra-ai/contact-discovery-agent to find leads");
    expect(r.shouldCallLlm).toBe(true);
    expect(r.activeHandle).toBe("cinatra");
    expect(r.hostAssistantUserId).toBe(CINATRA_HOST_ID);
    expect(r.hostRuntimeMention).toBeUndefined();
    // And it still flips the thread into Slack layout — untouched by this fix
    // (the parts suppression in that mode is its own concern, per the issue).
    expect(
      shouldEnterSlackModeOnSend({
        isSlackMode: false,
        taggedAssistantCount: 0,
        mentionCount: 2,
      }),
    ).toBe(true);
  });

  it("GUARD — a NON-agent mention with no tagged participant is STILL the no-call plan", async () => {
    // The classifier's legitimate no-responder case: a flat handle that resolves
    // to nothing (a human tag, or a delisted `@chatgpt`). It must not start
    // streaming just because the agent-dispatch case now does.
    const r = await route("@chatgpt what do you think?");
    expect(r).toEqual({ shouldCallLlm: false, isBroadcast: true });
    expect(resolveDispatchPlan(r, undefined)).toEqual({ kind: "none" });
  });

  it("GUARD — a human tag with no tagged participant is STILL the no-call plan", async () => {
    const r = await route("@alice can you take a look?");
    expect(r).toEqual({ shouldCallLlm: false, isBroadcast: true });
  });

  it("GUARD — the legacy underscore slug form still streams (no mention token at all)", async () => {
    const r = await route("use cinatra_contact_discovery_agent to find leads at Acme");
    expect(r).toEqual({ shouldCallLlm: true, hostAssistantUserId: CINATRA_HOST_ID });
    expect(resolveDispatchPlan(r, undefined)).toEqual({
      kind: "stream",
      endpoint: "/api/assistants/chat",
      authorUserId: CINATRA_HOST_ID,
    });
  });

  it("GUARD — a declared NON-HOST assistant still wins over a co-mentioned agent ref", async () => {
    // Branch precedence: the assistants branch runs BEFORE the new agent-dispatch
    // branch, so a webhook assistant co-mentioned with an agent ref still persists
    // pending (no host stream). Pins the ordering, not just the @cinatra case.
    const r = decideMessageRouting({
      classified: [
        {
          kind: "assistant",
          token: {
            raw: "@slackbot",
            kind: "flat",
            handle: "slackbot",
            offset: 0,
            length: 9,
          },
          assistantUserId: "sb-1",
          handle: "slackbot",
          packageName: "@acme/slackbot-assistant",
        },
        ...(await classifyMentions(AGENT_ONLY, HOST_ONLY_REGISTRY)),
      ],
      deliveryFor: (ref) => (ref.assistantUserId === "sb-1" ? "webhook" : undefined),
      cinatraHostId: CINATRA_HOST_ID,
    });
    expect(r.shouldCallLlm).toBe(false);
    expect(r.activeHandle).toBe("slackbot");
    expect(r.externalMentions).toEqual([
      { handle: "slackbot", assistantUserId: "sb-1", offset: 0, length: 0 },
    ]);
  });

  it("GUARD — an agent ref plus tagged participants still takes the broadcast branch", async () => {
    const classified = await classifyMentions(AGENT_ONLY, HOST_ONLY_REGISTRY);
    const r = decideMessageRouting({
      classified,
      deliveryFor: NO_DELIVERY,
      cinatraHostId: CINATRA_HOST_ID,
      broadcastContext: {
        taggedAssistantUserIds: ["sb-1"],
        pausedParticipants: [],
        handleMap: { "sb-1": "slackbot" },
      },
    });
    expect(r.isBroadcast).toBe(true);
    expect(r.shouldCallLlm).toBe(true);
    expect(r.externalMentions).toEqual([
      { handle: "slackbot", assistantUserId: "sb-1", offset: 0, length: 0 },
    ]);
  });
});

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
// RULING IMPLEMENTED (cinatra#2820 — the issue carries the ruling, durably;
// a PR body does not survive the squash). The documented canonical form is the
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
// THE OTHER SIDE OF THE SEAM. `explicit-dispatch.ts` is deliberately free of
// `import "server-only"` so it can be unit-tested without the Next server
// harness, which also lets this client-side suite hold both halves of the
// client→server path against ONE literal. Reached by relative path because the
// app is not a workspace dependency of @cinatra-ai/chat (same precedent as
// packages/extensions/src/__tests__/canonical-types-source-validators.test.ts).

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
/** The SAME message a reader types with ordinary capitalization (pinned below). */
const AGENT_ONLY_MIXED_CASE = "Use @Cinatra-AI/Contact-Discovery-Agent to find leads at Acme";
/** What the server pre-router must resolve `AGENT_ONLY` to. */
const AGENT_ONLY_PACKAGE = "@cinatra-ai/contact-discovery-agent";

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

describe("cinatra#2935 (lifecycle-b W5d) — the turn always answers, and nothing dispatches before the model", () => {
  // WHAT THIS BLOCK USED TO BE. A "seam" pair: the client's routing decision on
  // one side, and the server's verb-anchored sentence-matcher
  // (`detectExplicitDispatchPackage`) on the other, tied to ONE literal so a
  // tidy-up of either regex went red. The matcher is GONE — it started an agent
  // before the model read the message — so there is no second half to tie to.
  //
  // WHAT REPLACES IT, from the plan (section 4):
  //
  //   "The rule that ended a turn with no answer at all when a message named
  //    only an agent | The turn always answers. You get a reply and the run's
  //    card, never silence."
  //
  // So the property under test moved from "both halves agree about this
  // literal" to "EVERY typed form reaches the assistant". These arms are RED on
  // the base branch for the no-responder case, which is the one that answered
  // with silence.

  it("the canonical form streams — and no pre-model dispatcher is consulted", async () => {
    expect(resolveDispatchPlan(await route(AGENT_ONLY), undefined)).toMatchObject({
      kind: "stream",
    });
  });

  it("the same message in ordinary capitalization streams too", async () => {
    // The client tokenizer carries `/gi` (`../mention-tokenizer` MENTION_RE) and
    // lowercases vendor+slug, so a reader who capitalizes the way English
    // capitalizes a sentence takes the same road. This used to matter because
    // the server matcher was lowercase-only and the pair disagreed; it matters
    // now because the assistant reads the message either way.
    expect(AGENT_ONLY_MIXED_CASE.toLowerCase()).toBe(AGENT_ONLY.toLowerCase());
    expect(
      resolveDispatchPlan(await route(AGENT_ONLY_MIXED_CASE), undefined),
    ).toMatchObject({ kind: "stream" });
  });

  it("the legacy underscore form streams by the no-mention default", async () => {
    const LEGACY = "use cinatra_contact-discovery-agent to find leads at Acme";
    expect(resolveDispatchPlan(await route(LEGACY), undefined)).toMatchObject({
      kind: "stream",
    });
  });

  it("RED ON BASE — an unresolved handle is answered instead of ending in silence", async () => {
    // THE NO-ANSWER RULE, in one arm. `@chatgpt` is delisted, so it classifies
    // unresolved; on the base branch the route decision returned
    // `{ shouldCallLlm: false, isBroadcast: true }` and `resolveDispatchPlan`
    // answered `{ kind: "none" }` — the client POSTed nothing at all and the
    // person watched their message do nothing. Now the host assistant replies,
    // exactly as it does for a message with no mention.
    const NO_RESPONDER = "@chatgpt what do you think?";
    expect(resolveDispatchPlan(await route(NO_RESPONDER), undefined)).toMatchObject({
      kind: "stream",
    });
  });

  it("RED ON BASE — a message that names ONLY an agent is answered, and in default layout", async () => {
    // The plan's own sentence for this case: "You get a reply and the run's
    // card, never silence." The reply is the host assistant's; the card comes
    // from the `agent_run` tool result of the turn it then takes. Default
    // layout matters for the second half — one mention token does not trip
    // `shouldEnterSlackModeOnSend`, so message parts and the inline run card
    // survive.
    const r = await route(AGENT_ONLY);
    expect(r.shouldCallLlm).toBe(true);
    expect(r.hostAssistantUserId).toBe(CINATRA_HOST_ID);
    expect(r.isBroadcast).toBeUndefined();
    expect(r.hostRuntimeMention).toBeUndefined();
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

  it("RED ON BASE — a NON-agent mention with no tagged participant is ANSWERED", async () => {
    // AMENDED for cinatra#2935 (lifecycle-b W5d): these two arms guarded the
    // no-call plan, which is the no-answer rule this slice removes. They are
    // kept, pointed the other way, because the property worth guarding did not
    // disappear — it INVERTED. An @-token that resolves to nothing must not
    // hang, and it must not vanish either.
    expect(resolveDispatchPlan(await route("@chatgpt hello"), undefined)).toMatchObject({
      kind: "stream",
    });
  });

  it("RED ON BASE — a human tag with no tagged participant is ANSWERED", async () => {
    expect(resolveDispatchPlan(await route("@alice can you look?"), undefined)).toMatchObject({
      kind: "stream",
    });
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

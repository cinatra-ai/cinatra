// Pure message-routing DECISION (cinatra#1875 W2, Epic #1873 — AC#2).
//
// Pins the planner↔routing integration: declared assistants dispatch by their
// DECLARED delivery, @cinatra stays the byte-parity host default, an unknown /
// delisted handle is an HONEST NO-RESPONDER (the retired @chatgpt route), and the
// broadcast branch is unchanged. No literal handle drives any of it — the
// decision reads the classification + a delivery lookup only.

import { describe, expect, it } from "vitest";
import { decideMessageRouting } from "../route-decision";
import type { MentionClassification } from "../classify-mentions";
import type { AssistantDeliveryKind, AssistantDeliveryLookup } from "../dispatch-planner";
import type { MentionToken } from "../mention-tokenizer";

const flatTok = (handle: string): MentionToken => ({
  raw: `@${handle}`,
  kind: "flat",
  handle,
  offset: 0,
  length: handle.length + 1,
});

const scopedTok = (vendor: string, slug: string): MentionToken => ({
  raw: `@${vendor}/${slug}`,
  kind: "scoped",
  handle: slug,
  vendor,
  slug,
  packageRef: `@${vendor}/${slug}`,
  offset: 0,
  length: vendor.length + slug.length + 2,
});

const assistant = (
  handle: string,
  assistantUserId: string,
  packageName: string | null = null,
): MentionClassification => ({
  kind: "assistant",
  token: flatTok(handle),
  assistantUserId,
  handle,
  packageName,
});

const unresolved = (handle: string): MentionClassification => ({
  kind: "unresolved",
  token: flatTok(handle),
});

const agentDispatch = (vendor: string, slug: string): MentionClassification => ({
  kind: "agent-dispatch",
  token: scopedTok(vendor, slug),
  packageRef: `@${vendor}/${slug}`,
});

/** A delivery lookup from an id→kind map (undefined ⇒ planner fail-safe host-runtime). */
const deliveryFrom =
  (map: Record<string, AssistantDeliveryKind>): AssistantDeliveryLookup =>
  (ref) =>
    map[ref.assistantUserId];

const NO_DELIVERY: AssistantDeliveryLookup = () => undefined;

describe("decideMessageRouting — @cinatra host default (byte-parity)", () => {
  it("@cinatra only → host reply attributed to the Cinatra principal, no external/endpoint", () => {
    const r = decideMessageRouting({
      classified: [assistant("cinatra", "cin-1", "@cinatra-ai/cinatra-assistant")],
      deliveryFor: NO_DELIVERY,
      cinatraHostId: "cin-host",
    });
    expect(r).toEqual({
      shouldCallLlm: true,
      activeHandle: "cinatra",
      hostAssistantUserId: "cin-1",
    });
    expect(r.chatEndpoint).toBeUndefined();
    expect(r.externalMentions).toBeUndefined();
    expect(r.hostRuntimeMention).toBeUndefined();
  });

  it("no @-mention at all → default host Cinatra reply", () => {
    expect(
      decideMessageRouting({ classified: [], deliveryFor: NO_DELIVERY, cinatraHostId: "cin-host" }),
    ).toEqual({ shouldCallLlm: true, hostAssistantUserId: "cin-host" });
  });
});

describe("decideMessageRouting — declared host-runtime assistant (generalized former built-in)", () => {
  it("streams in-band over the unified endpoint, attributed to the assistant's own principal", () => {
    const r = decideMessageRouting({
      classified: [assistant("openai", "oa-1", "@cinatra-ai/openai-assistant")],
      deliveryFor: deliveryFrom({ "oa-1": "host-runtime" }),
      cinatraHostId: "cin-host",
    });
    expect(r).toEqual({
      shouldCallLlm: true,
      activeHandle: "openai",
      chatEndpoint: "/api/assistants/chat",
      hostRuntimeMention: { handle: "openai", assistantUserId: "oa-1", offset: 0, length: 0 },
    });
  });

  it("an unknown delivery (registry drift) fails SAFE to host-runtime, never a push", () => {
    const r = decideMessageRouting({
      classified: [assistant("openai", "oa-1", "@cinatra-ai/openai-assistant")],
      deliveryFor: NO_DELIVERY, // undefined ⇒ host-runtime default
      cinatraHostId: "cin-host",
    });
    expect(r.shouldCallLlm).toBe(true);
    expect(r.chatEndpoint).toBe("/api/assistants/chat");
    expect(r.hostRuntimeMention?.assistantUserId).toBe("oa-1");
  });
});

describe("decideMessageRouting — declared webhook / mcp-poll assistant (pending)", () => {
  it("webhook-only → pending external mention + wait-external (no LLM, no endpoint)", () => {
    const r = decideMessageRouting({
      classified: [assistant("slackbot", "sb-1", "@acme/slackbot-assistant")],
      deliveryFor: deliveryFrom({ "sb-1": "webhook" }),
      cinatraHostId: "cin-host",
    });
    expect(r).toEqual({
      shouldCallLlm: false,
      activeHandle: "slackbot",
      externalMentions: [{ handle: "slackbot", assistantUserId: "sb-1", offset: 0, length: 0 }],
    });
    expect(r.chatEndpoint).toBeUndefined();
  });

  it("mcp-poll assistant behaves as a pending push, not a stream", () => {
    const r = decideMessageRouting({
      classified: [assistant("poller", "pl-1", "@acme/poller-assistant")],
      deliveryFor: deliveryFrom({ "pl-1": "mcp-poll" }),
      cinatraHostId: "cin-host",
    });
    expect(r.shouldCallLlm).toBe(false);
    expect(r.externalMentions).toEqual([
      { handle: "poller", assistantUserId: "pl-1", offset: 0, length: 0 },
    ]);
  });

  it("@cinatra + a webhook assistant → Cinatra replies AND the webhook persists pending", () => {
    const r = decideMessageRouting({
      classified: [
        assistant("cinatra", "cin-1", "@cinatra-ai/cinatra-assistant"),
        assistant("slackbot", "sb-1", "@acme/slackbot-assistant"),
      ],
      deliveryFor: deliveryFrom({ "sb-1": "webhook" }),
      cinatraHostId: "cin-host",
    });
    expect(r.shouldCallLlm).toBe(true);
    expect(r.hostAssistantUserId).toBe("cin-1");
    expect(r.activeHandle).toBe("slackbot");
    expect(r.externalMentions).toEqual([
      { handle: "slackbot", assistantUserId: "sb-1", offset: 0, length: 0 },
    ]);
  });

  it("dedupes a doubly-named assistant (flat + scoped) to ONE pending push", () => {
    const classified: MentionClassification[] = [
      { kind: "assistant", token: flatTok("slackbot"), assistantUserId: "sb-1", handle: "slackbot", packageName: "@acme/slackbot-assistant" },
      { kind: "assistant", token: scopedTok("acme", "slackbot-assistant"), assistantUserId: "sb-1", handle: "slackbot-assistant", packageName: "@acme/slackbot-assistant" },
    ];
    const r = decideMessageRouting({
      classified,
      deliveryFor: deliveryFrom({ "sb-1": "webhook" }),
      cinatraHostId: "cin-host",
    });
    expect(r.externalMentions).toHaveLength(1);
  });
});

describe("decideMessageRouting — honest no-responder (the retired @chatgpt route)", () => {
  it("an unknown/delisted handle with no tagged participants → no reply, no hang", () => {
    // @chatgpt post-ruling: not in the audience registry ⇒ classifies unresolved.
    const r = decideMessageRouting({
      classified: [unresolved("chatgpt")],
      deliveryFor: NO_DELIVERY,
      cinatraHostId: "cin-host",
    });
    // { shouldCallLlm:false, isBroadcast:true } → resolveDispatchPlan `{ kind:"none" }`.
    expect(r).toEqual({ shouldCallLlm: false, isBroadcast: true });
  });

  it("a scoped agent-dispatch ref (not an in-audience assistant) → honest no-responder", () => {
    const r = decideMessageRouting({
      classified: [agentDispatch("acme", "some-agent")],
      deliveryFor: NO_DELIVERY,
      cinatraHostId: "cin-host",
    });
    expect(r).toEqual({ shouldCallLlm: false, isBroadcast: true });
  });

  it("an unknown handle STILL honors tagged broadcast participants (silent-reply-bug fix)", () => {
    const r = decideMessageRouting({
      classified: [unresolved("alice")],
      deliveryFor: NO_DELIVERY,
      cinatraHostId: "cin-host",
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
    expect(r.hostAssistantUserId).toBe("cin-host");
  });
});

describe("decideMessageRouting — broadcast branch (unchanged)", () => {
  it("tagged participants, Cinatra paused → external fire only, no host reply", () => {
    const r = decideMessageRouting({
      classified: [],
      deliveryFor: NO_DELIVERY,
      cinatraHostId: "cin-host",
      broadcastContext: {
        taggedAssistantUserIds: ["sb-1"],
        pausedParticipants: ["cinatra"],
        handleMap: { "sb-1": "slackbot" },
      },
    });
    expect(r.shouldCallLlm).toBe(false);
    expect(r.isBroadcast).toBe(true);
    expect(r.hostAssistantUserId).toBeUndefined();
    expect(r.externalMentions).toEqual([
      { handle: "slackbot", assistantUserId: "sb-1", offset: 0, length: 0 },
    ]);
  });

  it("tagged participant paused → dropped from the broadcast set", () => {
    const r = decideMessageRouting({
      classified: [],
      deliveryFor: NO_DELIVERY,
      cinatraHostId: "cin-host",
      broadcastContext: {
        taggedAssistantUserIds: ["sb-1"],
        pausedParticipants: ["sb-1"],
        handleMap: { "sb-1": "slackbot" },
      },
    });
    expect(r.shouldCallLlm).toBe(true); // Cinatra not paused → still replies
    expect(r.externalMentions).toBeUndefined();
    expect(r.hostAssistantUserId).toBe("cin-host");
  });
});

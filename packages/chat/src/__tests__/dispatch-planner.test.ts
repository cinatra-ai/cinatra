// cinatra#1875 W2 (Epic #1873) — AC#2: declaration-driven dispatch planner.
// A classified assistant mention resolves to a plan {delivery, endpoint} from its
// DECLARED delivery channel — never from a hardcoded chatgpt/gemini handle set.
// Ruling (plan-of-record 2026-07-21, M1/M2): no built-in class, no @chatgpt token.

import { describe, it, expect } from "vitest";
import {
  planAssistantDispatch,
  HOST_RUNTIME_ENDPOINT,
  type AssistantDeliveryKind,
  type AssistantDeliveryLookup,
} from "../dispatch-planner";
import { classifyMentions, type AudienceScopedAssistantResolver } from "../classify-mentions";

/** A resolver over in-audience fixtures (anything else → null, i.e. not visible). */
function resolver(opts: {
  byRef?: Record<string, { assistantUserId: string; handle: string; packageName: string }>;
  byHandle?: Record<string, { assistantUserId: string; packageName: string | null }>;
}): AudienceScopedAssistantResolver {
  return {
    byPackageRef: async (ref) => opts.byRef?.[ref] ?? null,
    byHandle: async (h) => opts.byHandle?.[h] ?? null,
  };
}

/** A delivery lookup over a packageName → delivery map. Unknown → undefined
 *  (planner then fails safe to host-runtime). */
function deliveryFor(map: Record<string, AssistantDeliveryKind>): AssistantDeliveryLookup {
  return (ref) => (ref.packageName ? map[ref.packageName] : undefined);
}

describe("planAssistantDispatch — declared delivery drives the plan", () => {
  it("routes a declared host-runtime assistant to an in-band stream directive", async () => {
    const classified = await classifyMentions(
      "@cinatra-ai/openai-assistant hi",
      resolver({
        byRef: {
          "@cinatra-ai/openai-assistant": {
            assistantUserId: "u-oai",
            handle: "openai",
            packageName: "@cinatra-ai/openai-assistant",
          },
        },
      }),
    );
    const plan = planAssistantDispatch(
      classified,
      deliveryFor({ "@cinatra-ai/openai-assistant": "host-runtime" }),
    );
    expect(plan.hostRuntime).toHaveLength(1);
    expect(plan.push).toHaveLength(0);
    expect(plan.hostRuntime[0]).toMatchObject({
      assistantUserId: "u-oai",
      handle: "openai",
      delivery: "host-runtime",
      endpoint: HOST_RUNTIME_ENDPOINT,
    });
  });

  it("routes a declared webhook assistant to an out-of-band push directive (no endpoint)", async () => {
    const classified = await classifyMentions(
      "@acme summarize",
      resolver({ byHandle: { acme: { assistantUserId: "u-acme", packageName: "@acme/assistant" } } }),
    );
    const plan = planAssistantDispatch(classified, deliveryFor({ "@acme/assistant": "webhook" }));
    expect(plan.push).toHaveLength(1);
    expect(plan.hostRuntime).toHaveLength(0);
    expect(plan.push[0]).toMatchObject({ assistantUserId: "u-acme", delivery: "webhook" });
    expect(plan.push[0].endpoint).toBeUndefined();
  });

  it("routes a declared mcp-poll assistant to a push directive (no endpoint)", async () => {
    const classified = await classifyMentions(
      "@poller go",
      resolver({ byHandle: { poller: { assistantUserId: "u-poll", packageName: "@x/poller" } } }),
    );
    const plan = planAssistantDispatch(classified, deliveryFor({ "@x/poller": "mcp-poll" }));
    expect(plan.push).toHaveLength(1);
    expect(plan.push[0]).toMatchObject({ assistantUserId: "u-poll", delivery: "mcp-poll" });
    expect(plan.push[0].endpoint).toBeUndefined();
  });

  it("produces NO directive for an undeclared/unresolved mention (honest no-responder)", async () => {
    // @openai is not installed yet (W6 ships it) → classifier resolves nothing.
    const classified = await classifyMentions("@openai hello", resolver({}));
    const plan = planAssistantDispatch(classified, deliveryFor({}));
    expect(plan.directives).toEqual([]);
    expect(plan.hostRuntime).toEqual([]);
    expect(plan.push).toEqual([]);
  });

  it("does NOT dispatch a scoped agent-dispatch candidate (registry miss) as an assistant", async () => {
    const classified = await classifyMentions("@vendor/tool run", resolver({}));
    // The scoped ref is an agent-dispatch candidate, not an assistant mention.
    const plan = planAssistantDispatch(classified, deliveryFor({ "vendor/tool": "host-runtime" }));
    expect(plan.directives).toEqual([]);
  });

  it("dedupes to ONE directive when the same assistant is named twice (flat + scoped)", async () => {
    const classified = await classifyMentions(
      "@cinatra-ai/openai-assistant and also @openai",
      resolver({
        byRef: {
          "@cinatra-ai/openai-assistant": {
            assistantUserId: "u-oai",
            handle: "openai",
            packageName: "@cinatra-ai/openai-assistant",
          },
        },
        byHandle: { openai: { assistantUserId: "u-oai", packageName: "@cinatra-ai/openai-assistant" } },
      }),
    );
    const plan = planAssistantDispatch(
      classified,
      deliveryFor({ "@cinatra-ai/openai-assistant": "host-runtime" }),
    );
    expect(plan.directives).toHaveLength(1);
    expect(plan.hostRuntime[0].assistantUserId).toBe("u-oai");
  });

  it("preserves source order and mixes delivery channels", async () => {
    const classified = await classifyMentions(
      "@host then @hook",
      resolver({
        byHandle: {
          host: { assistantUserId: "u-host", packageName: "@p/host" },
          hook: { assistantUserId: "u-hook", packageName: "@p/hook" },
        },
      }),
    );
    const plan = planAssistantDispatch(
      classified,
      deliveryFor({ "@p/host": "host-runtime", "@p/hook": "webhook" }),
    );
    expect(plan.directives.map((d) => d.assistantUserId)).toEqual(["u-host", "u-hook"]);
    expect(plan.hostRuntime.map((d) => d.assistantUserId)).toEqual(["u-host"]);
    expect(plan.push.map((d) => d.assistantUserId)).toEqual(["u-hook"]);
  });

  it("fails SAFE to host-runtime when the delivery lookup misses for a classified assistant", async () => {
    const classified = await classifyMentions(
      "@drifted go",
      resolver({ byHandle: { drifted: { assistantUserId: "u-d", packageName: "@p/drifted" } } }),
    );
    // Lookup returns undefined (registry drift) → planner defaults to host-runtime,
    // NEVER an external push.
    const plan = planAssistantDispatch(classified, deliveryFor({}));
    expect(plan.hostRuntime).toHaveLength(1);
    expect(plan.hostRuntime[0]).toMatchObject({ assistantUserId: "u-d", delivery: "host-runtime" });
    expect(plan.push).toHaveLength(0);
  });
});

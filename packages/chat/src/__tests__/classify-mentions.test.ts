// cinatra#1875 W2 (Epic #1873) — AC#1 phase 2: two-phase classification.
// Registry-lookup-FIRST: a scoped ref naming a registered, in-audience assistant
// is an assistant mention ALWAYS; only otherwise is it an agent_run dispatch
// candidate. A forged out-of-audience mention resolves to null (never assistant).

import { describe, it, expect } from "vitest";
import {
  classifyMentions,
  assistantMentions,
  agentDispatchRefs,
  type AudienceScopedAssistantResolver,
} from "../classify-mentions";

/** Build a resolver from in-audience fixtures. Anything not listed resolves null
 *  (models the audience filter: out-of-audience / unregistered → not visible). */
function resolver(opts: {
  byRef?: Record<string, { assistantUserId: string; handle: string; packageName: string }>;
  byHandle?: Record<string, { assistantUserId: string; handle: string; packageName: string | null }>;
}): AudienceScopedAssistantResolver {
  return {
    byPackageRef: async (ref) => opts.byRef?.[ref] ?? null,
    byHandle: async (h) => opts.byHandle?.[h] ?? null,
  };
}

describe("classifyMentions — registry lookup wins for scoped refs", () => {
  it("classifies a scoped ref that IS a registered in-audience assistant as an assistant mention", async () => {
    const out = await classifyMentions(
      "hey @cinatra-ai/gemini-assistant summarize this",
      resolver({
        byRef: {
          "@cinatra-ai/gemini-assistant": {
            assistantUserId: "u-gem",
            handle: "gemini",
            packageName: "@cinatra-ai/gemini-assistant",
          },
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "assistant", assistantUserId: "u-gem", handle: "gemini" });
    expect(agentDispatchRefs(out)).toEqual([]);
  });

  it("falls a scoped ref through to agent_run dispatch ONLY when the registry misses", async () => {
    const out = await classifyMentions(
      "run @cinatra-ai/contact-discovery-agent on acme.com",
      resolver({ byRef: {} }), // not an assistant
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("agent-dispatch");
    expect(agentDispatchRefs(out)).toEqual(["@cinatra-ai/contact-discovery-agent"]);
    expect(assistantMentions(out)).toEqual([]);
  });
});

describe("classifyMentions — flat handles", () => {
  it("classifies an in-audience flat handle as an assistant mention", async () => {
    const out = await classifyMentions(
      "@cinatra please help",
      resolver({ byHandle: { cinatra: { assistantUserId: "u-cin", handle: "cinatra", packageName: "@cinatra-ai/cinatra-assistant" } } }),
    );
    expect(out[0]).toMatchObject({ kind: "assistant", assistantUserId: "u-cin", handle: "cinatra" });
  });

  it("classifies an out-of-audience / unknown flat handle as unresolved (routing fall-through)", async () => {
    const out = await classifyMentions("@ghost hello", resolver({}));
    expect(out[0].kind).toBe("unresolved");
    expect(assistantMentions(out)).toEqual([]);
  });

  it("resolves an ALIAS token to the principal's CANONICAL handle (not the alias)", async () => {
    // The user types an alias (`@gpt`); the registry resolves it to the
    // principal whose canonical handle is `openai` — the classification carries
    // the canonical handle so the unified endpoint selector never 404s on an
    // alias.
    const out = await classifyMentions(
      "@gpt draft a reply",
      resolver({ byHandle: { gpt: { assistantUserId: "u-oa", handle: "openai", packageName: "@cinatra-ai/openai-assistant" } } }),
    );
    expect(out[0]).toMatchObject({ kind: "assistant", assistantUserId: "u-oa", handle: "openai" });
  });
});

describe("classifyMentions — mixed + audience isolation", () => {
  it("resolves a registered assistant but drops a forged out-of-audience scoped ref to dispatch", async () => {
    const out = await classifyMentions(
      "@cinatra and @other-vendor/secret-assistant",
      resolver({
        byHandle: { cinatra: { assistantUserId: "u-cin", handle: "cinatra", packageName: "@cinatra-ai/cinatra-assistant" } },
        // @other-vendor/secret-assistant is NOT in this actor's audience → null.
        byRef: {},
      }),
    );
    expect(out.map((c) => c.kind)).toEqual(["assistant", "agent-dispatch"]);
    expect(assistantMentions(out).map((a) => a.assistantUserId)).toEqual(["u-cin"]);
  });

  it("returns [] with no resolver calls for a message with no mentions", async () => {
    let calls = 0;
    const spy: AudienceScopedAssistantResolver = {
      byPackageRef: async () => {
        calls++;
        return null;
      },
      byHandle: async () => {
        calls++;
        return null;
      },
    };
    expect(await classifyMentions("no mentions here", spy)).toEqual([]);
    expect(calls).toBe(0);
  });
});

// The system-string composer (cinatra#2771 lever 2).
//
// The property that matters is not "the string contains everything" — the old
// concatenation did that too. It is: CHANGING A VOLATILE FRAGMENT MUST NOT MOVE
// THE STABLE HEAD. That is exactly what a provider prefix cache can reuse, and
// it is what the old order broke, because the two most turn-dependent fragments
// (the explicit-dispatch directive, and the attachment manifest the LLM package
// adds) sat at byte 0.

import { describe, expect, it } from "vitest";

import {
  CHAT_SYSTEM_STABLE_FRAGMENTS,
  CHAT_SYSTEM_VOLATILE_FRAGMENTS,
  chatSystemPromptStableHead,
  composeChatSystemPrompt,
  type ChatSystemPromptFragments,
} from "../chat-system-prefix";

const BASE: ChatSystemPromptFragments = {
  systemPrompt: "PERSONA",
  skillSystemContext: "SKILLS",
  instanceContext: "\n\nINSTANCE",
  extensionConfirmationPolicy: "\n\nPOLICY",
  userContext: "\n\nUser context:\nUC",
  pendingConfirmationContext: "\n\nPENDING",
  explicitDispatchDirective: "\nDISPATCH\n",
  conversationOnlyNotice: "\n\nNOTICE",
};

describe("the stable head and the volatile tail are disjoint and complete", () => {
  it("names every fragment exactly once", () => {
    const named = [
      ...CHAT_SYSTEM_STABLE_FRAGMENTS,
      ...CHAT_SYSTEM_VOLATILE_FRAGMENTS,
    ];
    expect([...named].sort()).toEqual(Object.keys(BASE).sort());
    expect(new Set(named).size).toBe(named.length);
  });

  it("composes head + tail with nothing dropped", () => {
    const composed = composeChatSystemPrompt(BASE);
    for (const value of Object.values(BASE)) {
      expect(composed).toContain(value.trim());
    }
  });

  it("keeps the skill fragment's blank-line separator", () => {
    expect(composeChatSystemPrompt(BASE)).toContain("PERSONA\n\nSKILLS");
  });
});

describe("byte-stability", () => {
  it("is byte-identical for the same fragments, composed twice", () => {
    expect(composeChatSystemPrompt(BASE)).toBe(composeChatSystemPrompt(BASE));
  });

  it("a changed VOLATILE fragment leaves the stable head byte-identical", () => {
    const head = chatSystemPromptStableHead(BASE);
    for (const key of CHAT_SYSTEM_VOLATILE_FRAGMENTS) {
      const mutated = { ...BASE, [key]: `${BASE[key]}-CHANGED` };
      expect(chatSystemPromptStableHead(mutated)).toBe(head);
      expect(composeChatSystemPrompt(mutated).startsWith(head)).toBe(true);
    }
  });

  it("the explicit-dispatch directive appearing mid-conversation costs only its own bytes", () => {
    // The regression this replaces: the directive used to be the FIRST
    // fragment, so a single "@vendor/slug" mention moved the divergence point
    // to byte 0 and re-billed the entire prompt.
    const without = composeChatSystemPrompt({ ...BASE, explicitDispatchDirective: "" });
    const with_ = composeChatSystemPrompt(BASE);
    const head = chatSystemPromptStableHead(BASE);
    expect(without.startsWith(head)).toBe(true);
    expect(with_.startsWith(head)).toBe(true);
  });

  it("an EMPTY fragment contributes nothing (no stray separators)", () => {
    const empty: ChatSystemPromptFragments = {
      systemPrompt: "PERSONA",
      skillSystemContext: "",
      instanceContext: "",
      extensionConfirmationPolicy: "",
      userContext: "",
      pendingConfirmationContext: "",
      explicitDispatchDirective: "",
      conversationOnlyNotice: "",
    };
    expect(composeChatSystemPrompt(empty)).toBe("PERSONA");
  });
});

describe("ordering", () => {
  it("every stable fragment precedes every volatile fragment", () => {
    const composed = composeChatSystemPrompt(BASE);
    const lastStable = Math.max(
      ...CHAT_SYSTEM_STABLE_FRAGMENTS.map((k) => composed.indexOf(BASE[k].trim())),
    );
    const firstVolatile = Math.min(
      ...CHAT_SYSTEM_VOLATILE_FRAGMENTS.map((k) => composed.indexOf(BASE[k].trim())),
    );
    expect(lastStable).toBeLessThan(firstVolatile);
  });
});

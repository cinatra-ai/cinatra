import { describe, it, expect } from "vitest";
import type { DelegatedChatToolClass as SdkDelegatedChatToolClass } from "@cinatra-ai/sdk-extensions";
import {
  DELEGATED_CHAT_TOOL_CLASSES,
  normalizeDelegatedChatToolClass,
  type DelegatedChatToolClass as PolicyDelegatedChatToolClass,
} from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";

// ---------------------------------------------------------------------------
// DRIFT CHECK: the author-facing declaration enum vs the enum the host
// actually enforces (cinatra#2771).
//
// The typed delegated-chat declaration is deliberately split in two:
//
//   the TYPE lives in `@cinatra-ai/sdk-extensions`, because a connector must be
//   able to declare without importing host internals — and because the SDK's
//   connector contract is TYPE-ONLY, so it adds no module to any route graph;
//
//   the RUNTIME normalizer/reader lives in
//   `@cinatra-ai/mcp-server/delegated-chat-tool-policy`, next to the deny rules
//   it composes with, in a module that is already on every route graph that
//   mounts the MCP registry and already dependency-free.
//
// That split is the right one, but it means two declarations of "what a class
// is" exist. If they ever diverge, a connector could declare a class the SDK
// accepts and the host normalizes to `none` — the primitive would vanish from
// chat with a type-checked, apparently-correct declaration. Or worse in the
// other direction.
//
// `@cinatra-ai/llm` is the one package that depends on BOTH, so the check lives
// here. It is enforced two ways: at the TYPE level (mutual assignability, which
// fails the build) and at the VALUE level (the runtime list round-trips), so
// neither a type-only nor a value-only edit can slip through.
// ---------------------------------------------------------------------------

describe("delegated-chat class: SDK type vs host runtime", () => {
  it("the two types are mutually assignable (compile-time)", () => {
    // Each direction is a separate assertion on purpose: a one-way check would
    // pass while one side quietly grew a member the other does not know.
    const sdkToPolicy: PolicyDelegatedChatToolClass = "dispatch" satisfies SdkDelegatedChatToolClass;
    const policyToSdk: SdkDelegatedChatToolClass = "dispatch" satisfies PolicyDelegatedChatToolClass;
    expect(sdkToPolicy).toBe("dispatch");
    expect(policyToSdk).toBe("dispatch");

    // Exhaustiveness: a member added to EITHER union without the other makes
    // one of these mappings non-exhaustive and fails to type-check.
    const sdkExhaustive: Record<SdkDelegatedChatToolClass, PolicyDelegatedChatToolClass> = {
      read: "read",
      discovery: "discovery",
      dispatch: "dispatch",
      none: "none",
    };
    const policyExhaustive: Record<PolicyDelegatedChatToolClass, SdkDelegatedChatToolClass> = {
      read: "read",
      discovery: "discovery",
      dispatch: "dispatch",
      none: "none",
    };
    expect(Object.keys(sdkExhaustive).sort()).toEqual(Object.keys(policyExhaustive).sort());
  });

  it("every value the runtime list names round-trips through the normalizer", () => {
    // The value-level half. `DELEGATED_CHAT_TOOL_CLASSES` is what the host
    // validates against; a member it lists but the normalizer rejects would
    // normalize to `none` and silently narrow.
    for (const cls of DELEGATED_CHAT_TOOL_CLASSES) {
      const asSdk: SdkDelegatedChatToolClass = cls;
      expect(normalizeDelegatedChatToolClass(asSdk)).toBe(cls);
    }
    expect(DELEGATED_CHAT_TOOL_CLASSES).toHaveLength(4);
  });
});

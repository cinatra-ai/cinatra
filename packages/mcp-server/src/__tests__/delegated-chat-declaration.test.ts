import { describe, it, expect } from "vitest";
import {
  DELEGATED_CHAT_TOOL_CLASSES,
  declarationPermitsDelegatedChat,
  delegatedChatAllowedToolNames,
  isDelegatedChatMcpToolAllowed,
  normalizeDelegatedChatToolClass,
  readDeclaredDelegatedChatClass,
  type DelegatedChatToolClass,
} from "../delegated-chat-tool-policy";

// The typed delegated-chat declaration (cinatra#2771, owner ruling
// 2026-08-15).
//
// The whole point of these tests is the ONE property the ruling insists on: a
// declaration is NOT authorization. It may narrow what the host admitted; it
// may never admit anything the host refused. Everything below is a way of
// asking that question so a future edit that quietly inverts it fails here.

describe("declaration: structural validation of the enum", () => {
  it("accepts exactly the four declared classes and nothing else", () => {
    expect([...DELEGATED_CHAT_TOOL_CLASSES]).toEqual(["read", "discovery", "dispatch", "none"]);
    for (const cls of DELEGATED_CHAT_TOOL_CLASSES) {
      expect(normalizeDelegatedChatToolClass(cls)).toBe(cls);
    }
  });

  it("treats an ABSENT declaration as undeclared, which is neutral", () => {
    expect(normalizeDelegatedChatToolClass(undefined)).toBeUndefined();
    expect(normalizeDelegatedChatToolClass(null)).toBeUndefined();
    expect(declarationPermitsDelegatedChat(undefined)).toBe(true);
  });

  it("normalizes a MALFORMED declaration to `none`, never back to undeclared", () => {
    // This is the load-bearing asymmetry. `undefined` is NEUTRAL — it leaves a
    // host-admitted name in place. If an unreadable value normalized to
    // `undefined`, a broken or hostile declaration would be re-read as "no
    // opinion" and would WIDEN relative to a correctly-read `none`. So every
    // unreadable shape must land on the narrowing side.
    for (const malformed of [
      "READ",
      "Read",
      "dispatch ",
      "",
      "admin",
      42,
      true,
      {},
      [],
      { toString: () => "read" },
      Symbol("read"),
    ]) {
      expect(normalizeDelegatedChatToolClass(malformed)).toBe("none");
      expect(declarationPermitsDelegatedChat(normalizeDelegatedChatToolClass(malformed))).toBe(
        false,
      );
    }
  });

  it("`none` declines the chat surface; the other three do not", () => {
    expect(declarationPermitsDelegatedChat("read")).toBe(true);
    expect(declarationPermitsDelegatedChat("discovery")).toBe(true);
    expect(declarationPermitsDelegatedChat("dispatch")).toBe(true);
    expect(declarationPermitsDelegatedChat("none")).toBe(false);
  });
});

describe("declaration: reading the manifest-discovered `(name, config, handler)` path", () => {
  it("reads the declaration off a connector's registerTool config", () => {
    expect(
      readDeclaredDelegatedChatClass({ title: "t", description: "d", delegatedChat: "discovery" }),
    ).toBe("discovery");
  });

  it("reads a config that carries no declaration as undeclared", () => {
    // Every registration in the tree today. This is why adding the field is
    // behavior-identical until something actually declares.
    expect(readDeclaredDelegatedChatClass({ title: "t", annotations: {}, _meta: {} })).toBeUndefined();
  });

  it("is total — a non-object config never throws inside a registration pass", () => {
    for (const config of [undefined, null, "read", 7, true, () => {}]) {
      expect(() => readDeclaredDelegatedChatClass(config)).not.toThrow();
    }
    expect(readDeclaredDelegatedChatClass(null)).toBeUndefined();
    expect(readDeclaredDelegatedChatClass("read")).toBeUndefined();
  });

  it("normalizes a malformed declaration found on a config, same as anywhere else", () => {
    expect(readDeclaredDelegatedChatClass({ delegatedChat: "superuser" })).toBe("none");
  });
});

describe("declaration: NEVER sufficient authorization", () => {
  // The composition the runtime actually applies, mirrored exactly:
  // admission FIRST, declaration only as an AND on top.
  const registrable = (name: string, config: unknown): boolean =>
    isDelegatedChatMcpToolAllowed(name) &&
    declarationPermitsDelegatedChat(readDeclaredDelegatedChatClass(config));

  it("cannot rescue a DENIED FAMILY prefix, whatever it declares", () => {
    for (const cls of DELEGATED_CHAT_TOOL_CLASSES) {
      expect(registrable("permissions_grant_list", { delegatedChat: cls })).toBe(false);
      expect(registrable("apollo_jobs_list", { delegatedChat: cls })).toBe(false);
    }
  });

  it("cannot rescue a DENIED FAMILY substring, whatever it declares", () => {
    for (const cls of DELEGATED_CHAT_TOOL_CLASSES) {
      expect(registrable("x_system_read", { delegatedChat: cls })).toBe(false);
      expect(registrable("queue_process_due", { delegatedChat: cls })).toBe(false);
    }
  });

  it("cannot rescue a DESTRUCTIVE VERB token, whatever it declares", () => {
    for (const cls of DELEGATED_CHAT_TOOL_CLASSES) {
      expect(registrable("objects_delete", { delegatedChat: cls })).toBe(false);
      expect(registrable("email_send", { delegatedChat: cls })).toBe(false);
    }
  });

  it("cannot admit an UNLISTED name — declaring `read` grants nothing", () => {
    // The extensibility gap #2817 owns: a hot-installed connector's primitive
    // is still unreachable until the admission SOURCE changes. This PR does
    // not move that line, and this test pins that it did not.
    expect(isDelegatedChatMcpToolAllowed("acme_widget_catalog_list")).toBe(false);
    expect(registrable("acme_widget_catalog_list", { delegatedChat: "read" })).toBe(false);
  });

  it("DOES narrow: `none` removes a name the host admits", () => {
    const admitted = delegatedChatAllowedToolNames()[0];
    expect(admitted).toBeTruthy();
    expect(registrable(admitted, undefined)).toBe(true);
    expect(registrable(admitted, { delegatedChat: "none" })).toBe(false);
    expect(registrable(admitted, { delegatedChat: "nonsense" })).toBe(false);
    expect(registrable(admitted, { delegatedChat: "read" })).toBe(true);
  });

  it("leaves the whole admitted set intact when nothing declares", () => {
    // Behavior-identity proof for the current tree: no registration declares,
    // so the declaration channel is a no-op today.
    const withoutConfig = delegatedChatAllowedToolNames().filter((n) => registrable(n, undefined));
    const withBareConfig = delegatedChatAllowedToolNames().filter((n) =>
      registrable(n, { title: n, description: n }),
    );
    expect(withoutConfig).toEqual([...delegatedChatAllowedToolNames()]);
    expect(withBareConfig).toEqual([...delegatedChatAllowedToolNames()]);
  });
});

describe("declaration: the proposal override stays a SEPARATE audited exception", () => {
  it("is not collapsed into the `dispatch` class", () => {
    // The ruling is explicit: `ALLOWED_PROPOSAL_OVERRIDE` remains its own
    // mechanism. It is accepted ABOVE the verb backstop by the policy itself,
    // which no declaration can reproduce — declaring `dispatch` on the same
    // name gets nothing extra, and declaring anything on a non-override name
    // that carries a denied verb token still loses.
    const override = delegatedChatAllowedToolNames().find((n) => n === "dashboards_create");
    expect(override).toBe("dashboards_create");
    // It survives BECAUSE the override admits it, not because of any class:
    // "create" is a denied verb token, so nothing but the override gets it
    // past the backstop.
    expect(isDelegatedChatMcpToolAllowed("dashboards_create")).toBe(true);
    // A sibling name carrying the same verb token, absent from the override,
    // is refused no matter what it declares.
    expect(isDelegatedChatMcpToolAllowed("acme_thing_create")).toBe(false);
    for (const cls of DELEGATED_CHAT_TOOL_CLASSES) {
      expect(
        isDelegatedChatMcpToolAllowed("acme_thing_create") &&
          declarationPermitsDelegatedChat(cls as DelegatedChatToolClass),
      ).toBe(false);
    }
  });
});

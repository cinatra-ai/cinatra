import { describe, it, expect } from "vitest";
import {
  DELEGATED_CHAT_TOOL_CLASSES,
  declarationPermitsDelegatedChat,
  delegatedChatAllowedToolNames,
  interimDelegatedChatClassFor,
  isDelegatedChatMcpToolAllowed,
  normalizeDelegatedChatToolClass,
  readDeclaredDelegatedChatClass,
  resolveDelegatedChatClass,
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

  it("treats an ABSENT declaration as undeclared, and undeclared as NONE", () => {
    // INVERTED by the owner's ruling. `normalize` still reports absence
    // faithfully as `undefined` — that distinction is what lets the interim
    // shim tell "nobody declared" apart from "declared none" — but the
    // PREDICATE no longer reads absence as neutral. Missing means unexposed.
    expect(normalizeDelegatedChatToolClass(undefined)).toBeUndefined();
    expect(normalizeDelegatedChatToolClass(null)).toBeUndefined();
    expect(declarationPermitsDelegatedChat(undefined)).toBe(false);
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

  it("is total against a THROWING accessor, and lands on `none`", () => {
    // `config` is an arbitrary connector-supplied object, so the property READ
    // is itself untrusted. An escaping throw would propagate out of
    // `policedRegisterTool` and take down the whole per-request capability
    // build instead of refusing one name.
    const throwingGetter = {
      title: "t",
      get delegatedChat(): unknown {
        throw new Error("hostile accessor");
      },
    };
    const throwingProxy = new Proxy(
      { title: "t" },
      {
        get(target, prop, receiver) {
          if (prop === "delegatedChat") throw new Error("hostile trap");
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    for (const config of [throwingGetter, throwingProxy]) {
      expect(() => readDeclaredDelegatedChatClass(config)).not.toThrow();
      // `none`, NOT `undefined`: the field is PRESENT and unreadable, which is
      // the malformed case. Landing on `undefined` would hand it to the interim
      // shim, which would then hand back a chat-eligible class — a hostile
      // accessor would have bought exposure by being unreadable.
      expect(readDeclaredDelegatedChatClass(config)).toBe("none");
      expect(declarationPermitsDelegatedChat(readDeclaredDelegatedChatClass(config))).toBe(false);
    }
  });

  it("normalizes a malformed declaration found on a config, same as anywhere else", () => {
    expect(readDeclaredDelegatedChatClass({ delegatedChat: "superuser" })).toBe("none");
  });
});

describe("declaration: NEVER sufficient authorization", () => {
  // The composition the runtime actually applies, mirrored exactly: admission
  // FIRST, then the class IN FORCE (the registration's own, else the interim
  // one the legacy allowlist implies) as an AND on top. Both the choke point
  // and the call-time self-invoker compose it this way; keeping the mirror
  // exact is what makes the assertions below statements about the runtime.
  const registrable = (name: string, config: unknown): boolean =>
    isDelegatedChatMcpToolAllowed(name) &&
    declarationPermitsDelegatedChat(
      resolveDelegatedChatClass(name, readDeclaredDelegatedChatClass(config)),
    );

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
    // Behavior-identity proof for the current tree, and the reason the interim
    // shim exists. No registration declares, and since the ruling a missing
    // declaration means NONE — so without the shim this assertion would go to
    // `[]` and the entire delegated-chat catalog would empty. It holds because
    // the shim supplies the class the legacy allowlist implies, for exactly the
    // names that allowlist admits.
    const withoutConfig = delegatedChatAllowedToolNames().filter((n) => registrable(n, undefined));
    const withBareConfig = delegatedChatAllowedToolNames().filter((n) =>
      registrable(n, { title: n, description: n }),
    );
    expect(withoutConfig).toEqual([...delegatedChatAllowedToolNames()]);
    expect(withBareConfig).toEqual([...delegatedChatAllowedToolNames()]);
  });

  it("withdraws an admitted name the interim shim does NOT cover", () => {
    // The pin that proves the previous test is carried by the shim and not by
    // a surviving fail-open. Compose the same way, but with a host that admits
    // a name the shim has never heard of: no class is in force, so the ruling
    // applies and the name is withdrawn.
    const uncovered = "acme_widget_catalog_list";
    expect(interimDelegatedChatClassFor(uncovered)).toBeUndefined();
    expect(
      declarationPermitsDelegatedChat(resolveDelegatedChatClass(uncovered, undefined)),
    ).toBe(false);
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

describe("the INTERIM shim for the legacy allowlist (cinatra#2817 deletes it)", () => {
  // The shim is what lets the ruling's semantics — missing means none — hold
  // TODAY, while admission still seeds from `delegatedChatAllowedToolNames()`
  // and nothing in the tree declares. These tests are its whole contract: it
  // covers exactly the legacy allowlist, it changes no catalog byte, and it
  // never overrides a real declaration.

  it("covers EXACTLY the names the legacy allowlist admits, in both directions", () => {
    // Both directions matter. A missing entry would silently withdraw a
    // primitive that works in production today; an extra entry would be a
    // class sitting on a name the allowlist does not admit, which is how a
    // future edit to `ALLOWED_EXACT` could quietly inherit an old opinion.
    const admitted = [...delegatedChatAllowedToolNames()].sort();
    const uncovered = admitted.filter((name) => interimDelegatedChatClassFor(name) === undefined);
    expect(uncovered).toEqual([]);

    // And nothing beyond it: every name carrying an interim class must still be
    // one the policy admits on its own.
    for (const name of admitted) {
      expect(isDelegatedChatMcpToolAllowed(name)).toBe(true);
    }
  });

  it("assigns every covered name one of the three CHAT-ELIGIBLE classes", () => {
    // `none` in the shim would be a withdrawal dressed as a classification —
    // the shim's job is to reproduce today's catalog, not to edit it.
    for (const name of delegatedChatAllowedToolNames()) {
      const cls = interimDelegatedChatClassFor(name);
      expect({ name, cls }).toEqual({
        name,
        cls: expect.stringMatching(/^(read|discovery|dispatch)$/),
      });
    }
  });

  it("leaves the resolved catalog BYTE FOR BYTE what it was before the ruling", () => {
    // The invariant the whole shape exists to protect. `delegatedChatAllowedToolNames()`
    // is the production seeding source; running every member through the exact
    // composition the runtime now applies must return the same array, in the
    // same order, with nothing added and nothing dropped.
    const before = [...delegatedChatAllowedToolNames()];
    const after = before.filter(
      (name) =>
        isDelegatedChatMcpToolAllowed(name) &&
        declarationPermitsDelegatedChat(resolveDelegatedChatClass(name, undefined)),
    );
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("cannot admit anything the host refuses — it is consulted strictly after admission", () => {
    // The shim is a name→class map with no view of admission, so the guarantee
    // has to come from the ORDER its callers apply it in. Mirrored here: a
    // denied family, a denied verb and an unlisted name all lose at step one,
    // and it makes no difference that step two would have had an opinion.
    for (const name of ["permissions_grant_list", "objects_delete", "acme_widget_catalog_list"]) {
      expect(isDelegatedChatMcpToolAllowed(name)).toBe(false);
      expect(interimDelegatedChatClassFor(name)).toBeUndefined();
    }
  });

  it("never overrides a REAL declaration, in either direction", () => {
    const admitted = delegatedChatAllowedToolNames()[0]!;
    expect(interimDelegatedChatClassFor(admitted)).toBeTruthy();
    // A registration that declines wins over the shim's class...
    expect(resolveDelegatedChatClass(admitted, "none")).toBe("none");
    expect(declarationPermitsDelegatedChat(resolveDelegatedChatClass(admitted, "none"))).toBe(
      false,
    );
    // ...and so does a registration that declares a DIFFERENT eligible class.
    expect(resolveDelegatedChatClass(admitted, "dispatch")).toBe("dispatch");
  });

  it("keeps the proposal override enumerated SEPARATELY from the exact allowlist", () => {
    // The override is admitted ABOVE the destructive-verb backstop and stays
    // its own audited exception (the describe above pins the policy half). The
    // shim mirrors that split in its source: `dashboards_create` carries a
    // denied verb token and is classified only because the override admits it,
    // while a sibling name with the same token is neither admitted nor covered.
    expect(interimDelegatedChatClassFor("dashboards_create")).toBe("dispatch");
    expect(isDelegatedChatMcpToolAllowed("acme_thing_create")).toBe(false);
    expect(interimDelegatedChatClassFor("acme_thing_create")).toBeUndefined();
  });
});

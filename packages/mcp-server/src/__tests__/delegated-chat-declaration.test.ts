import { describe, it, expect } from "vitest";
import {
  DELEGATED_CHAT_TOOL_CLASSES,
  declarationPermitsDelegatedChat,
  normalizeDelegatedChatToolClass,
  readDeclaredDelegatedChatClass,
  type DelegatedChatToolClass,
} from "../delegated-chat-tool-policy";
import { planPrimitiveRegistration } from "../capability-plan";
import {
  HOST_PRIMITIVE_OWNER_PACKAGE,
  HOST_PRIMITIVE_RELEASE_VERSION,
} from "../host-primitive-identity";
import { evaluateDelegatedChatAdmission } from "../delegated-chat-evaluator";
import {
  coreDelegatedChatAdmissionSnapshot,
  coreDelegatedChatAdmittedNames,
  isCoreDelegatedChatAdmitted,
} from "../core-delegated-chat-surface";
import { hostDeclaredDelegatedChatClass } from "../host-primitive-declarations";

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
  // The composition the runtime actually applies, mirrored EXACTLY: plan the
  // registration (which resolves the declaration in force and the owning
  // identity), then run the shared evaluator over it. That is what the
  // registration choke point, the call-time guard and the self-invoker all do,
  // so the assertions below are statements about the runtime rather than about
  // a re-implementation of it.
  //
  // The snapshot is the CORE one, so "admitted" here means "this build's
  // migrated core admissions admit it" — the same substitution the projection
  // makes, and the reason an unlisted connector name is refused below.
  const registrable = (name: string, config: unknown): boolean =>
    evaluateDelegatedChatAdmission(
      planPrimitiveRegistration({
        name,
        config,
        order: 0,
        host: {
          packageName: HOST_PRIMITIVE_OWNER_PACKAGE,
          version: HOST_PRIMITIVE_RELEASE_VERSION,
        },
      }),
      coreDelegatedChatAdmissionSnapshot(),
    ).allowed;

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

  it("SELF-CLASSIFICATION grants nothing — declaring `read` on an unreviewed name loses", () => {
    // The heart of the issue's first refusal case. Nothing has been reviewed
    // for this primitive, so the only classification in existence is the
    // registration's own — and that is not a review.
    expect(registrable("acme_widget_catalog_list", { delegatedChat: "read" })).toBe(false);
    const decision = evaluateDelegatedChatAdmission(
      planPrimitiveRegistration({
        name: "acme_widget_catalog_list",
        config: { delegatedChat: "read" },
        order: 0,
        host: {
          packageName: HOST_PRIMITIVE_OWNER_PACKAGE,
          version: HOST_PRIMITIVE_RELEASE_VERSION,
        },
      }),
      coreDelegatedChatAdmissionSnapshot(),
    );
    expect(decision).toEqual({ allowed: false, reason: "self_classified_only" });
  });

  it("DOES narrow: `none` removes a name the host would otherwise admit", () => {
    const admitted = coreDelegatedChatAdmittedNames()[0]!;
    expect(admitted).toBeTruthy();
    expect(registrable(admitted, undefined)).toBe(true);
    expect(registrable(admitted, { delegatedChat: "none" })).toBe(false);
    expect(registrable(admitted, { delegatedChat: "nonsense" })).toBe(false);
    // Re-declaring the SAME class the host declares is a no-op; re-declaring a
    // DIFFERENT one changes the digest and misses the reviewed record.
    expect(registrable(admitted, { delegatedChat: hostDeclaredDelegatedChatClass(admitted) })).toBe(
      true,
    );
  });

  it("a RE-DECLARED class misses the reviewed record — an admission does not follow a change", () => {
    const admitted = coreDelegatedChatAdmittedNames().find(
      (n) => hostDeclaredDelegatedChatClass(n) === "read",
    )!;
    expect(admitted).toBeTruthy();
    expect(registrable(admitted, { delegatedChat: "read" })).toBe(true);
    // Same name, same owner, same version — a different declaration. The digest
    // moves, so the review that approved `read` does not carry over.
    expect(registrable(admitted, { delegatedChat: "discovery" })).toBe(false);
  });

  it("the whole CORE surface stays admitted when nothing declares at registration", () => {
    // Behaviour-identity proof for the current tree. No core module declares in
    // its own config, and a missing declaration means NONE — so this would go
    // to `[]` if the host did not declare FOR its own primitives. It holds
    // because it does, and because those declarations are what the migrated
    // admission records were written against.
    const names = [...coreDelegatedChatAdmittedNames()];
    expect(names.filter((n) => registrable(n, undefined))).toEqual(names);
    expect(names.filter((n) => registrable(n, { title: n, description: n }))).toEqual(names);
  });

  it("a name the host does NOT declare for is withdrawn, not defaulted", () => {
    const uncovered = "acme_widget_catalog_list";
    expect(hostDeclaredDelegatedChatClass(uncovered)).toBeUndefined();
    expect(registrable(uncovered, undefined)).toBe(false);
  });
});

describe("declaration: the proposal override stays a SEPARATE audited exception", () => {
  it("is not collapsed into the `dispatch` class", () => {
    // The override remains its own mechanism, accepted ABOVE the verb backstop,
    // which no declaration can reproduce: declaring `dispatch` on a non-override
    // name that carries a denied verb token still loses.
    expect(coreDelegatedChatAdmittedNames()).toContain("dashboards_create");
    // It survives BECAUSE the override lets it past the backstop — "create" is
    // a denied verb token — and then because it is admitted like anything else.
    expect(isCoreDelegatedChatAdmitted("dashboards_create")).toBe(true);
    // A sibling name carrying the same verb token, absent from the override, is
    // refused no matter what it declares.
    expect(isCoreDelegatedChatAdmitted("acme_thing_create")).toBe(false);
    for (const cls of DELEGATED_CHAT_TOOL_CLASSES) {
      expect(
        isCoreDelegatedChatAdmitted("acme_thing_create") &&
          declarationPermitsDelegatedChat(cls as DelegatedChatToolClass),
      ).toBe(false);
    }
  });
});

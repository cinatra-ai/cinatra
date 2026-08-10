// The `cwu_` scope + audience vocabulary (cinatra#2574, epic #2564 S8a).
//
// This module decides, for every widget session, what the session is allowed to
// reach. Its whole job is to be boring and total: a set parser that never
// throws, a mint that derives the audience from the grant so the two cannot
// drift, and an admission test that is exact membership and nothing cleverer.

import { describe, expect, it } from "vitest";

import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";
import {
  WIDGET_CONSENT_GRANTED_SCOPES,
  WIDGET_EXTENSION_SCOPES,
  WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
  formatTokenSet,
  grantedExtensionScopesFromScopeColumn,
  isKnownWidgetExtensionScope,
  isValidTokenSetAtom,
  mintWidgetTokenAudience,
  mintWidgetTokenScope,
  normalizeExtensionScopes,
  parseTokenSet,
  tokenAudienceAdmits,
  tokenSetHas,
  widgetConsentRequestId,
  widgetUserBaseScope,
} from "@/lib/widget-lifecycle-scope";

describe("the set codec", () => {
  it("parses the single-value rows minted before the vocabulary existed", () => {
    expect(parseTokenSet("wordpress-content-editor.user")).toEqual([
      "wordpress-content-editor.user",
    ]);
    expect(parseTokenSet(WIDGET_BROKER_ROUTE_PATH)).toEqual([WIDGET_BROKER_ROUTE_PATH]);
  });

  it("never throws, and a malformed column grants nothing", () => {
    for (const raw of [null, undefined, 42, {}, "", "   ", "\n\t"]) {
      expect(parseTokenSet(raw)).toEqual([]);
      expect(tokenSetHas(raw, "anything")).toBe(false);
    }
  });

  it("admits by EXACT membership — never prefix, never substring", () => {
    const set = "a.read b.read";
    expect(tokenSetHas(set, "a.read")).toBe(true);
    expect(tokenSetHas(set, "a.rea")).toBe(false);
    expect(tokenSetHas(set, "a")).toBe(false);
    expect(tokenSetHas(set, "a.read b.read")).toBe(false);
    expect(tokenSetHas(set, "")).toBe(false);
  });

  it("formats deduplicated and order-stable", () => {
    expect(formatTokenSet(["b", "a", "b", " a ", ""])).toBe("b a");
  });
});

describe("the grant vocabulary", () => {
  it("knows only the scopes it declares", () => {
    expect(isKnownWidgetExtensionScope(WIDGET_LIFECYCLE_READ_SCOPE)).toBe(true);
    expect(isKnownWidgetExtensionScope("lifecycle.decide")).toBe(false);
    expect(isKnownWidgetExtensionScope("toString")).toBe(false); // no prototype hits
    expect(isKnownWidgetExtensionScope(null)).toBe(false);
  });

  it("drops unknown entries instead of carrying them", () => {
    expect(normalizeExtensionScopes(["nope", WIDGET_LIFECYCLE_READ_SCOPE, "nope"])).toEqual([
      WIDGET_LIFECYCLE_READ_SCOPE,
    ]);
    expect(normalizeExtensionScopes(undefined)).toEqual([]);
    expect(normalizeExtensionScopes("lifecycle.read" as never)).toEqual([]);
  });

  it("gives every consented scope a consent sentence — a grant cannot be silent", () => {
    for (const scope of WIDGET_CONSENT_GRANTED_SCOPES) {
      const entry = WIDGET_EXTENSION_SCOPES[scope];
      expect(entry).toBeDefined();
      expect(entry.consentCopy.trim().length).toBeGreaterThan(20);
    }
  });
});

describe("the mint", () => {
  it("a session with NO grant mints exactly the pre-#2574 pair", () => {
    expect(mintWidgetTokenScope("wordpress-content-editor", [])).toBe(
      "wordpress-content-editor.user",
    );
    expect(mintWidgetTokenAudience([])).toBe(WIDGET_BROKER_ROUTE_PATH);
  });

  it("the lifecycle grant adds its scope AND its audience together", () => {
    const scope = mintWidgetTokenScope("wordpress-content-editor", [
      WIDGET_LIFECYCLE_READ_SCOPE,
    ]);
    const aud = mintWidgetTokenAudience([WIDGET_LIFECYCLE_READ_SCOPE]);
    expect(tokenSetHas(scope, widgetUserBaseScope("wordpress-content-editor")!)).toBe(true);
    expect(tokenSetHas(scope, WIDGET_LIFECYCLE_READ_SCOPE)).toBe(true);
    expect(tokenSetHas(aud, WIDGET_BROKER_ROUTE_PATH)).toBe(true);
    expect(tokenSetHas(aud, WIDGET_LIFECYCLE_READ_ROUTE_PATH)).toBe(true);
  });

  it("an unknown grant unlocks no scope and no audience", () => {
    expect(mintWidgetTokenScope("wordpress-content-editor", ["lifecycle.decide"])).toBe(
      "wordpress-content-editor.user",
    );
    expect(mintWidgetTokenAudience(["lifecycle.decide"])).toBe(WIDGET_BROKER_ROUTE_PATH);
  });

  it("the chat audience is in EVERY token — a grant never costs the base surface", () => {
    for (const granted of [[], [WIDGET_LIFECYCLE_READ_SCOPE], ["unknown"]]) {
      expect(tokenSetHas(mintWidgetTokenAudience(granted), WIDGET_BROKER_ROUTE_PATH)).toBe(
        true,
      );
    }
  });

  it("reads back only the grants it knows", () => {
    expect(
      grantedExtensionScopesFromScopeColumn(
        `wordpress-content-editor.user ${WIDGET_LIFECYCLE_READ_SCOPE} superuser`,
      ),
    ).toEqual([WIDGET_LIFECYCLE_READ_SCOPE]);
    expect(grantedExtensionScopesFromScopeColumn("wordpress-content-editor.user")).toEqual(
      [],
    );
  });

  // codex round 0, finding 3 — the set encoding IS the whitespace, so a value
  // carrying any is not one member but several. An agent slug that would smuggle
  // a capability in beside itself must not be encodable at all.
  it("refuses to encode an agent slug that is not ONE set member", () => {
    for (const slug of [
      "wordpress lifecycle.read x",
      "wordpress\tlifecycle.read",
      "wordpress\nlifecycle.read",
      "",
      "   ",
      "wp;drop",
      `wordpress${" "}`, // a trailing space is a second (empty) member
      `wp${String.fromCharCode(0)}`, // a control character is not a member at all
    ]) {
      expect(widgetUserBaseScope(slug)).toBeNull();
      expect(mintWidgetTokenScope(slug, [])).toBeNull();
      expect(mintWidgetTokenScope(slug, [WIDGET_LIFECYCLE_READ_SCOPE])).toBeNull();
    }
    expect(widgetUserBaseScope("wordpress-content-editor")).toBe(
      "wordpress-content-editor.user",
    );
    expect(isValidTokenSetAtom("a".repeat(300))).toBe(false);
  });

  it("pins the length boundary the `.user` suffix implies (codex round 1)", () => {
    // The atom cap is 256 and the suffix costs 5, so the longest expressible
    // agent slug is 251 characters. Pinned so it is a documented boundary rather
    // than an undiscovered one — the real slugs are short kebab-case literals.
    expect(widgetUserBaseScope("a".repeat(251))).toBe(`${"a".repeat(251)}.user`);
    expect(widgetUserBaseScope("a".repeat(252))).toBeNull();
  });
});

// codex round 0, finding 4 — raw audience membership is not authority. The
// admission test re-derives the surface from what the token demonstrably
// carries, so it is the INTERSECTION of the minted set and this build's
// vocabulary, never the union.
describe("the audience admission test", () => {
  const base = "wordpress-content-editor.user";

  it("always admits the chat route (every token's reason to exist)", () => {
    expect(tokenAudienceAdmits(base, WIDGET_BROKER_ROUTE_PATH, WIDGET_BROKER_ROUTE_PATH)).toBe(
      true,
    );
  });

  it("admits a declared surface only when the token also carries its scope", () => {
    const audBoth = `${WIDGET_BROKER_ROUTE_PATH} ${WIDGET_LIFECYCLE_READ_ROUTE_PATH}`;
    expect(
      tokenAudienceAdmits(
        `${base} ${WIDGET_LIFECYCLE_READ_SCOPE}`,
        audBoth,
        WIDGET_LIFECYCLE_READ_ROUTE_PATH,
      ),
    ).toBe(true);
    // The audience alone is not enough — a row whose scope was stripped, or a
    // hand-written audience, buys nothing.
    expect(tokenAudienceAdmits(base, audBoth, WIDGET_LIFECYCLE_READ_ROUTE_PATH)).toBe(false);
  });

  it("refuses a surface this build cannot justify from a KNOWN scope", () => {
    expect(
      tokenAudienceAdmits(
        `${base} future.scope`,
        `${WIDGET_BROKER_ROUTE_PATH} /api/future/surface`,
        "/api/future/surface",
      ),
    ).toBe(false);
  });

  it("still requires the route to be in the stored set", () => {
    expect(
      tokenAudienceAdmits(
        `${base} ${WIDGET_LIFECYCLE_READ_SCOPE}`,
        WIDGET_BROKER_ROUTE_PATH,
        WIDGET_LIFECYCLE_READ_ROUTE_PATH,
      ),
    ).toBe(false);
  });
});

// codex round 0, finding 1 — a consent screen may only authorize the sentences
// it displayed. The bound request id is what makes that true across builds.
describe("the consent binding", () => {
  it("changes with the displayed scope set, so an old screen cannot pick up a new grant", () => {
    const none = widgetConsentRequestId("txn-1", []);
    const withRead = widgetConsentRequestId("txn-1", [WIDGET_LIFECYCLE_READ_SCOPE]);
    expect(none).not.toBe(withRead);
    // Stable for the same inputs (the token is signed over it on the GET and
    // recomputed on the POST).
    expect(widgetConsentRequestId("txn-1", [WIDGET_LIFECYCLE_READ_SCOPE])).toBe(withRead);
    // And still transaction-bound.
    expect(widgetConsentRequestId("txn-2", [WIDGET_LIFECYCLE_READ_SCOPE])).not.toBe(withRead);
  });

  it("is stable under ORDERING and duplication — only membership moves it", () => {
    // codex round 1: a set is a set. Reordering the constant must not invalidate
    // every consent screen currently on someone's monitor.
    expect(widgetConsentRequestId("t", ["b", "a"])).toBe(
      widgetConsentRequestId("t", ["a", "b"]),
    );
    expect(widgetConsentRequestId("t", ["a", "a"])).toBe(widgetConsentRequestId("t", ["a"]));
    expect(widgetConsentRequestId("t", ["a", "b"])).not.toBe(
      widgetConsentRequestId("t", ["a"]),
    );
  });
});

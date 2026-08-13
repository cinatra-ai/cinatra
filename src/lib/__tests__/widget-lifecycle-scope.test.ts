// The `cwu_` scope + audience vocabulary (cinatra#2574, epic #2564 S8a).
//
// This module decides, for every widget session, what the session is allowed to
// reach. Its whole job is to be boring and total: a set parser that never
// throws, a mint that derives the audience from the grant so the two cannot
// drift, and an admission test that is exact membership and nothing cleverer.

import { describe, expect, it } from "vitest";

import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";
import {
  WIDGET_DISPLAYED_SCREEN_PREFIX,
  WIDGET_NO_SIGNIN_SCREEN_PREFIX,
  WIDGET_SIGNIN_GRANTED_SCOPES,
  WIDGET_SIGNIN_SCREEN_UNCLASSIFIED,
  displayedScopesAgree,
  isNoSignInScreenToken,
  widgetDisplayedScopesToken,
  widgetNoSignInScreenToken,
  WIDGET_EXTENSION_SCOPES,
  WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH,
  WIDGET_LIFECYCLE_DECIDE_SCOPE,
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
    // cinatra#2575 (corrected 2026-08-11) — the DECIDE grant now exists, so the
    // widget can decide from its own review card. Its unknown-scope role in this
    // assertion is taken over by a name this build genuinely does not declare.
    expect(isKnownWidgetExtensionScope(WIDGET_LIFECYCLE_DECIDE_SCOPE)).toBe(true);
    expect(isKnownWidgetExtensionScope("lifecycle.administer")).toBe(false);
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

  it("gives every granted scope a sentence — a grant cannot be silent", () => {
    // cinatra#2631: the sentence now lives on the SIGN-IN screen, because
    // signing in is the grant. The invariant is unchanged — a scope in the
    // granted set must carry copy a person can read.
    for (const scope of WIDGET_SIGNIN_GRANTED_SCOPES) {
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

  it("the DECIDE grant adds its scope AND the ONE decision endpoint together", () => {
    // cinatra#2575 (corrected): the widget decides through the SAME
    // `/api/lifecycle-views/decide` the first-party review card posts to — there
    // is no widget-only decision endpoint, and no confirmation surface.
    const scope = mintWidgetTokenScope("wordpress-content-editor", [
      WIDGET_LIFECYCLE_DECIDE_SCOPE,
    ]);
    const aud = mintWidgetTokenAudience([WIDGET_LIFECYCLE_DECIDE_SCOPE]);
    expect(tokenSetHas(scope, WIDGET_LIFECYCLE_DECIDE_SCOPE)).toBe(true);
    expect(tokenSetHas(aud, WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH)).toBe(true);
    expect(WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH).toBe("/api/lifecycle-views/decide");
  });

  it("a sign-in grants BOTH lifecycle scopes — reading and deciding, as in the app", () => {
    expect([...WIDGET_SIGNIN_GRANTED_SCOPES].sort()).toEqual([
      WIDGET_LIFECYCLE_DECIDE_SCOPE,
      WIDGET_LIFECYCLE_READ_SCOPE,
    ]);
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
    expect(mintWidgetTokenScope("wordpress-content-editor", ["lifecycle.administer"])).toBe(
      "wordpress-content-editor.user",
    );
    expect(mintWidgetTokenAudience(["lifecycle.administer"])).toBe(WIDGET_BROKER_ROUTE_PATH);
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

// cinatra#2631 — THE CONSENT-BINDING SUITE IS DELETED, NOT MOVED.
//
// It used to live here: `widgetConsentRequestId` folded the scope set a consent
// screen DISPLAYED into the id its single-use CSRF token was signed over, so a
// screen rendered by an older build could not submit against a newer action and
// record a grant whose sentence was never shown (codex round 0, finding 1).
//
// The owner ruled the consent screen out: signing in IS the grant. With no
// second screen and no submission there is no displayed-set-versus-recorded-set
// gap left to close, so the mechanism and its tests are removed rather than kept
// as coverage of a surface that no longer exists. What replaced them is
// structural: the grant has one source (the server constant), and
// `src/app/widget-auth/__tests__/no-signin-interstitial.test.ts` fails if a step
// between the sign-in and the return ever reappears.

// cinatra#2631 (codex rework round 0, finding 1) — the sign-in screen and the
// action that records the grant are two requests, and mid-rollout they can be
// two BUILDS. This token is what lets them be compared.
describe("the displayed-scope token", () => {
  it("moves with MEMBERSHIP and not with order or duplication", () => {
    expect(widgetDisplayedScopesToken(["b", "a"])).toBe(
      widgetDisplayedScopesToken(["a", "b"]),
    );
    expect(widgetDisplayedScopesToken(["a", "a"])).toBe(widgetDisplayedScopesToken(["a"]));
    expect(widgetDisplayedScopesToken(["a", "b"])).not.toBe(
      widgetDisplayedScopesToken(["a"]),
    );
    // An empty screen is a REAL record, not an empty string: it is written in
    // the same `(screen:...)` form as any other (round 8, finding 1).
    expect(widgetDisplayedScopesToken([])).toBe(`${WIDGET_DISPLAYED_SCREEN_PREFIX})`);
  });

  it("is written in a form a build without the ARRIVAL binding REFUSES", () => {
    // codex rework round 8, finding 1. The record is only as good as the reader
    // enforcing the nonce that names whose arrival it was. A build that knows
    // `displayed_scopes` but not `screen_nonce_hash` compares for exact equality
    // against a BARE token set — so writing the record wrapped means that build
    // refuses everything this one writes, and the one deploy that closes the
    // round-7 exploit cannot reopen it on the nodes still running the old code.
    const record = widgetDisplayedScopesToken(WIDGET_SIGNIN_GRANTED_SCOPES);
    const bare = formatTokenSet([...WIDGET_SIGNIN_GRANTED_SCOPES].sort());
    expect(record).toBe(`${WIDGET_DISPLAYED_SCREEN_PREFIX}${bare})`);
    expect(record).not.toBe(bare);
    // ...and the mirror: a BARE record, written by such a build, is refused HERE,
    // so the window fails closed in both directions.
    expect(displayedScopesAgree(bare, WIDGET_SIGNIN_GRANTED_SCOPES)).toBe(false);
    // The two wrappers are distinct and neither is a prefix of the other, so a
    // displayed set can never read as a no-screen claim or the reverse.
    expect(isNoSignInScreenToken(record)).toBe(false);
    expect(record.startsWith(WIDGET_NO_SIGNIN_SCREEN_PREFIX)).toBe(false);
    expect(
      widgetNoSignInScreenToken("a".repeat(32)).startsWith(WIDGET_DISPLAYED_SCREEN_PREFIX),
    ).toBe(false);
  });

  it("agrees only with the same set", () => {
    const shown = widgetDisplayedScopesToken([WIDGET_LIFECYCLE_READ_SCOPE]);
    expect(displayedScopesAgree(shown, [WIDGET_LIFECYCLE_READ_SCOPE])).toBe(true);
    expect(displayedScopesAgree(shown, [])).toBe(false);
    expect(displayedScopesAgree(shown, [WIDGET_LIFECYCLE_READ_SCOPE, "future.scope"])).toBe(
      false,
    );
  });

  it("admits a SENTINEL that names the session asking — and only that session", () => {
    // The person already had a session and saw no sign-in screen. That is the
    // stated gap of the design; this helper must not refuse a flow that never
    // displayed one. But "no screen rendered" is a fact about ONE arrival: a
    // sentinel earned by somebody else's session says nothing about this caller
    // (codex rework round 5, finding 1), so it refuses.
    const mine = widgetNoSignInScreenToken("a".repeat(32));
    const theirs = widgetNoSignInScreenToken("b".repeat(32));
    expect(mine).not.toBe(theirs);
    expect(displayedScopesAgree(mine, WIDGET_SIGNIN_GRANTED_SCOPES, mine)).toBe(true);
    expect(displayedScopesAgree(mine, [], mine)).toBe(true);
    expect(displayedScopesAgree(theirs, WIDGET_SIGNIN_GRANTED_SCOPES, mine)).toBe(false);
    expect(displayedScopesAgree(theirs, [], mine)).toBe(false);
    // A caller that cannot name its own session admits NO sentinel at all.
    expect(displayedScopesAgree(mine, WIDGET_SIGNIN_GRANTED_SCOPES)).toBe(false);
    expect(displayedScopesAgree(mine, WIDGET_SIGNIN_GRANTED_SCOPES, "")).toBe(false);
    // A bare prefix, or a hand-made lookalike, is a no-screen claim nobody can
    // match — never a displayed set that could be compared instead.
    for (const forged of ["(no-screen)", "(no-screen:)", `${WIDGET_NO_SIGNIN_SCREEN_PREFIX})`]) {
      expect(displayedScopesAgree(forged, WIDGET_SIGNIN_GRANTED_SCOPES, mine)).toBe(false);
      expect(displayedScopesAgree(forged, [], mine)).toBe(false);
    }
    // The token can never BE a displayed set: it is not a well-formed set
    // member, so no scope this build could grant can spell it.
    expect(isNoSignInScreenToken(mine)).toBe(true);
    expect(isNoSignInScreenToken(widgetDisplayedScopesToken(WIDGET_SIGNIN_GRANTED_SCOPES))).toBe(
      false,
    );
    expect(isValidTokenSetAtom(mine)).toBe(false);
    expect(isKnownWidgetExtensionScope(mine)).toBe(false);
    for (const scope of WIDGET_SIGNIN_GRANTED_SCOPES) {
      expect(isValidTokenSetAtom(scope)).toBe(true);
    }
  });

  it("builds NO token from a fingerprint it cannot trust", () => {
    // Empty in, empty out — and an empty token is one no consumer will match, so
    // a caller that could not identify its session neither writes nor admits a
    // sentinel.
    for (const bad of ["", "   ", "not-hex", "abc", "A".repeat(32), "a".repeat(200)]) {
      expect(widgetNoSignInScreenToken(bad)).toBe("");
    }
    expect(widgetNoSignInScreenToken("f".repeat(32))).toBe(
      `${WIDGET_NO_SIGNIN_SCREEN_PREFIX}${"f".repeat(32)})`,
    );
  });

  it("REFUSES null — a transaction that predates the mechanism knows nothing", () => {
    // codex rework round 2, finding 2: NULL is not evidence of anything. Reading
    // it as "no screen" would admit exactly the cross-build mismatch this
    // comparison exists to catch, so it fails closed.
    for (const unknown of [undefined, null]) {
      expect(displayedScopesAgree(unknown, WIDGET_SIGNIN_GRANTED_SCOPES)).toBe(false);
      expect(displayedScopesAgree(unknown, [])).toBe(false);
    }
  });

  it("does NOT confuse an empty screen with no screen", () => {
    // A screen that rendered and named no extra grants is a real screen. If this
    // build would record one, they disagree — that is the rollout window in the
    // add-a-grant direction, and it must fail closed.
    expect(displayedScopesAgree("", WIDGET_SIGNIN_GRANTED_SCOPES)).toBe(false);
    expect(displayedScopesAgree("   ", WIDGET_SIGNIN_GRANTED_SCOPES)).toBe(false);
    // ...and when this build grants nothing extra either, they agree — but only
    // through the RECORD form. A bare empty string is what a build without the
    // arrival binding would have written, and it is refused (round 8, finding 1).
    expect(displayedScopesAgree(widgetDisplayedScopesToken([]), [])).toBe(true);
    expect(displayedScopesAgree("", [])).toBe(false);
  });

  it("REFUSES the UNCLASSIFIED value — created saying nothing, and still saying nothing", () => {
    // codex rework round 3, finding 1. This is the value the MIXED-VERSION window
    // leaves behind: a new node created the transaction, an older node rendered
    // its legacy signed-out page and recorded nothing, and the person read none
    // of the sentences this build would grant. It is the absence of knowledge,
    // exactly like NULL, so it fails closed in both directions.
    expect(
      displayedScopesAgree(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED, WIDGET_SIGNIN_GRANTED_SCOPES),
    ).toBe(false);
    expect(displayedScopesAgree(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED, [])).toBe(false);
    // ...and it is a value no screen and no grant could ever spell, so nothing
    // can arrive at it by accident.
    expect(isNoSignInScreenToken(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED)).toBe(false);
    expect(isValidTokenSetAtom(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED)).toBe(false);
    expect(isKnownWidgetExtensionScope(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED)).toBe(false);
  });
});


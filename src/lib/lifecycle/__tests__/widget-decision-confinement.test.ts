import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// cinatra#2575 (epic #2564 S8b) — the STRUCTURAL half of the widget decision
// path: the confinement between the BROKER surface and the SESSION surface, and
// the "one decision module" pin the epic's whole safety story rests on.
//
// A behavioural suite can only prove that the paths it thought to try are shut.
// These assertions are over the SOURCES, so a later edit that opens a cookie
// branch on the broker endpoint, or that gives the widget its own decide
// implementation, fails here rather than shipping.
//
// The four properties:
//
//   1. ONE DECISION MODULE. Exactly three production modules call
//      `submitReviewDecisionAction`, and the broker route is one of them. None
//      of them writes a gate, a CAS or an audit row itself.
//   2. THE BROKER ENDPOINTS READ NO COOKIE. Neither names a session module. A
//      route that could fall back to an ambient Cinatra session would decide as
//      whoever is signed in on that browser — which, on a public CMS page, is
//      not the person the widget authenticated.
//   3. THE CONFIRMATION PAGE IS THE OPPOSITE. It reads the session and holds NO
//      broker credential: it is the one surface in this slice a `cwu_` may not
//      reach, which is exactly what makes it something the site cannot perform.
//   4. THE GUARD ALLOWLIST SAYS SO TOO. The two broker endpoints are reachable
//      without a cookie (they self-authorize); the confirmation page is NOT, so
//      a sessionless visitor is sent to the ordinary sign-in and back.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

function source(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** The module's CODE, with comments stripped — these files necessarily NAME in
 * prose the things they must not reach. */
function code(rel: string): string {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

const BROKER_DECIDE_ROUTE = "src/app/api/lifecycle-views/broker-decide/route.ts";
const CAPABILITY_REQUEST_ROUTE = "src/app/api/lifecycle-views/action-capability/route.ts";
const CONFIRM_PAGE = "src/app/widget-decision/page.tsx";
const CONFIRM_ACTION = "src/app/widget-decision/actions.ts";
const CONFIRM_CLIENT = "src/components/widget-decision/widget-decision-confirm.tsx";
const WIDGET_TEXT = "src/components/widget-decision/widget-decision-text.tsx";
const GUARD = "src/lib/auth-route-guard.ts";
const CAPABILITY_CODEC = "src/lib/lifecycle/widget-action-capability.ts";
const CAPABILITY_STORE = "src/lib/lifecycle/widget-action-capability-store.ts";

/** Anything that turns a Cinatra COOKIE into a principal. */
const SESSION_MODULES = ["getAuthSession", "requireActorContext", "auth-session", "next/headers"];

/** Anything that turns a BROKER credential into a principal. */
const BROKER_AUTH_MODULES = [
  "widget-user-auth",
  "widget-token-broker",
  "widget-stream-auth",
  "widget-lifecycle-actor",
  "X-Cinatra-Widget-User-Token",
];

describe("ONE decision module (cinatra#2575 / epic #2564)", () => {
  const CALLERS = [
    // The review page's route-bound action wrapper.
    "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
    // The first-party gate-scoped card entry (S2).
    "src/app/api/lifecycle-views/decide/route.ts",
    // The widget entry (S8b) — this slice's whole addition.
    BROKER_DECIDE_ROUTE,
  ];

  it("exactly these production modules call the decision helper", () => {
    // Walked rather than hand-checked, so a fourth caller cannot appear quietly.
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(path.join(ROOT, dir))) {
        if (entry === "node_modules" || entry === "__tests__" || entry === ".next") continue;
        const rel = `${dir}/${entry}`;
        if (statSync(path.join(ROOT, rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) continue;
        // The DEFINITION is not a call site, and neither is prose about it —
        // the comment strip is what keeps a header sentence naming the helper
        // from reading as a fourth entry.
        if (rel.endsWith("/review/[reviewTaskId]/actions.ts")) continue;
        if (code(rel).includes("submitReviewDecisionAction")) found.push(rel);
      }
    };
    walk("src");
    expect(found.sort()).toEqual([...CALLERS].sort());
  });

  it("no entry writes a gate, a CAS or a decision record of its own", () => {
    for (const rel of CALLERS) {
      const src = code(rel);
      for (const forbidden of [
        "commitReviewDecision",
        "artifactReviewGates",
        "suggestionDecisionLedger",
        "suggestionApplicationOutbox",
        "logAuditEvent",
      ]) {
        expect(src, `${rel} :: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the broker route reaches the decision lane through the SAME modules the first-party path does", () => {
    // Whatever the widget entry imports from the decision lane, the first-party
    // entry or the one decision helper imports too. A widget-ONLY decision
    // import would be the first step of a parallel path.
    const brokerImports = [...code(BROKER_DECIDE_ROUTE).matchAll(/from "([^"]+)"/g)].map(
      (m) => m[1],
    );
    const decisionLane = brokerImports.filter(
      (spec) => spec.includes("review") || spec.includes("artifact-review"),
    );
    expect(decisionLane.length).toBeGreaterThan(0);
    const firstParty =
      code("src/app/api/lifecycle-views/decide/route.ts") +
      code("src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions.ts");
    for (const spec of decisionLane) {
      expect(firstParty, spec).toContain(spec);
    }
  });
});

describe("the broker endpoints read no cookie", () => {
  it.each([
    ["broker decide", BROKER_DECIDE_ROUTE],
    ["capability request", CAPABILITY_REQUEST_ROUTE],
  ])("the %s route names no session module", (_label, rel) => {
    const src = source(rel);
    for (const sessionModule of SESSION_MODULES) {
      expect(src, `${rel} :: ${sessionModule}`).not.toContain(sessionModule);
    }
  });

  it("the broker decide route reads NO identifier from the request except its two credentials", () => {
    const src = code(BROKER_DECIDE_ROUTE);
    // No query string is read at all — a static route segment with no params.
    expect(src).not.toContain("searchParams");
    expect(src).not.toContain("params");
    // And the body carries no gate: the run and the gate come from the seal.
    expect(src).toContain("capability.runId");
    expect(src).toContain("capability.reviewTaskId");
    expect(src).toContain("capability.disposition");
    expect(src).not.toContain("parsed.data.ref");
    expect(src).not.toContain("parsed.data.disposition");
  });

  it("the capability NEVER travels in a URL — header only", () => {
    for (const rel of [BROKER_DECIDE_ROUTE, CAPABILITY_CODEC, CONFIRM_CLIENT]) {
      const src = code(rel);
      expect(src, rel).not.toMatch(/searchParams\.set\(|encodeURIComponent\(\s*capability/);
    }
    expect(code(BROKER_DECIDE_ROUTE)).toContain("ACTION_CAPABILITY_HEADER");
  });

  it("the capability is delivered ONLY to an opener on this page's own origin", () => {
    const src = code(CONFIRM_CLIENT);
    expect(src).toContain("window.location.origin");
    // Never a wildcard, and never a server-supplied target.
    expect(src).not.toContain('"*"');
    expect(src).not.toContain("siteOrigin");
  });
});

describe("the confirmation surface is the SESSION surface", () => {
  it("the page and its action read the session and hold no broker credential", () => {
    // Over the CODE: both files necessarily explain in prose what they must not
    // reach ("the widget's `cwu_` bearer is not what authorizes anything here"),
    // and a raw substring test would fail on the very sentence stating it.
    for (const rel of [CONFIRM_PAGE, CONFIRM_ACTION]) {
      expect(code(rel), rel).toContain("getAuthSession");
      for (const brokerModule of BROKER_AUTH_MODULES) {
        expect(code(rel), `${rel} :: ${brokerModule}`).not.toContain(brokerModule);
      }
      expect(code(rel), rel).not.toContain("cwu_");
    }
  });

  it("the page NAMES its subject — a confirmation window that cannot is substitutable", () => {
    // codex round 0, finding 1. The site holds the widget bearer, so it can ask
    // for a capability on any gate the person may read and open this window
    // itself. The subject line is what lets the person notice.
    const src = code(CONFIRM_PAGE);
    expect(src).toContain("row.subjectLabel");
    // ...and the gate-derived reference code a decoy with the same title cannot
    // match (codex round 1, finding 2).
    expect(src).toContain("reviewReferenceCode(row.runId, row.reviewTaskId)");
    // ...and the WHOLE rationale, never an excerpt (round 1, finding 1). Both
    // adversarial strings are handed to the module that owns their layout
    // contract, rather than being marked up inline where the next edit would
    // not inherit it.
    expect(src).toContain("WidgetDecisionSubject");
    expect(src).toContain("WidgetDecisionRationale");
    expect(src).toContain("row.commentText");
    expect(src).not.toContain("slice(0,");
    // ...laid out in full, with NO inner scroll region (round 2). A scrolled box
    // keeps the exploit one level down: filler pushes the ending out of view
    // while Confirm stays reachable. Reaching the button must mean scrolling
    // past the message, which is only true when the message is on the page.
    expect(src).not.toContain("overflow-y-auto");
    expect(src).not.toContain("max-h-");
  });

  it("BOTH adversarial strings WRAP — an unbroken run may not be clipped sideways", () => {
    // The horizontal residual of round 2, found by the coordinator's layout
    // verification. `whitespace-pre-wrap` alone wraps only at spaces and
    // newlines, so a single unbroken run extends horizontally; the app's global
    // `html { overflow-x: hidden }` then CLIPS the suffix instead of letting the
    // page scroll to it, while Confirm stays reachable. Same exploit as round 2,
    // rotated ninety degrees.
    //
    // BOTH strings, not just the message (codex wrap-round 1, finding 1). The
    // SUBJECT is built from artifact titles the requester chose and capped at
    // 400 characters, and it is this window's primary defence against a
    // substituted gate — clipping its distinguishing suffix defeats the one
    // affordance it exists to provide, so it is the worse of the two.
    const src = code(WIDGET_TEXT);

    const classNames = [...src.matchAll(/className="([^"]*)"/g)].map((m) => m[1]!);
    // Both surfaces are present and nothing crept in unpinned.
    expect(src).toContain("WidgetDecisionSubject");
    expect(src).toContain("WidgetDecisionRationale");
    expect(classNames).toHaveLength(2);

    // The class contract cannot be sidestepped by a route this assertion cannot
    // read (codex wrap-round 1, finding 2). A classless wrapper carrying inline
    // `style={{ maxHeight, overflowY }}` would reintroduce round 2's scroll box
    // while every className below still passed, and `dangerouslySetInnerHTML`
    // would let markup set its own geometry. Neither belongs in a module whose
    // only job is displaying somebody else's text, so both are refused outright.
    expect(src).not.toMatch(/\bstyle=/);
    expect(src).not.toContain("dangerouslySetInnerHTML");

    for (const className of classNames) {
      // EVERY element here wraps — which is also what keeps this module
      // leaf-only, since a layout wrapper could not honestly carry it.
      //
      // Specifically `wrap-anywhere` (`overflow-wrap: anywhere`) and not
      // `break-words` (`overflow-wrap: break-word`). The difference is
      // load-bearing, not cosmetic: per CSS Text, only `anywhere`'s break
      // opportunities count toward MIN-CONTENT intrinsic size. These paragraphs
      // are grid items, so their default `min-width: auto` floors them at
      // min-content — under `break-words` the unbroken run still widens the
      // track and still overflows. A future "simplification" to `break-words`
      // therefore reopens the defect, so the utility is named here rather than
      // merely implied.
      expect(className).toContain("wrap-anywhere");
      expect(className).not.toContain("break-words");

      // ...and NOTHING here may hide characters, in either axis. Each pattern
      // below reintroduces the same class of defect by a different route: a
      // scroll/clip region or a cap re-hides an ending, a clamp or an ellipsis
      // silently drops one, and `nowrap`/`break-normal` would defeat the wrap.
      //
      // Matched per TOKEN, not as a substring: `shadow-sm` contains "w-" and
      // `line-height` contains "h-", so a substring test would reject harmless
      // styling and get itself weakened by the next person to hit it. Utility
      // variants (`sm:`, `dark:`) are stripped so a capped breakpoint cannot
      // slip past by wearing a prefix.
      const FORBIDDEN = [
        /^-?overflow(-[xy])?-/, // any scroll/hidden/clip region, either axis
        /^-?max-[hw]-/, // a cap re-hides what round 2 unhid
        /^truncate$/,
        /^text-ellipsis$/,
        /^line-clamp-/,
        /^whitespace-nowrap$/,
        /^text-nowrap$/,
        /^break-normal$/, // would defeat `wrap-anywhere`
      ];
      for (const token of className.split(/\s+/).filter(Boolean)) {
        const utility = token.split(":").pop()!;
        for (const pattern of FORBIDDEN) {
          expect(utility, `className token "${token}"`).not.toMatch(pattern);
        }
      }
    }
  });

  it("NEITHER widget endpoint accepts a per-item suggestion partition", () => {
    // Also codex round 0, finding 1: this window cannot render suggestion
    // labels, so binding a partition would authorize invisible per-item choices.
    // Asserted over the CODE, so the prose explaining the choice does not
    // satisfy the test that enforces it.
    for (const rel of [BROKER_DECIDE_ROUTE, CAPABILITY_REQUEST_ROUTE, CAPABILITY_CODEC]) {
      expect(code(rel), rel).not.toContain("suggestionDecisions");
    }
    // ...and both schemas are `.strict()`, so sending one is a 400 rather than a
    // silently dropped field.
    for (const rel of [BROKER_DECIDE_ROUTE, CAPABILITY_REQUEST_ROUTE]) {
      expect(code(rel), rel).toContain(".strict()");
    }
  });

  it("the page MUTATES nothing — the single-use confirm lives behind the action", () => {
    const src = code(CONFIRM_PAGE);
    expect(src).toContain("readActionCapabilityRequest");
    expect(src).not.toContain("confirmActionCapability");
    expect(src).not.toContain("mintActionCapability");
  });

  it("only the confirmation action can mint a capability", () => {
    const minters: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(path.join(ROOT, dir))) {
        if (entry === "node_modules" || entry === "__tests__" || entry === ".next") continue;
        const rel = `${dir}/${entry}`;
        if (statSync(path.join(ROOT, rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) continue;
        if (rel === CAPABILITY_CODEC) continue; // the definition
        if (readFileSync(path.join(ROOT, rel), "utf8").includes("mintActionCapability")) {
          minters.push(rel);
        }
      }
    };
    walk("src");
    expect(minters).toEqual([CONFIRM_ACTION]);
  });

  it("only the broker decide route can burn one", () => {
    const burners: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(path.join(ROOT, dir))) {
        if (entry === "node_modules" || entry === "__tests__" || entry === ".next") continue;
        const rel = `${dir}/${entry}`;
        if (statSync(path.join(ROOT, rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) continue;
        if (rel === CAPABILITY_STORE) continue; // the definition
        if (readFileSync(path.join(ROOT, rel), "utf8").includes("consumeActionCapability")) {
          burners.push(rel);
        }
      }
    };
    walk("src");
    expect(burners).toEqual([BROKER_DECIDE_ROUTE]);
  });
});

describe("the route guard agrees with the design", () => {
  const guard = source(GUARD);

  it("both broker endpoints are reachable without a cookie", () => {
    expect(guard).toContain('"/api/lifecycle-views/action-capability",');
    expect(guard).toContain('"/api/lifecycle-views/broker-decide",');
  });

  it("the confirmation page is NOT — a sessionless visitor signs in first", () => {
    // The whole point: this window is something only the PERSON can complete.
    expect(guard).not.toContain('"/widget-decision"');
  });

  it("the first-party lifecycle endpoints stay cookie-session only", () => {
    expect(guard).not.toContain('"/api/lifecycle-views/resolve",');
    expect(guard).not.toContain('"/api/lifecycle-views/decide",');
  });
});

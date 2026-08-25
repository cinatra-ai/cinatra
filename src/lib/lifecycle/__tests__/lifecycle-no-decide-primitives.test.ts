// STRUCTURAL: the model may PRESENT a lifecycle interaction and may never
// RESOLVE one (cinatra#2567, epic #2564 S3 — "the AI only shows and proposes").
//
// This is the test the epic's safety claim rests on, so it is deliberately not
// a hand-kept list of tool names. It reads the GENERATED authz inventory — the
// machine-scanned record of every primitive that actually exists anywhere in
// the tree, extensions included — and asserts that no lifecycle DECIDE/MUTATE
// primitive is reachable on EITHER delegated perimeter:
//
//   · `delegated-chat`   — a chat user's on-behalf-of token (this slice's
//                          surface);
//   · `delegated-widget` — a public-site widget's on-behalf-of token, for both
//                          bound kinds. Since cinatra#2577 (S8d) that perimeter
//                          reaches the three READ-ONLY pull primitives and
//                          nothing else, which this file now asserts in both
//                          directions too.
//
// It fails in BOTH directions on purpose: a new `*_decide`/`*_approve` style
// lifecycle primitive that slipped onto a policy fails here, and so does a
// regression that quietly withdraws the three read-only pull primitives from
// chat. The second direction matters because a silent withdrawal presents as
// "the assistant stopped finding my reviews", which reads like a model problem
// rather than a policy edit.
//
// ---------------------------------------------------------------------------
// THE RULE IS REWRITTEN, NOT WEAKENED (cinatra#2932, lifecycle-b W5a).
//
// From the plan (PLAN: Agents Lifecycle (B), section 4):
//
//   "This is the one deliberate exception to the rule that the assistant never
//    operates a lifecycle decision. It exists only for the card you have
//    explicitly bound, and the written rule and its tests are rewritten openly
//    to name the exception where it is enforced — so the guarantee that chat
//    never decides on its own stands whole and stays readable."
//
// So the rule now reads: THE MODEL MAY PRESENT A LIFECYCLE INTERACTION, AND MAY
// RESOLVE ONE ONLY THROUGH `lifecycle_bound_card_decide`, ONLY WITH A
// SERVER-MINTED SINGLE-USE GRANT FOR THE CARD THE PERSON BOUND AND THE ONE
// CONTROL IT NAMES.
//
// THE SCANNER IS NOT EXEMPTED, and that is the whole point of how this file
// changed. The exception is not a name added to an ignore list: the primitive is
// still scanned, still classified as a lifecycle DECISION by the same
// family+verb rules as everything else, and still has to be enumerated here by
// name. What changed is that the expected reachable set now HAS one decision
// primitive in it, and this file additionally asserts WHERE that exception is
// enforced — the handler refuses without a grant — so "reachable" and
// "permitted" stay two different things in the test as well as in the code.
//
// A SECOND DECISION PRIMITIVE STILL FAILS HERE. The set below is exact, so
// anything else that carries a lifecycle name and a decision verb onto either
// delegated policy fails exactly as it did before.
// ---------------------------------------------------------------------------
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isDelegatedChatMcpToolAllowed } from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";
import {
  isDelegatedWidgetMcpToolAllowed,
  type WidgetDelegationKind,
} from "@cinatra-ai/mcp-server/delegated-widget-tool-policy";
// The exception's own module: the name it registers under, and the two fixed
// refusals its handler answers with. Imported so this file names the SAME
// strings the enforcement point uses rather than three literals that can drift.
import {
  LENT_ACTION_NO_AUTHORITY,
  LENT_ACTION_PRIMITIVE,
} from "../lent-action-mcp";

const INVENTORY_PATH = resolve(
  __dirname,
  "../../authz/__generated__/inventory.json",
);

function inventoryPrimitiveNames(): string[] {
  const parsed = JSON.parse(readFileSync(INVENTORY_PATH, "utf8")) as {
    primitives: { primitiveName: string }[];
  };
  return [...new Set(parsed.primitives.map((p) => p.primitiveName))].sort();
}

const WIDGET_KINDS: WidgetDelegationKind[] = ["wordpress", "drupal"];

/** The lifecycle surface, by name family. */
const LIFECYCLE_FAMILY = [
  "artifact_review",
  "review_gate",
  "verification_record",
  "verification_summary",
  "recommendation_hold",
  "trigger_schedule",
  "lifecycle_",
  "gate_suggestion",
  // cinatra#2569's proposal producer. It is a lifecycle card producer and must
  // be scanned as one, even though its name mentions neither "trigger" nor
  // "lifecycle" — the name was chosen precisely to avoid a denied verb token,
  // so this family entry is what keeps it inside the scan rather than outside it.
  "schedule_proposal",
] as const;

/**
 * The DECISION class: resolving an interaction rather than showing it.
 * Whole-underscore-token matching, mirroring the policy's own backstop — so
 * `artifact_review_gates_list` (tokens "gates", "list") is not caught by
 * `gate`, and `approvals_list` is not caught by `approve`.
 */
const DECISION_VERBS = new Set([
  "decide",
  "approve",
  "reject",
  "resume",
  "confirm",
  "arm",
  "create",
  "update",
  "delete",
  "write",
  "publish",
  "cancel",
  "stop",
  "skip",
  "apply",
  "submit",
  "commit",
  "emit",
  "set",
]);

function isLifecycleName(name: string): boolean {
  return LIFECYCLE_FAMILY.some((family) => name.includes(family));
}

function carriesDecisionVerb(name: string): boolean {
  return name.split("_").some((token) => DECISION_VERBS.has(token));
}

/** Names that must NEVER be reachable, whether or not they exist today. */
const FORBIDDEN_LIFECYCLE_NAMES = [
  "artifact_review_gate_decide",
  "artifact_review_gate_approve",
  "artifact_review_gate_reject",
  "artifact_review_gate_comment_submit",
  "artifact_review_gate_resume",
  "verification_record_approve",
  "recommendation_hold_confirm",
  "recommendation_hold_skip",
  "trigger_schedule_proposal_confirm",
  "trigger_schedule_arm",
  "lifecycle_gate_decide",
];

describe("no lifecycle decide/mutate primitive is reachable from a delegated perimeter", () => {
  it("the ONLY chat-reachable lifecycle decision primitive is the named exception", () => {
    const reachable = inventoryPrimitiveNames()
      .filter((name) => isLifecycleName(name) && carriesDecisionVerb(name))
      .filter((name) => isDelegatedChatMcpToolAllowed(name));
    // Exactly one, by name. Anything else that reaches this list is the
    // regression this file has always existed to catch.
    expect(reachable).toEqual([LENT_ACTION_PRIMITIVE]);
  });

  it("the generated inventory contains no widget-reachable lifecycle DECISION primitive", () => {
    // The same rule as chat, now that S8d (cinatra#2577) gave the widget the
    // full read set: what may never be reachable on EITHER perimeter is the
    // DECIDE class. The read set itself is pinned by the parity test below.
    const reachable = inventoryPrimitiveNames()
      .filter((name) => isLifecycleName(name) && carriesDecisionVerb(name))
      .filter((name) => WIDGET_KINDS.some((k) => isDelegatedWidgetMcpToolAllowed(k, name)));
    // The same one exception, for the epic's parity reason: a person does the
    // same things inside a third-party application as in the app, and the
    // deciding authority there is built fresh from the widget's own credential.
    expect(reachable).toEqual([LENT_ACTION_PRIMITIVE]);
  });

  it("the widget's reachable lifecycle set EQUALS chat's — parity, both directions", () => {
    // THE CORRECTED CONTRACT (owner ruling 2026-08-11). Read off the
    // machine-scanned inventory rather than a hand-kept list, and compared
    // against CHAT rather than against literals, so BOTH failure directions are
    // caught: a primitive that lands on the widget policy alone, and a primitive
    // chat gains that the widget is quietly denied.
    const chatReachable = inventoryPrimitiveNames()
      .filter(isLifecycleName)
      .filter((name) => isDelegatedChatMcpToolAllowed(name))
      .sort();
    for (const kind of WIDGET_KINDS) {
      const widgetReachable = inventoryPrimitiveNames()
        .filter(isLifecycleName)
        .filter((name) => isDelegatedWidgetMcpToolAllowed(kind, name))
        .sort();
      expect(widgetReachable, kind).toEqual(chatReachable);
    }
  });

  it("that shared set is the four READ-ONLY pulls plus the ONE named exception", () => {
    // The parity assertion above says "the same"; this one says "the same WHAT".
    // Together they are the whole rule: the person sees everything on every
    // surface, and the AI transport resolves nothing on any of them EXCEPT the
    // one bound-card control the person's own message lent it, once.
    const chatReachable = inventoryPrimitiveNames()
      .filter(isLifecycleName)
      .filter((name) => isDelegatedChatMcpToolAllowed(name))
      .sort();
    expect(chatReachable).toEqual([
      "artifact_review_gate_render",
      "artifact_review_gates_list",
      // THE ONE EXCEPTION, in its alphabetical place rather than tucked away.
      LENT_ACTION_PRIMITIVE,
      "schedule_proposal_render",
      "verification_record_render",
    ]);
  });

  for (const name of FORBIDDEN_LIFECYCLE_NAMES) {
    it(`${name} is refused by BOTH delegated policies`, () => {
      expect(isDelegatedChatMcpToolAllowed(name), `chat: ${name}`).toBe(false);
      for (const kind of WIDGET_KINDS) {
        expect(isDelegatedWidgetMcpToolAllowed(kind, name), `${kind}: ${name}`).toBe(
          false,
        );
      }
    });
  }

  it("refuses the class BY CONSTRUCTION — the verb backstop, not just the allowlist", () => {
    // The allowlist alone would already deny these (deny-by-default). The point
    // of the backstop is that ADDING one to the allowlist is not enough to
    // expose it, so a future edit cannot open the class with a one-line change.
    for (const verb of ["decide", "approve", "reject", "resume", "confirm", "arm"]) {
      expect(
        isDelegatedChatMcpToolAllowed(`artifact_review_gate_${verb}`),
        verb,
      ).toBe(false);
    }
  });
});

describe("the exception is named WHERE IT IS ENFORCED, not merely allowed", () => {
  // Reaching a tool is not permission to use it. The policy edits above make the
  // primitive VISIBLE; what makes it safe is the grant its handler demands, and
  // the rule is only honestly rewritten if this file says so and checks it.

  it("the primitive's own name declares the class it belongs to", () => {
    // Deliberately NOT a name chosen to slip past the verb backstop: it carries
    // `decide`, so it is denied by construction and had to be admitted by an
    // explicit, disclosed override in BOTH policies.
    expect(LENT_ACTION_PRIMITIVE.split("_")).toContain("decide");
  });

  it("the handler refuses when the request frame carries NO grant", async () => {
    // The enforcement point, exercised. A model that can SEE the tool and calls
    // it with a well-formed argument gets nothing: no grant on the frame, no
    // action, and the fixed sentence back.
    vi.resetModules();
    vi.doMock("@cinatra-ai/mcp-server", () => ({
      mcpRequestContextStorage: {
        getStore: () => ({ userId: "usr_1", orgId: "org_1" }),
      },
    }));
    vi.doMock("@cinatra-ai/agents/review-task-actions", () => ({
      approveReviewTaskInternal: vi.fn(),
    }));
    vi.doMock(
      "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions",
      () => ({ submitReviewDecisionAction: vi.fn() }),
    );
    vi.doMock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
      enforceReviewRunAccess: vi.fn(),
      readGatePinnedTargets: vi.fn(),
    }));
    vi.doMock("@cinatra-ai/agents/store", () => ({
      readLatestDurableHitlGateArtifact: vi.fn(),
    }));
    vi.doMock("@cinatra-ai/agents/db", () => ({ agentBuilderPool: { query: vi.fn() } }));
    const mod = await import("../lent-action-mcp");
    const out = await mod.handleLentAction({ ref: "anything", control: "approve" });
    expect(out.structuredContent).toEqual({
      ok: false,
      message: LENT_ACTION_NO_AUTHORITY,
    });
    vi.resetModules();
  });

  it("the typed CarveOut twin exists at the delegated-chat boundary", () => {
    // The policy override and the typed record are kept in lockstep by the authz
    // inventory coverage suite; this assertion is here so the RULE'S own file
    // states that the exception is written down in the authorization record too,
    // not only in a transport allowlist.
    const source = readFileSync(
      resolve(__dirname, "../../authz/carve-out.ts"),
      "utf8",
    );
    expect(source).toContain(LENT_ACTION_PRIMITIVE);
  });
});

describe("the read-only pull primitives are reachable from BOTH delegated perimeters", () => {
  const PULL_PRIMITIVES = [
    "artifact_review_gates_list",
    "artifact_review_gate_render",
    "verification_record_render",
    // cinatra#2577 corrected: the widget reaches the schedule proposal too. It
    // CREATES NOTHING — it mints an expiring proposal and returns a card
    // envelope; only the person's own Confirm, a browser session action with no
    // transport-reachable primitive behind it, arms anything.
    "schedule_proposal_render",
  ];

  for (const name of PULL_PRIMITIVES) {
    it(`${name} is callable from chat and from either widget kind`, () => {
      // cinatra#2577 (S8d). Reaching the tool is not reading a row: these
      // handlers resolve their own principal from the request frame — for a
      // widget frame that means the signed `lifecycle.read` grant plus a live
      // standing resolution — and refuse generically otherwise.
      expect(isDelegatedChatMcpToolAllowed(name)).toBe(true);
      for (const kind of WIDGET_KINDS) {
        expect(isDelegatedWidgetMcpToolAllowed(kind, name), kind).toBe(true);
      }
    });
  }

  it("every pull primitive actually EXISTS in the generated inventory", () => {
    const names = new Set(inventoryPrimitiveNames());
    for (const name of PULL_PRIMITIVES) expect(names.has(name), name).toBe(true);
  });

  it("and so does the ONE exception — it is scanned, never exempted", () => {
    // The machine-scanned record is the thing this whole file rests on. A
    // primitive registered under a CONSTANT instead of a literal would be
    // invisible to the scanner, which is how an exception quietly stops being
    // one; asserting its presence keeps that door shut.
    expect(new Set(inventoryPrimitiveNames()).has(LENT_ACTION_PRIMITIVE)).toBe(true);
  });
});

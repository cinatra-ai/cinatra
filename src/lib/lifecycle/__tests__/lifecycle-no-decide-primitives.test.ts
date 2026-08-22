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
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isCoreDelegatedChatAdmitted } from "@cinatra-ai/mcp-server/core-delegated-chat-surface";
import {
  isDelegatedWidgetMcpToolAllowed,
  type WidgetDelegationKind,
} from "@cinatra-ai/mcp-server/delegated-widget-tool-policy";

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
  it("the generated inventory contains no chat-reachable lifecycle decision primitive", () => {
    const reachable = inventoryPrimitiveNames()
      .filter((name) => isLifecycleName(name) && carriesDecisionVerb(name))
      .filter((name) => isCoreDelegatedChatAdmitted(name));
    expect(reachable).toEqual([]);
  });

  it("the generated inventory contains no widget-reachable lifecycle DECISION primitive", () => {
    // The same rule as chat, now that S8d (cinatra#2577) gave the widget the
    // full read set: what may never be reachable on EITHER perimeter is the
    // DECIDE class. The read set itself is pinned by the parity test below.
    const reachable = inventoryPrimitiveNames()
      .filter((name) => isLifecycleName(name) && carriesDecisionVerb(name))
      .filter((name) => WIDGET_KINDS.some((k) => isDelegatedWidgetMcpToolAllowed(k, name)));
    expect(reachable).toEqual([]);
  });

  it("the widget's reachable lifecycle set EQUALS chat's — parity, both directions", () => {
    // THE CORRECTED CONTRACT (owner ruling 2026-08-11). Read off the
    // machine-scanned inventory rather than a hand-kept list, and compared
    // against CHAT rather than against literals, so BOTH failure directions are
    // caught: a primitive that lands on the widget policy alone, and a primitive
    // chat gains that the widget is quietly denied.
    const chatReachable = inventoryPrimitiveNames()
      .filter(isLifecycleName)
      .filter((name) => isCoreDelegatedChatAdmitted(name))
      .sort();
    for (const kind of WIDGET_KINDS) {
      const widgetReachable = inventoryPrimitiveNames()
        .filter(isLifecycleName)
        .filter((name) => isDelegatedWidgetMcpToolAllowed(kind, name))
        .sort();
      expect(widgetReachable, kind).toEqual(chatReachable);
    }
  });

  it("that shared set is exactly the four READ-ONLY pulls — nothing that resolves an interaction", () => {
    // The parity assertion above says "the same"; this one says "the same WHAT".
    // Together they are the whole rule: the person sees everything on every
    // surface, and the AI transport resolves nothing on any of them.
    const chatReachable = inventoryPrimitiveNames()
      .filter(isLifecycleName)
      .filter((name) => isCoreDelegatedChatAdmitted(name))
      .sort();
    expect(chatReachable).toEqual([
      "artifact_review_gate_render",
      "artifact_review_gates_list",
      "schedule_proposal_render",
      "verification_record_render",
    ]);
  });

  for (const name of FORBIDDEN_LIFECYCLE_NAMES) {
    it(`${name} is refused by BOTH delegated policies`, () => {
      expect(isCoreDelegatedChatAdmitted(name), `chat: ${name}`).toBe(false);
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
        isCoreDelegatedChatAdmitted(`artifact_review_gate_${verb}`),
        verb,
      ).toBe(false);
    }
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
      expect(isCoreDelegatedChatAdmitted(name)).toBe(true);
      for (const kind of WIDGET_KINDS) {
        expect(isDelegatedWidgetMcpToolAllowed(kind, name), kind).toBe(true);
      }
    });
  }

  it("every pull primitive actually EXISTS in the generated inventory", () => {
    const names = new Set(inventoryPrimitiveNames());
    for (const name of PULL_PRIMITIVES) expect(names.has(name), name).toBe(true);
  });
});

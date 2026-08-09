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
//                          bound kinds (S8d's surface; nothing lifecycle is
//                          enabled there yet, and that is asserted too).
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

import { isDelegatedChatMcpToolAllowed } from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";
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
      .filter((name) => isDelegatedChatMcpToolAllowed(name));
    expect(reachable).toEqual([]);
  });

  it("the generated inventory contains no widget-reachable lifecycle primitive at all", () => {
    // Stricter than the chat rule by design: the widget's closed, kind-keyed
    // allowlist holds only its CMS-edit primitive. Lifecycle READS arrive there
    // with S8d (#2572) plus its own enablement; the DECIDE class never does.
    const reachable = inventoryPrimitiveNames()
      .filter(isLifecycleName)
      .filter((name) => WIDGET_KINDS.some((k) => isDelegatedWidgetMcpToolAllowed(k, name)));
    expect(reachable).toEqual([]);
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

describe("the read-only pull primitives are reachable from chat only", () => {
  const PULL_PRIMITIVES = [
    "artifact_review_gates_list",
    "artifact_review_gate_render",
    "verification_record_render",
  ];

  for (const name of PULL_PRIMITIVES) {
    it(`${name} is chat-callable and widget-denied`, () => {
      expect(isDelegatedChatMcpToolAllowed(name)).toBe(true);
      for (const kind of WIDGET_KINDS) {
        expect(isDelegatedWidgetMcpToolAllowed(kind, name)).toBe(false);
      }
    });
  }

  it("every pull primitive actually EXISTS in the generated inventory", () => {
    const names = new Set(inventoryPrimitiveNames());
    for (const name of PULL_PRIMITIVES) expect(names.has(name), name).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { isDelegatedChatMcpToolAllowed } from "../delegated-chat-tool-policy";
import {
  DELEGATED_WIDGET_BOUND_CARD_ACTION,
  DELEGATED_WIDGET_NAMED_AGENT_START,
  DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS,
  carriesDelegatedWidgetDeniedVerb,
  delegatedWidgetAllowedToolNames,
  isDelegatedWidgetMcpToolAllowed,
  type WidgetDelegationKind,
} from "../delegated-widget-tool-policy";

// S5-W1 §4.1 / §5 — the CLOSED, KIND-KEYED `public_site_widget` tool policy.
// Covers the T3 (blast radius) and T4 (kind binding / G9) negative contract,
// and — since cinatra#2577 (epic #2564 S8d) — the ONE widening: the three
// read-only lifecycle pull primitives, and nothing that resolves a lifecycle
// interaction.

const KINDS: WidgetDelegationKind[] = ["wordpress", "drupal"];

/**
 * Every lifecycle PULL primitive the platform registers — the union both
 * delegated perimeters are compared against. Literal names on purpose: this file
 * is the drift detector, so it must not read its expectation from either policy.
 */
const LIFECYCLE_PULL_PRIMITIVES = [
  "artifact_review_gates_list",
  "artifact_review_gate_render",
  "verification_record_render",
  "schedule_proposal_render",
] as const;

describe("isDelegatedWidgetMcpToolAllowed — delegated-widget closed policy", () => {
  it("allows ONLY the bound kind's *_content_editor_run (positive)", () => {
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", "wordpress_content_editor_run")).toBe(true);
    expect(isDelegatedWidgetMcpToolAllowed("drupal", "drupal_content_editor_run")).toBe(true);
  });

  it("is EXACT-MATCH (case-sensitive): a non-canonical casing is DENIED", () => {
    // A distinct tool registered with non-canonical casing is a DIFFERENT
    // primitive and must never be treated as the editor by a case-fold collision.
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", "WordPress_Content_Editor_Run")).toBe(false);
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", "WORDPRESS_CONTENT_EDITOR_RUN")).toBe(false);
  });

  // ---- T4: KIND BINDING (G9) — a token can never drive the OTHER kind -------
  it("T4: a wordpress token CANNOT drive drupal_content_editor_run", () => {
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", "drupal_content_editor_run")).toBe(false);
  });

  it("T4: a drupal token CANNOT drive wordpress_content_editor_run", () => {
    expect(isDelegatedWidgetMcpToolAllowed("drupal", "wordpress_content_editor_run")).toBe(false);
  });

  // ---- T3: BLAST RADIUS — every non-editor primitive is denied for a widget
  //          delegation, EVEN ones the broad chat allowlist would permit -------
  it.each([
    // reads/dispatch the delegated-CHAT allowlist permits — all DENIED here.
    "agent_run",
    "agent_list",
    "objects_list",
    "objects_get",
    "wordpress_instances_list",
    "wordpress_posts_list",
    "drupal_instances_list",
    "artifact_authoring_emit",
    "dashboards_cube_load",
    "system_screen_lookup",
    // sibling connector write primitives — DENIED (only *_content_editor_run).
    "wordpress_post_update",
    "wordpress_post_create_draft",
    "wordpress_media_upload",
    "drupal_node_update",
  ])("T3: blast radius — '%s' is DENIED for a wordpress widget delegation", (tool) => {
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", tool)).toBe(false);
  });

  it.each([
    "agent_run",
    "objects_list",
    "drupal_instances_list",
    "drupal_node_update",
    "wordpress_content_editor_run", // the other kind's editor — DENIED (T4).
  ])("T3: blast radius — '%s' is DENIED for a drupal widget delegation", (tool) => {
    expect(isDelegatedWidgetMcpToolAllowed("drupal", tool)).toBe(false);
  });

  it("fail-closed on an unknown kind — denies everything", () => {
    expect(
      // deliberately pass an unknown kind through the typed boundary
      isDelegatedWidgetMcpToolAllowed("mystery" as "wordpress", "wordpress_content_editor_run"),
    ).toBe(false);
    for (const tool of DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS) {
      expect(isDelegatedWidgetMcpToolAllowed("mystery" as "wordpress", tool)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// cinatra#2577 (epic #2564 S8d) — THE WIDENING, AND ITS LIMIT
// ---------------------------------------------------------------------------

describe("S8d — the read-only lifecycle primitives, on BOTH kinds", () => {
  it.each(KINDS)("%s: every pull primitive is allowed", (kind) => {
    for (const tool of DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS) {
      expect(isDelegatedWidgetMcpToolAllowed(kind, tool), tool).toBe(true);
    }
  });

  it("the widget pull set EQUALS the chat pull set — first-party parity, not a subset", () => {
    // THE CORRECTED CONTRACT (cinatra#2577, owner ruling 2026-08-11). The widget
    // reaches every lifecycle pull primitive first-party chat reaches. Asserted
    // as an equality against the CHAT policy's own allowlist rather than a
    // literal list, so a primitive added to chat and forgotten here is a red
    // test instead of a silent widget reduction.
    // Both directions, through the CHAT policy's own predicate:
    //   · everything the widget reaches, chat reaches (no widget-only surface);
    //   · everything chat reaches of this family, the widget reaches (no
    //     widget reduction — the half the correction is about).
    for (const tool of DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS) {
      expect(isDelegatedChatMcpToolAllowed(tool), tool).toBe(true);
    }
    const chatLifecyclePulls = LIFECYCLE_PULL_PRIMITIVES.filter((name) =>
      isDelegatedChatMcpToolAllowed(name),
    );
    expect([...DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS].sort()).toEqual(
      [...chatLifecyclePulls].sort(),
    );
  });

  it("the pull set is EXACTLY the four producer names — no more, no fewer", () => {
    // Pinned against the producers' own registration names. A rename in
    // `lifecycle-pull-mcp.ts` / `schedule-proposal-mcp.ts` without an edit here
    // fails CLOSED (the tool simply stops being reachable from the widget), and
    // this assertion is what turns that silent withdrawal into a red test.
    expect([...DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS].sort()).toEqual([
      "artifact_review_gate_render",
      "artifact_review_gates_list",
      "schedule_proposal_render",
      "verification_record_render",
    ]);
  });

  it.each(KINDS)(
    "%s: the WHOLE declared set is the editor, the reads, the ONE lent action and the ONE start",
    (kind) => {
      // The complete contents, asserted as a set: an addition fails as loudly as
      // a removal, so widening this policy cannot happen quietly.
      //
      // AMENDED for cinatra#2932 (lifecycle-b W5a): exactly one entry is added —
      // the lent action — and the assertion stays exhaustive, so the property
      // this case exists for is intact. The widget has it for the epic's parity
      // rule (a person does the same things inside a third-party application as
      // in the app), and it can do nothing without the message's own
      // server-minted, single-use grant.
      //
      // AMENDED AGAIN for cinatra#2935 (lifecycle-b W5d): exactly one MORE
      // entry — the one narrow start, NAMED here rather than folded into a
      // spread, because "the widget allowlist is byte-identical" was S9f's
      // invariant (cinatra#2790) and this slice is the disclosed exception to
      // it. THE PIN IS RE-TAKEN, not loosened: the assertion is still
      // exhaustive, so a second addition fails as loudly as a removal.
      expect(delegatedWidgetAllowedToolNames(kind)).toEqual(
        [
          `${kind}_content_editor_run`,
          ...DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS,
          DELEGATED_WIDGET_BOUND_CARD_ACTION,
          DELEGATED_WIDGET_NAMED_AGENT_START,
        ].sort(),
      );
    },
  );

  it.each(KINDS)(
    "%s: the ONE start is `agent_named_start`, and it is reachable",
    (kind) => {
      // The entry BY NAME (cinatra#2935 acceptance 3's counterpart: the widening
      // is exactly one grant-gated start, named where it is enforced).
      expect(DELEGATED_WIDGET_NAMED_AGENT_START).toBe("agent_named_start");
      expect(isDelegatedWidgetMcpToolAllowed(kind, DELEGATED_WIDGET_NAMED_AGENT_START)).toBe(true);
    },
  );

  it.each(KINDS)(
    "%s: the start's own verb token is DENIED — the entry is an exception, not a hole",
    (kind) => {
      // `start` is on the backstop as of this slice, so the primitive reaches
      // the widget ONLY through the exact-name exception above. The negative
      // control: a differently-cased name is a DIFFERENT primitive and falls
      // through to the backstop, and so does any other `*_start`.
      expect(carriesDelegatedWidgetDeniedVerb("agent_named_start")).toBe(true);
      expect(isDelegatedWidgetMcpToolAllowed(kind, "Agent_Named_Start")).toBe(false);
      expect(isDelegatedWidgetMcpToolAllowed(kind, "agent_run_start")).toBe(false);
      expect(isDelegatedWidgetMcpToolAllowed(kind, "trigger_schedule_start")).toBe(false);
    },
  );

  it.each(KINDS)(
    "%s: `agent_run` itself stays OFF the widget allowlist (cinatra#2790)",
    (kind) => {
      // THE INVARIANT THIS SLICE DID NOT TOUCH. The chat allowlist holds
      // `agent_run` with its template ids, timeouts and polling surface; the
      // widget's closed set does not, and the one narrow start is deliberately
      // not a second door onto it. Nothing is offered inside a third-party
      // application that the widget's own credential cannot do — acceptance 4.
      expect(isDelegatedWidgetMcpToolAllowed(kind, "agent_run")).toBe(false);
      expect(isDelegatedWidgetMcpToolAllowed(kind, "agent_run_get")).toBe(false);
      expect(isDelegatedChatMcpToolAllowed("agent_run")).toBe(true);
      // And chat does NOT get a second name for a road it already has.
      expect(isDelegatedChatMcpToolAllowed("agent_named_start")).toBe(false);
    },
  );

  it("kind-independence is deliberate: the pulls address no CMS instance", () => {
    // Stated as a test so the asymmetry with the editor primitive is a decision
    // on the record rather than an oversight: the editor is kind-bound (G9)
    // because it writes to a CMS instance; a lifecycle read addresses the
    // caller's own cinatra work through the caller's own standing.
    for (const tool of DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS) {
      expect(isDelegatedWidgetMcpToolAllowed("wordpress", tool)).toBe(true);
      expect(isDelegatedWidgetMcpToolAllowed("drupal", tool)).toBe(true);
    }
  });
});

describe("S8d — no lifecycle DECIDE/MUTATE primitive, by construction", () => {
  const FORBIDDEN = [
    "artifact_review_gate_decide",
    "artifact_review_gate_approve",
    "artifact_review_gate_reject",
    "artifact_review_gate_resume",
    "artifact_review_gate_comment_submit",
    "verification_record_approve",
    "recommendation_hold_confirm",
    "recommendation_hold_skip",
    "trigger_schedule_proposal_confirm",
    "trigger_schedule_arm",
    "lifecycle_gate_decide",
  ];

  it.each(FORBIDDEN)("'%s' is denied for BOTH widget kinds", (tool) => {
    for (const kind of KINDS) {
      expect(isDelegatedWidgetMcpToolAllowed(kind, tool), `${kind}: ${tool}`).toBe(false);
    }
  });

  it("the verb backstop catches the class, not a hand-kept list of names", () => {
    for (const verb of [
      "decide",
      "approve",
      "reject",
      "resume",
      "confirm",
      "arm",
      "create",
      "update",
      "delete",
    ]) {
      expect(carriesDelegatedWidgetDeniedVerb(`artifact_review_gate_${verb}`), verb).toBe(true);
    }
  });

  it("the backstop matches WHOLE tokens — the allowed surface survives it", () => {
    for (const allowed of [
      "wordpress_content_editor_run",
      "drupal_content_editor_run",
      ...DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS,
    ]) {
      expect(carriesDelegatedWidgetDeniedVerb(allowed), allowed).toBe(false);
    }
  });

  // ---- THE NEGATIVE CONTROL --------------------------------------------------
  // The assertions above would all pass against a policy with NO backstop at
  // all, simply because no decide primitive is on the allowlist. That makes them
  // a statement about today's list, not about the rule. So: drive the rule
  // directly against a SYNTHETIC widened policy — the exact one-line edit this
  // test exists to stop — and prove it refuses. If someone deletes the backstop,
  // this is the test that goes red while every list-shaped assertion stays green.
  it("NEGATIVE CONTROL: a decide primitive ADDED to the allowlist is still refused", () => {
    const widened = new Set<string>([
      "wordpress_content_editor_run",
      ...DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS,
      "artifact_review_gate_decide", // the edit under test
    ]);
    // The allowlist alone would say yes …
    expect(widened.has("artifact_review_gate_decide")).toBe(true);
    // … and the rule the real policy applies says no anyway.
    expect(carriesDelegatedWidgetDeniedVerb("artifact_review_gate_decide")).toBe(true);
    // Every legitimate member of that same widened set survives the rule, so the
    // refusal is aimed at the class and not at the set.
    for (const name of widened) {
      if (name === "artifact_review_gate_decide") continue;
      expect(carriesDelegatedWidgetDeniedVerb(name), name).toBe(false);
    }
  });

  // ---- THE WIDGET CANNOT START A RUN AT ALL ---------------------------------
  // Pinned because a neighbouring change now depends on it. `agent_run` learned
  // to PAUSE a chat-started run on the recommendation hold, and the reason no
  // extra guarding was added for the widget is precisely this policy: a widget
  // delegation cannot reach `agent_run`, so a widget-carried run is headless by
  // the closed allowlist rather than by a second check somewhere downstream.
  //
  // That is a real dependency, so it gets a real assertion. If this policy ever
  // admits `agent_run`, the "widget runs stay headless" reasoning stops holding
  // and this test is where that shows up — instead of silently, in a run that
  // parks on a card no widget draws.
  it("REGRESSION: a widget delegation can never reach agent_run, on any kind", () => {
    for (const kind of KINDS) {
      expect(isDelegatedWidgetMcpToolAllowed(kind, "agent_run"), kind).toBe(false);
      expect(delegatedWidgetAllowedToolNames(kind), kind).not.toContain("agent_run");
      // The neighbouring run-lifecycle primitives are refused too, so the
      // refusal is about the run plane and not about one name.
      for (const name of ["agent_run_resume", "agent_run_stop", "agent_run_get"]) {
        expect(isDelegatedWidgetMcpToolAllowed(kind, name), `${kind}/${name}`).toBe(false);
      }
    }
  });

  it("NEGATIVE CONTROL: the set assertion itself fails on an added primitive", () => {
    // The second half of the guarantee. The backstop covers the DECISION class;
    // this covers everything else a widening could add (a connector read, an
    // export, a cross-org lookup) — the declared-contents assertion above is the
    // thing that catches it, and here is the proof that it does.
    const declared = new Set(delegatedWidgetAllowedToolNames("wordpress"));
    const smuggled = new Set([...declared, "objects_list"]);
    expect([...smuggled].sort()).not.toEqual(delegatedWidgetAllowedToolNames("wordpress"));
  });
});

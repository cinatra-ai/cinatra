/**
 * THE SURFACE-MATRIX CONFORMANCE TEST (cinatra#2573, epic #2564 S7).
 *
 * S7's acceptance criterion, verbatim:
 *
 *   "Carrier-run exclusion proven: a widget content-editor carrier run emits no
 *    recommendation hold and no trigger interaction; the surface-matrix
 *    conformance test FAILS if any lifecycle interaction kind appears on a
 *    BROKER surface outside the matrix."
 *
 * WHAT THE MATRIX IS, AFTER THE 2026-08-11 CORRECTION. The epic's per-(kind,
 * host) presence table is gone — every lifecycle card appears on every declared
 * host, because a widget reader is the signed-in person with the rights they
 * have inside Cinatra (`LIFECYCLE_CARD_HOSTS` + `lifecycleViewTypesForHost`).
 * So the matrix that survives has exactly two rows:
 *
 *   HUMAN surfaces   — the four declared `LifecycleCardHost`s. All four
 *                      interaction kinds, all of them, identically.
 *   BROKER surfaces  — the CMS content-editor carrier run. NO interaction kind,
 *                      ever. A carrier run is headless machinery a CMS tool
 *                      dispatched; there is no human in it to answer a card, so
 *                      a card there is not a reduced experience, it is a
 *                      question asked of nobody.
 *
 * WHY A CONFORMANCE TEST AND NOT A REVIEW CONVENTION. "All cells true" is not a
 * rule — it is a place for a future reduction to hide, which is why the removed
 * table was deleted rather than re-valued. What replaces it is this file: the
 * HUMAN row is pinned as a TOTAL equality (a kind quietly withheld from one host
 * fails here), and the BROKER row is pinned at the two independent places a
 * carrier run could grow a card — the run's own `humanPresent` lattice and the
 * widget delegation's MCP allowlist.
 *
 * THE THREE LEGS OF THE BROKER EXCLUSION, and why each is needed on its own:
 *
 *   1. THE RUN. `maybeHoldRunForRecommendation` refuses a run that is not
 *      `humanPresent === true` with `reason: "headless"`, BEFORE any candidate
 *      resolve or park write. Both carrier-run creation sites in
 *      `host-content-editor-dispatch.ts` create their run WITHOUT
 *      `humanPresent`, so the refusal is reached by construction rather than by
 *      configuration. The BEHAVIOURAL half is MAPPED (it is already owned by
 *      `recommendation-hold.test.ts`); what is asserted HERE is the structural
 *      half — the dispatch module cannot hand the evaluator a human-present run,
 *      and nothing that mints a park precedes the refusal. "The field is absent"
 *      is exactly the kind of claim a later edit erases silently.
 *   2. THE TRIGGER. A carrier run has no scheduling path at all: the widget
 *      delegation's tool allowlist holds the CMS content-editor primitive plus
 *      the READ-ONLY lifecycle pulls, and every trigger MUTATION primitive is
 *      denied by name AND by the verb backstop. The schedule PROPOSAL primitive
 *      is reachable (it creates nothing — parity with first-party chat), which
 *      is why leg 3 exists.
 *   3. THE POLICY, TOTALLY. The widget allowlist is asserted as an EXACT set,
 *      so a fifth primitive appearing on the broker surface fails here even if
 *      it carries no denied verb token and even if nobody thought to name it.
 *
 * NEGATIVE CONTROLS. Every exclusion below is paired with a case in which the
 * outcome INVERTS — each kind DOES reach its OWN content-editor primitive, the
 * four read-only pulls DO clear the verb backstop that denies every mutation,
 * and the `humanPresent` guard IS a live discriminator standing in front of the
 * park seam. Without those, a green refusal proves only that nothing tried.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  LIFECYCLE_CARD_HOSTS,
  LIFECYCLE_CARD_KINDS,
  LIFECYCLE_CARD_CARRIAGE,
  LIFECYCLE_DATA_PART_VIEW_TYPES,
  LIFECYCLE_INTERRUPT_KINDS,
  lifecycleViewTypesForHost,
  type LifecycleCardHost,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import {
  DELEGATED_WIDGET_BOUND_CARD_ACTION,
  DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS,
  carriesDelegatedWidgetDeniedVerb,
  delegatedWidgetAllowedToolNames,
  isDelegatedWidgetMcpToolAllowed,
} from "@cinatra-ai/mcp-server/delegated-widget-tool-policy";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/**
 * The BROKER surfaces this matrix knows about — the surfaces on which a
 * lifecycle interaction may never appear. Enumerated (not discovered) on
 * purpose: adding a broker surface is a design decision that belongs in front of
 * a reviewer, and an unenumerated one is caught by the total-allowlist leg.
 */
const BROKER_SURFACES = ["widget_content_editor_carrier_run"] as const;

// ---------------------------------------------------------------------------
// The HUMAN row — total, and total is the point
// ---------------------------------------------------------------------------

describe("the surface matrix — HUMAN surfaces carry every interaction kind", () => {
  it("declares exactly the four hosts and the five interaction kinds", () => {
    expect([...LIFECYCLE_CARD_HOSTS]).toEqual([
      "chat_thread",
      "site_widget",
      "run_card",
      "page_gate_region",
    ]);
    expect([...LIFECYCLE_CARD_KINDS]).toEqual([
      "artifact_review_gate",
      "verification_summary",
      "recommendation_hold",
      "trigger_schedule_proposal",
      // cinatra#2928 (lifecycle-b W2a) — the agent pausing to ask for input.
      // Registered so a run can STATE the moment; drawn by W3 (cinatra#2930).
      "agent_hitl_screen",
    ]);
  });

  it("gives every host the SAME data-part view set — no host is quietly reduced", () => {
    const expected = [...LIFECYCLE_DATA_PART_VIEW_TYPES].sort();
    expect(expected.length).toBeGreaterThan(0);
    for (const host of LIFECYCLE_CARD_HOSTS) {
      expect([...lifecycleViewTypesForHost(host)].sort(), host).toEqual(expected);
    }
  });

  it("covers every kind exactly once across the two carriages — no kind is unreachable", () => {
    const carried = [...LIFECYCLE_DATA_PART_VIEW_TYPES, ...LIFECYCLE_INTERRUPT_KINDS].sort();
    expect(carried).toEqual([...LIFECYCLE_CARD_KINDS].sort());
    for (const kind of LIFECYCLE_CARD_KINDS) {
      // AMENDED BY cinatra#2930 (lifecycle-b W3): the carriage record is two
      // axes. `represent` is the wire one this matrix is about; `canonical`
      // says which fact decides the card is live, and both are closed sets.
      expect(LIFECYCLE_CARD_CARRIAGE[kind].represent, kind).toMatch(
        /^(data_part|interrupt)$/,
      );
      expect(LIFECYCLE_CARD_CARRIAGE[kind].canonical, kind).toMatch(
        /^(run_state|data_part)$/,
      );
    }
  });

  it("NEGATIVE CONTROL: an undeclared host is not a host — the matrix is closed", () => {
    const undeclared = "cms_page_body" as unknown as LifecycleCardHost;
    expect((LIFECYCLE_CARD_HOSTS as readonly string[]).includes(undeclared as string)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The BROKER row, leg 1 — the carrier RUN is headless by construction
// ---------------------------------------------------------------------------

describe("BROKER exclusion, leg 1: a carrier run emits no recommendation hold", () => {
  // The BEHAVIOURAL half of this leg is already proven, and is MAPPED rather
  // than re-derived (S7 never duplicates a proof a slice already owns):
  //   packages/agents/src/__tests__/recommendation-hold.test.ts
  //     · "a HEADLESS run never parks (never evaluates)"
  //     · "a null-presence run (pre-backfill / worker origin) never parks"
  //     · "a HEADLESS run never resolves candidates at all (S3 path byte-unchanged)"
  // What is NOT proven anywhere else, and is proven HERE, is that the CARRIER
  // RUN reaches that refusal BY CONSTRUCTION rather than by configuration —
  // i.e. that the dispatch module cannot hand the evaluator a human-present run.

  it("BY CONSTRUCTION: neither carrier-run creation site sets humanPresent", () => {
    const dispatch = read("src/lib/host-content-editor-dispatch.ts");
    // Both launches in this module create carrier runs. Since cinatra#2929 they
    // go through the coordinator, which DERIVES presence rather than accepting a
    // claim — so the structural guarantee is stronger than it was: the module
    // cannot state `humanPresent` at all, and it hands the coordinator no
    // interactive surface and no frame to derive one from. If a future edit adds
    // either, the run stops being headless and leg 1's refusal stops being
    // structural, so the absence of both is pinned.
    expect(dispatch).toMatch(/launchAgentRun\(/);
    expect(dispatch).not.toMatch(/humanPresent/);
    expect(dispatch).not.toMatch(/interactive:/);
    expect(dispatch).toMatch(/frame:\s*null/);
    // …and both carrier sourceTypes stay the broker discriminators, so the run
    // can never be mistaken for a human-dispatched one downstream.
    expect(dispatch).toMatch(/sourceType:\s*"content_editor_dispatch"/);
    expect(dispatch).toMatch(/sourceType:\s*"public_site_widget"/);
  });

  it("the refusal is the FIRST run-shaped gate in the evaluator — nothing can precede it into a park", () => {
    const hold = read("packages/agents/src/recommendation-hold.ts");
    const headlessAt = hold.indexOf('return { held: false, reason: "headless" }');
    expect(headlessAt).toBeGreaterThan(-1);
    // Everything that could MINT a park must come after the headless refusal.
    for (const later of ["maybeParkCheckpoint", "resolveRecommendationCandidateSkillIds"]) {
      const at = hold.indexOf(later, headlessAt);
      expect(at, later).toBeGreaterThan(headlessAt);
    }
    // NEGATIVE CONTROL: the guard is a real discriminator, not a dead line —
    // the human-present branch is the one that reaches the park seam.
    expect(hold).toMatch(/run\.humanPresent !== true/);
  });
});

// ---------------------------------------------------------------------------
// The BROKER row, legs 2 + 3 — no trigger interaction, and the set is TOTAL
// ---------------------------------------------------------------------------

describe("BROKER exclusion, leg 2: a carrier run has no trigger interaction", () => {
  const kinds = ["wordpress", "drupal"] as const;

  it("no trigger MUTATION primitive is reachable on either widget kind", () => {
    const mutations = [
      "agent_run_trigger_set",
      "agent_run_trigger_clear",
      "trigger_schedule_create",
      "trigger_schedule_delete",
      "agent_run_schedule_arm",
    ];
    for (const kind of kinds) {
      for (const tool of mutations) {
        expect(isDelegatedWidgetMcpToolAllowed(kind, tool), `${kind}/${tool}`).toBe(false);
      }
    }
  });

  it("the verb backstop denies a mutation primitive even if someone allowlists it", () => {
    for (const tool of ["agent_run_trigger_set", "trigger_schedule_create"]) {
      expect(carriesDelegatedWidgetDeniedVerb(tool), tool).toBe(true);
    }
    // NEGATIVE CONTROL: the PROPOSAL primitive carries no denied verb — it
    // creates nothing, which is exactly why parity lets it through.
    for (const tool of DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS) {
      expect(carriesDelegatedWidgetDeniedVerb(tool), tool).toBe(false);
    }
  });
});

describe("BROKER exclusion, leg 3: the broker allowlist is TOTAL", () => {
  it("a widget delegation reaches its OWN content-editor primitive, the read-only pulls and the ONE lent action, and nothing else", () => {
    // AMENDED for cinatra#2932 (lifecycle-b W5a). The set gains exactly one
    // entry — the lent action — and the assertion stays TOTAL, which is the
    // property this case exists for: it is still an exhaustive equality, so a
    // second addition fails here as loudly as the first would have.
    //
    // WHY THE WIDGET HAS IT. The epic's parity rule: a person does the same
    // things inside a third-party application as in the app. Withholding it
    // would not be a safety property — it would be the widget refusing a button
    // the person can see on the card in front of them. Nothing is offered that
    // the widget's own credential cannot do: the deciding authority is built
    // fresh from that credential at the call, and the primitive does NOTHING at
    // all without the message's single-use grant.
    for (const kind of ["wordpress", "drupal"] as const) {
      const allowed = [...delegatedWidgetAllowedToolNames(kind)].sort();
      const expected = [
        `${kind}_content_editor_run`,
        ...DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS,
        DELEGATED_WIDGET_BOUND_CARD_ACTION,
      ].sort();
      expect(allowed, kind).toEqual(expected);
    }
  });

  it("G9: a kind never reaches the OTHER kind's content-editor primitive", () => {
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", "drupal_content_editor_run")).toBe(false);
    expect(isDelegatedWidgetMcpToolAllowed("drupal", "wordpress_content_editor_run")).toBe(false);
    // NEGATIVE CONTROL: each kind DOES reach its own.
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", "wordpress_content_editor_run")).toBe(true);
    expect(isDelegatedWidgetMcpToolAllowed("drupal", "drupal_content_editor_run")).toBe(true);
  });

  it("THE CONFORMANCE CLAUSE: no lifecycle interaction kind appears on a broker surface", () => {
    // The literal criterion. A "lifecycle interaction kind appearing" on the
    // broker surface would mean one of two observable things, and both are
    // checked: a primitive that MINTS that kind's card being reachable, or the
    // kind's own decide/mutate entry being reachable. The read-only pull
    // primitives are neither — they answer refs for rows the caller already
    // may read, and they are the SAME handlers first-party chat calls.
    const mintingOrDecidingPrimitives = [
      "recommendation_hold_confirm",
      "recommendation_hold_skip",
      "artifact_review_gate_decide",
      "lifecycle_gate_decide",
      "schedule_proposal_confirm",
      "verification_summary_decide",
    ];
    for (const surface of BROKER_SURFACES) {
      for (const kind of ["wordpress", "drupal"] as const) {
        for (const tool of mintingOrDecidingPrimitives) {
          expect(
            isDelegatedWidgetMcpToolAllowed(kind, tool),
            `${surface}/${kind}/${tool}`,
          ).toBe(false);
        }
      }
    }
  });
});

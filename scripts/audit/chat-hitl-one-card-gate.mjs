#!/usr/bin/env node
/**
 * ONE CARD PER INTERACTION — the structural gate (cinatra#2573, epic #2564 S7).
 *
 * S7's program-wide acceptance criterion, verbatim:
 *
 *   "EXACTLY ONE card implementation per interaction across /chat, embed/widget,
 *    run card, and the review gate region — the parallel renderers (redirect
 *    card, panel chip-row mount, review-page direct composition) are gone
 *    (grep-gated)."
 *
 * WHY A GATE AND NOT A TEST. The epic's whole thesis is that each lifecycle
 * question is ONE component rendered everywhere, and that the pre-epic world had
 * three look-alikes instead. A look-alike does not announce itself: it is a
 * plausible, well-written second renderer that drifts from the first over a few
 * quarters until two surfaces disagree about what "approved" means. Individual
 * slices proved their own host clean (S2's card suite reads
 * `agentic-run-panel.tsx`, S4's reads the stepper). Nothing read the WHOLE tree,
 * so a fourth host could grow a fourth renderer and every slice suite would stay
 * green. This is that whole-tree read.
 *
 * WHAT IT ENFORCES — four independent rules:
 *
 *   R1 SOLE RENDERER. For each interaction kind, exactly ONE module may DEFINE
 *      the card component, and it is the module named in CARD_OWNERS below.
 *      Anywhere else, declaring a component whose name is that card's — or a
 *      `Prefixed…` look-alike of it — is a violation.
 *
 *   R2 THE RETIRED PARALLELS ARE GONE. The renderers the epic ordered deleted
 *      may not come back, by name (or, for §VII, by anchor):
 *        · the review REDIRECT card (`ArtifactReviewRedirectCard`) — the
 *          display-only "Continue to review" link that sent a reader away;
 *        · a DIRECT `<RunRecommendationChipRow` mount on a lifecycle HOST — the
 *          pre-S4 poll-driven panel mount;
 *        · the review page's DIRECT decision composition — a `<ReviewDecisionBar`
 *          mounted by the page instead of by the card. (Scoped to the BAR: the
 *          page's own ROUTE-LEVEL `ReviewGateBlocked` panel is legitimate and
 *          uses the shipped component — see the entry's own note.)
 *        · the review page's DIRECT §VII composition — `VerificationView`
 *          drawing the verification core itself instead of mounting
 *          `VerificationSummaryCard`. (Scoped to the §VII ANCHORS, not to the
 *          component name: `VerificationView` legitimately survives as the
 *          page's adjunct composition — see the entry's own note.)
 *
 *   R3 EVERY MOUNT IS HOST-DECLARED. A lifecycle card may only be mounted
 *      inside a `LifecycleCardSurfaceProvider` subtree, so the fail-closed host
 *      gate cannot be bypassed by a surface that simply renders the component.
 *      Checked per FILE (a mount and its provider live in one component tree).
 *
 *   R4 ONE REGISTRY ENTRY PER KIND, AND IT NAMES THE OWNER. The renderable-view
 *      component registry maps each lifecycle viewType exactly once, and that
 *      one line must dispatch to the kind's OWNER from `CARD_OWNERS`. A second
 *      dispatch table anywhere is a parallel registry by another name; a row
 *      that still counts as "exactly one" while pointing at a different
 *      component is the retirement quietly undone.
 *
 * WHAT THE COMPLETENESS RULES ADD (the S9 round). R1–R4 answer "is there more
 * than one renderer?". They never answered "is there ONE?" — and that is how a
 * kind with NO drawing passed: two kinds pointed at the S1 shell, and one
 * component serving two kinds reads as "one implementation per interaction" to a
 * duplicate-detector. The rules below close that:
 *
 *   R5 ONE NAMED OWNER PER KIND. Every member of `LIFECYCLE_CARD_KINDS` —
 *      including the typed-INTERRUPT recommendation kind — has its own row in
 *      `LIFECYCLE_CARD_CONTRACTS`, and a DRAWN row names an owner module and a
 *      component that no other kind shares. A kind with no drawing is recorded
 *      as a PLACEHOLDER with a gap sentence: it may not claim an owner, and its
 *      ratified component name may not exist anywhere in the tree (a card that
 *      gets drawn without flipping its row fails here, so the placeholder claim
 *      cannot become a lie in either direction).
 *
 *   R6 THE OWNER CONSUMES ITS AUTHORIZED BODY. The owner reads its kind's
 *      validated body seam and every field the contract lists, and every body
 *      parameter it declares is read in the component. An owner that takes a
 *      body and ignores it is drawing something other than what the server
 *      authorized.
 *
 *   R7 THE OWNER EMITS ITS RATIFIED ANCHOR SET. The anchor set per kind is
 *      CLOSED: it is the ratified list, copied here verbatim, and an anchor an
 *      implementer chose does not satisfy it. Each one is emitted by the owner
 *      or by a module the owner composes, from code that is REACHABLE — an
 *      anchor inside a statically dead branch does not count, and a component
 *      whose only return is `null` emits nothing at all. Every owner ROOT also
 *      carries `data-lifecycle-card-host` and its state, so a card can be
 *      addressed by the host it drew on and the state it drew in.
 *
 *   R8 ONE RENDERED INSTANCE PER KIND × HOST. Not a callsite count: the rule is
 *      that at runtime exactly one instance draws. So every production callsite
 *      is ENUMERATED here, each is HOST-DECLARED, and a host served by more than
 *      one adapter names the selector that picks between them plus the test that
 *      proves the selector covers every branch. A literal one-mount rule would
 *      reject a correct tree — the run card is legitimately served by two
 *      exclusive panels — and a gate that rejects correct trees gets disabled.
 *      A dev-preview adapter is enumerated and marked, never counted as
 *      production and never hidden.
 *
 *   R9 THE RETIRED PARALLEL CORE RENDERERS. The route-bound page drawing of the
 *      §VII reading — the same facts drawn a second time, outside the card — is
 *      banned. S9a (cinatra#2792) shipped that ban as a PENDING RETIREMENT: the
 *      identifier `VerificationView` banned by name, with the two route modules
 *      allowlisted while the verification kind was still a placeholder, and the
 *      record due to die with the slice that drew the card. S9e (cinatra#2789)
 *      IS that slice. The card is DRAWN, the route modules draw none of §VII's
 *      regions any more, the route-module allowlist is empty and the record is
 *      deleted. The ban itself stays and got sharper: it now identifies the
 *      retired drawing by §VII's five REGION ANCHORS rather than by an
 *      identifier, because `VerificationView` legitimately survives as the
 *      page's adjunct composition and a name ban would have banned the right
 *      answer. The whole account lives on the R2 entry, with its history.
 *
 * TWO MODES, and the DEFAULT is the required one:
 *   (no flag) — the DONE check, and the gate this repository runs. Every kind
 *               DRAWN, every host mounted, every ratified anchor emitted and
 *               proven, every open item closed. It fails today and names what is
 *               missing. A gate whose ordinary run passes while two kinds are
 *               placeholders does not "fail on main" in any run anybody makes.
 *   --audit   — the lenient read: every DRAWN kind fully enforced, and the
 *               recorded placeholders and open items tolerated. It answers "did
 *               I add a NEW dishonesty", which is useful to a lane mid-flight
 *               and is not the gate.
 *
 * WHERE THE ANCHOR SETS COME FROM. They are RATIFIED and CLOSED, and this table
 * copies them rather than deriving them. An earlier round of this gate read them
 * off the drawing itself; that reading was replaced by the ratified list, so no
 * slice has to guess and no slice may decide after the fact that whatever it
 * drew was the requirement. Two entries in that list name a control in prose and
 * give it no anchor id. Those are recorded as OPEN ANCHOR NAMES rather than
 * filled in, because filling them in is exactly the implementer choice a closed
 * set forbids, and the done-check stays red until they are named.
 *
 * A PLACEHOLDER'S ANCHOR LIST IS NOT A RATIFICATION, and the difference matters
 * enough to state (cinatra#2861). A PLACEHOLDER row is written by a slice that
 * has not drawn the card: it records what the drawing OWES, in whatever words
 * were available before the body and the DOM existed. That is an obligation, and
 * an obligation can be WRONG about the drawing in a way a ratification cannot —
 * it can paraphrase a body field, or mistake an ARTBOARD id (a marker the design
 * page puts around an example specimen, like `state-loading`) for an anchor the
 * card is supposed to emit. So the slice that draws a placeholder kind re-reads
 * the row against the DRAWING AT THE PIN and records each correction where it
 * occurs, with the drawing sentence it rests on. It is still not free to choose
 * WHICH regions are required — those come from the drawing — only to name a
 * region the drawing ratifies in PROSE and gives no id of its own, in the tree's
 * existing convention. That naming is not new here either: the schedule-proposal
 * row below names two controls on exactly that footing ("ratified in prose and
 * are now named, in the existing verb-object convention"). What stays forbidden
 * is the thing this paragraph opened with — drawing first and calling the result
 * the requirement afterwards.
 *
 * AND WHERE THE TABLE SHAPE COMES FROM. The host-ownership table carries a
 * component-owner column and a wire-carriage column, and each row below carries
 * the same two fields. That is a HAND-KEPT correspondence, and it is stated as
 * one: this gate does NOT read the table, which lives in a document CI cannot
 * open, so nothing here is synchronized with it by any mechanism. What IS
 * mechanical is narrower and worth having on its own: the carriage is checked
 * against the protocol module, so the repository cannot disagree with itself.
 *
 * AN OPEN OBLIGATION is the third recording device, beside the placeholder row
 * and the open anchor name. It is a ratified requirement the tree does not meet,
 * on a kind that IS drawn. It names what it requires, why the requirement is
 * unmet, and who closes it; the done-check fails on it; and it is checked for
 * staleness in the other direction, so a requirement that quietly starts being
 * met cannot keep hiding behind its own exemption. It is not a waiver. It exists
 * so a gate can carry a requirement whose FIX belongs to a different slice,
 * without either lying about the tree or blocking on somebody else's work.
 *
 * THE HONEST LIMIT, stated because a gate that overclaims is worse than none.
 * This scanner reads source text. Source text can be arranged to satisfy a
 * lexical rule without drawing anything, which is exactly the failure this round
 * exists to end — so the anchor rule is deliberately NOT the proof. Each DRAWN
 * kind also names a RENDERED owner test ({file, testName}), verified present
 * here and EXECUTED by vitest, in which the anchors appear in real DOM produced
 * from validated body fields. This gate proves the declaration; that suite
 * proves the pixels. Neither alone is the criterion.
 *
 * KNOWN RESIDUALS, recorded rather than hidden (same posture as the sibling
 * writer guards):
 *
 *   MISSES (accepted):
 *   - A renderer that copies the DRAWING without matching the naming patterns
 *     (`MyGateThing`) is invisible to a lexical guard. R3 still catches it if it
 *     mounts under a declared host and R4 if it registers; a genuinely novel
 *     name that never registers and never declares a host is a review catch.
 *   - A mount produced by indirection (`const C = cond ? A : B; <C/>`).
 *   - Per-file provider checking cannot see a provider supplied by a PARENT file
 *     — which is exactly why the two known such mounts are allowlisted BY NAME
 *     in HOST_PROVIDED_BY_PARENT, each with the parent that provides it.
 *
 *   OVER-DETECTION (accepted, and preferred):
 *   - A prose mention inside a string literal reads like code. The scan is
 *     comment-stripped, so genuine prose in comments is safe; a deliberate
 *     string is flagged. A spurious red is one conversation; a miss is a second
 *     approval surface.
 *
 * Exit 0 -> clean; exit 1 -> at least one violation; exit 2 -> scanner error.
 *
 * Usage: node scripts/audit/chat-hitl-one-card-gate.mjs
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = join(__dirname, "..", "..");
const LABEL = "chat-hitl-one-card";

/**
 * The closed set of interaction kinds, mirrored from
 * `packages/agent-ui-protocol/src/renderable-views/lifecycle-cards.ts`. Mirrored
 * rather than imported because a `.mjs` gate cannot load the project's
 * TypeScript; the pinned tests assert the two lists are identical, so a fifth
 * kind added there and forgotten here fails immediately.
 */
export const LIFECYCLE_CARD_KINDS = Object.freeze([
  "artifact_review_gate",
  "verification_summary",
  "recommendation_hold",
  "trigger_schedule_proposal",
  "agent_hitl_screen",
]);

/** How each kind reaches a surface. Mirrors `LIFECYCLE_CARD_CARRIAGE`. */
export const LIFECYCLE_CARD_CARRIAGE = Object.freeze({
  artifact_review_gate: "data_part",
  verification_summary: "data_part",
  recommendation_hold: "interrupt",
  trigger_schedule_proposal: "data_part",
  agent_hitl_screen: "interrupt",
});

/** The four hosts. Mirrors `LIFECYCLE_CARD_HOSTS`. */
export const LIFECYCLE_CARD_HOSTS = Object.freeze([
  "chat_thread",
  "site_widget",
  "run_card",
  "page_gate_region",
]);

/** The S1 shell — the "not yet drawn" renderer, and its one module. */
export const S1_SHELL = Object.freeze({
  component: "LifecycleCard",
  owner: "packages/chat/src/renderable-views/lifecycle-card.tsx",
});

/**
 * THE CONTRACT, one row per interaction kind.
 *
 * A row is either DRAWN — it names the sole owner module, the component, the
 * modules that owner composes, the authorized body it consumes, the anchors it
 * must emit, its host mounts and the rendered test that photographs them — or
 * PLACEHOLDER, which names the SAME requirements as the obligation the drawing
 * slice inherits, plus a `gap` sentence saying what is absent today.
 *
 * A PLACEHOLDER row carries `owner: null` on purpose. Pointing it at the S1
 * shell is what let the previous round read as satisfied: one component serving
 * two kinds looks like "one implementation per interaction" to a duplicate
 * detector, and the two kinds with no drawing at all were counted as met.
 */
export const LIFECYCLE_CARD_CONTRACTS = Object.freeze({
  artifact_review_gate: {
    status: "DRAWN",
    design: "§II (the review card in the thread)",
    // The epic's table columns, mirrored: component owner, then wire carriage.
    component: "ReviewGateCard",
    wireCarriage: "data_part",
    deliveries: ["platform_injected", "tool_represented"],
    owner: "packages/agents/src/review-gate-card.tsx",
    // The floor lives in its own module and is composed by the card. Anchors it
    // emits count as the card's, because the card is what mounts it.
    composes: ["packages/agents/src/review-decision-bar.tsx"],
    body: {
      // THE VALIDATED SEAM, NAMED BY WHAT THE OWNER CALLS. This row said
      // `useLifecycleCardState` until #2870 split that hook into
      // `useLifecycleCardAuth` / `useLifecycleCardFrame` / `useLifecycleCardHost`
      // / `useLifecycleCardResolve`. The card did not stop validating its body;
      // the READER was renamed, and the old name now survives in this tree only
      // inside a comment (`review-gate-card.tsx:1324`), which R6 strips — so the
      // rule correctly reported an owner that reads nothing.
      //
      // WHY `useLifecycleCardResolve` IS THE VALIDATED SEAM, and not merely the
      // fetch. Its own header states the property this row is asserting
      // (`lifecycle-card-runtime.tsx:614`): "THE ENVELOPE IS PARSED, NOT TRUSTED
      // (epic S9, slice S9c). The answer is `{ kind, state, body }`, and it goes
      // through the protocol's one parse seam with the kind THIS card asked for.
      // An answer to another kind, an unknown kind, a body beside `absent`, or a
      // missing body on a kind that must carry one are all refused — and a
      // refused parse leaves the card exactly where it was before the first
      // resolve landed, drawing nothing."
      //
      // So the next rename is checked the same way: name the hook the owner
      // CALLS, and only if that hook's own header carries the parse-seam
      // property. A reader that fetches without parsing is not a validator, and
      // renaming this field to match such a reader would be weakening R6 rather
      // than tracking it.
      validator: "useLifecycleCardResolve",
      params: ["view"],
      fields: ["state", "canDecide", "canComment", "suggestions"],
    },
    // CLOSED SET. "the applicable decision-floor anchors" is read against the
    // shipped floor, which emits exactly these two ids — the open floor and its
    // disabled form. That is a reading of the ratified list, not an invention:
    // both names already exist in the tree and in the conformance record.
    anchors: [
      '[data-lifecycle-card="artifact_review_gate"]',
      "review-gate-card",
      "review-decision-bar",
      "review-decision-disabled",
    ],
    hosts: {
      chat_thread: [
        {
          module: "packages/chat/src/renderable-views/registry.tsx",
          adapter: "registry",
          region: "transcript",
          surface: "production",
          why: "the transcript dispatch — the chat column declares the host once and every turn resolves inside it",
        },
      ],
      site_widget: [
        {
          module: "packages/chat/src/renderable-views/registry.tsx",
          adapter: "registry",
          region: "transcript",
          surface: "production",
          why: "the SAME registry row serves the widget transcript; a second table would be a parallel registry",
        },
      ],
      run_card: [
        {
          module: "packages/agents/src/agentic-run-panel.tsx",
          adapter: "mount",
          region: "run_panel",
          surface: "production",
          why: "the agentic panel branch of the run card",
        },
        {
          module: "packages/agents/src/orchestrator-stepper-panel.tsx",
          adapter: "mount",
          region: "run_panel",
          surface: "production",
          why: "the stepper branch of the same host: the run-detail review branch, which composes the shared card and defines no drawing of its own",
        },
        {
          module: "packages/agents/src/instance-screens.tsx",
          adapter: "mount",
          region: "step_rail",
          surface: "production",
          why: "the SETUP run page's review step (cinatra#2970): the run page before the agent has ever run draws the same two-column frame, and its Review row opens the run's review slot in the run detail — plan (A) §4.2's placeholder while the review is still coming, and this card in place once a gate is on file. It is the same slot the two run panels above draw, read by the same reader (`readRunReviewSlot`, cinatra#2997), so it is one renderer and not a second. It cannot draw beside either of them: the setup surface is served on the /trigger route, which mounts no run panel at all, and the run page's panels are not on it — the picker below decides between the two panels, which are the pair that could otherwise both draw on ONE page",
        },
      ],
      page_gate_region: [
        {
          module:
            "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
          adapter: "mount",
          region: "gate_region",
          surface: "production",
          why: "the review page mounts the card in its gate region; the page composes no floor of its own",
        },
      ],
    },
    // Where two adapters serve ONE host, exclusivity is a property somebody can
    // read, not a hope. The branch selector decides which panel the run-detail
    // screen draws, so exactly one of the two can be mounted for a given run.
    exclusions: {
      run_card: {
        selector: "runDetailPanelKind",
        module: "packages/agents/src/instance-screens.tsx",
        proof: {
          file: "packages/agents/src/__tests__/instance-screens-recommendation-host.test.ts",
          // The row used to cite "covers every branch — no shape is left without
          // an answer", which was the totality proof of a SECOND picker that has
          // since been deleted with the second owner it chose between
          // (cinatra#3047). It named no reading of `runDetailPanelKind` at all,
          // and the old "asserts anything" check could not see that. The cited
          // test proves THIS picker.
          testName:
            "answers exactly one panel for every run shape — the two run_card adapters are never both chosen",
        },
      },
    },
    instanceRootSelector: '[data-lifecycle-card="artifact_review_gate"]',
    renderedProof: {
      file: "packages/agents/src/__tests__/review-gate-card.test.tsx",
      testName: "the root carries its lifecycle-card identity, its host and its state",
    },
    // The SAME rendered test counts the roots on each host it drives, so the
    // anchors, the root attributes and the one-instance property are all read
    // off one mounted card rather than off three separate claims.
    instanceProof: {
      file: "packages/agents/src/__tests__/review-gate-card.test.tsx",
      testName: "the root carries its lifecycle-card identity, its host and its state",
      // The registry-served hosts are named here TOO. `jsxHosts` below can only
      // see hosts with a JSX mount, so a registry-served host would otherwise
      // carry no counted instance proof at all — the declaration would say four
      // hosts and the count would cover three.
      hosts: ["chat_thread", "run_card", "page_gate_region", "site_widget"],
    },
  },

  recommendation_hold: {
    status: "DRAWN",
    design: "§V (the recommendation card) — the chip row IS the whole card",
    component: "RecommendationHoldCard",
    wireCarriage: "interrupt",
    deliveries: ["platform_injected"],
    owner: "packages/agents/src/run-recommendation-chip-row.tsx",
    composes: [],
    body: {
      // A typed INTERRUPT, so its authorized state comes from the hold's own
      // read rather than from the data-part resolve seam.
      //
      // THAT READ HAS TWO TRANSPORTS AND ONE AUTHORITY (cinatra#2790, S9f), and
      // this line said "cookie-bound" after the second one landed. A cookie host
      // calls the server action; a credential-declaring host posts to the broker
      // route with its own proof and cookies omitted. Both land in the same
      // resolver, so the validator named below is unchanged — but a gate that
      // certifies this kind must not describe a road the widget cannot take.
      //
      // UNCHANGED BY #2870, and checked rather than assumed: the owner still
      // calls this reader (`run-recommendation-chip-row.tsx:633`), and this row
      // never named the split hook. The reader carries the same posture the
      // resolve seam does — a failed read stays with the last authorized answer
      // or with none, and is never turned into a state — so an unresolvable card
      // is silent here too, rather than optimistic.
      validator: "useRecommendationHoldState",
      params: ["runId", "wireRef"],
      fields: [
        "state",
        "agentPackageName",
        "promptText",
        "recommendations",
        "holdRef",
        "skillNames",
      ],
    },
    // TRANSCRIBED from the ratified source, not chosen here: cinatra#2841 redrew
    // §V so the decision affordances are PER CHIP, and cinatra#2826's anchor
    // contract (scripts/audit/chat-hitl-anchor-contract.json, digest-pinned and
    // bound by src/lib/lifecycle/__tests__/anchor-contract-binding.test.ts) names
    // this owner's ratified anchors. The row-level pair this list used to carry
    // ('[data-action="confirm-run-recommendation"]' and its skip twin) is not
    // emitted on any host any more, so naming it here would make this gate assert
    // a requirement the ratified drawing retired.
    anchors: [
      '[data-lifecycle-card="recommendation_hold"]',
      "[data-run-recommendation-chip-row]",
      '[data-conformance-id="run-chip-row"]',
      '[data-skill-action="confirm"]',
      '[data-skill-action="adjust"]',
      '[data-skill-action="skip"]',
    ],
    // The 'recommendation-root-identity' obligation recorded here is CLOSED by
    // cinatra#2841: the redrawn owner emits the lifecycle-card identity attribute
    // and the root's host/state pair on both the held and the decided root. The
    // gate's own both-directions check ("recorded as unmet and the owner now emits
    // every part of it — strike the record here, in whichever change lands
    // second") names this merge as the change landing second, so the record is
    // struck rather than carried forward as a requirement the tree already meets.
    openObligations: [],
    hosts: {
      // THE CONVERSATION HOSTS, both served by the ONE shared column
      // (packages/chat/src/chat-messages-view.tsx). `/chat` mounts it under the
      // module's `chat_thread` default; the widget embed
      // (src/app/embed/assistant/embed-assistant-client.tsx) passes
      // `host: "site_widget"` down to the same column. One adapter, two hosts —
      // enumerated once per host because a host is what R8 counts instances on.
      chat_thread: [
        {
          module: "packages/chat/src/chat-messages-view.tsx",
          adapter: "mount",
          region: "transcript",
          surface: "production",
          why: "the assistant dispatch turn: the card mounts on the run identity read off the tool result, as a SIBLING of the inline run card, and NOT through the renderable-view registry, because this kind's carriage is an interrupt rather than a data part (cinatra#2794, S9b)",
        },
        {
          module: "src/app/design-fixtures/conformance/lifecycle-recommendation-fixtures.tsx",
          adapter: "mount",
          region: "transcript",
          surface: "dev_preview",
          why: "the design-conformance harness mount (cinatra#3160, epic #3155 W4): the fixtures route draws the SAME card under the same chat_thread declaration, one mount per reading the drawing draws (the parked hold is drawn twice, so two of those mounts stand on the same run), so the harness exercises the shipped composer instead of the row. Enumerated because it is a real callsite, and marked dev_preview because the route is dev-only and sessionless — the card's own cookie-bound resolve answers no row for its reader there, so it claims no host mount anybody ships. Its first cut mounted RunRecommendationChipRow directly and was the retired parallel renderer R2 forbids",
        },
      ],
      site_widget: [
        {
          module: "packages/chat/src/chat-messages-view.tsx",
          adapter: "mount",
          region: "transcript",
          surface: "production",
          why: "the same column on the widget arm draws the run-start chip row for the `agent_run` step that started the run; the card's read and its two decisions travel on the host's own credential, so the mount is not gated on the surface kind (cinatra#2790, S9f)",
        },
      ],
      run_card: [
        {
          module: "packages/agents/src/instance-screens.tsx",
          adapter: "mount",
          region: "step_rail",
          surface: "production",
          why: "the run page's ONE owner of this row (cinatra#3047): the run-progress panel used to mount a second copy on the agentic branch, so the same row was drawn beside the rail at the schedule moment and inside that panel at the HITL, working and review moments; that mount is deleted and this screen draws it on every branch. It has to be a host at all because the agentic panel does not render for a run that is pending_input, and a HELD run is exactly that. It is a STEP in the rail since cinatra#2790 (S9f) — plan (A) §6.2 puts the row \"at the trigger position, the top entry on the step rail, ahead of the work steps it would authorize\", and the ratified drawing opens a gate step's surface \"right here in the run detail, under the same rail\". ONE mount serves the step's surface and the run detail's settled reading, which are mutually exclusive slots of the same frame (`RunSurfaceRail`), so the region names where the card is reached from rather than a second place it is drawn",
        },
        {
          module: "packages/agents/src/orchestrator-stepper-panel.tsx",
          adapter: "mount",
          region: "run_panel",
          surface: "dev_preview",
          why: "the Dev Stepper's child-run preview row, which draws only while a dev preview child is open and addresses that child's own run — enumerated because it is a real callsite, and marked dev_preview because it is not one of the production adapters",
        },
      ],
      // THE REVIEW-PAGE APPEARANCE (cinatra#2790, epic #2784 S9f) — AND IT IS
      // THE PAGE'S SKILLS STEP NOW, NOT ITS GATE REGION (cinatra#3047).
      //
      // The position used to be read from §6.4 item 6 as "the same row on the
      // review page, ahead of the gate it would authorize" and was composed as a
      // row ABOVE the review card. The ratified drawing at the capture
      // contract's pin rules one page per gate, and the change request says the
      // same in its own words — "do not show the skills on top of the review
      // card" — so the row is the FIRST ENTRY of this page's rail, opening in
      // the run detail in place of the review card rather than over it. The
      // module that composes those two columns is the adapter; the region is the
      // rail's step, the same `step_rail` the run page's own entry declares.
      //
      // THE HOST DID NOT MOVE. The mount still declares `page_gate_region`, so
      // the anchor contract's `hostParity` row for this kind is unchanged and
      // this gate still counts four hosts.
      page_gate_region: [
        {
          module:
            "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-run-surface.tsx",
          adapter: "mount",
          region: "step_rail",
          surface: "production",
          why: "the review page's Skills step mounts the same chip row as its own surface, under that page's `page_gate_region` host declaration; the module composes no recommendation drawing of its own and passes only the run id, so the card decides whether it draws and in which state",
        },
      ],
    },
    // NO EXCLUSION, because there is nothing to exclude (cinatra#3047):
    // `run_card` carries ONE production adapter for this kind. A picker is what
    // two adapters on one host owe; a single owner owes a mount that is not
    // gated, which `instance-screens-recommendation-host.test.ts` reads off the
    // source and `run-page-recommendation-one-place.test.tsx` counts in real DOM
    // on every branch of `runDetailPanelKind`.
    hostGap:
      "NO HOST CARRIES A GAP ANY MORE. All four are mounted and each is counted: the run card and the review page's gate region compose the card directly, and the two conversation hosts are drawn by the one shared column — the chat thread by cinatra#2794 (S9b), the site widget by cinatra#2790 (S9f), each in the change that bound its route, identity and authorization reader. The run panel draws no copy at all any more (cinatra#3047), so the run page's one owner is its own rail step and nothing has to stand down for it.",
    // The row's own root, because the lifecycle-card identity is the open
    // obligation below. When that obligation closes, this becomes
    // `[data-lifecycle-card="recommendation_hold"]` in the same change.
    instanceRootSelector: "[data-run-recommendation-chip-row]",
    renderedProof: {
      // The OWNER's own rendered suite: it mounts RecommendationHoldCard on a
      // declared host, feeds it a validated hold state, and reads the row, its
      // two ratified decisions and the count back out of real DOM.
      file: "packages/agents/src/__tests__/recommendation-hold-card.test.tsx",
      testName: "hosts run_card and chat_thread each draw EXACTLY ONE chip row, carrying the ratified decisions",
    },
    // ONE COUNTED PROOF PER HOST THAT ENUMERATES A PRODUCTION ADAPTER. The named
    // test drives all three in one loop and counts the rendered roots on each,
    // so "exactly one instance" is read off real DOM per host rather than
    // asserted once and generalized.
    instanceProof: {
      file: "packages/agents/src/__tests__/recommendation-hold-card.test.tsx",
      testName: "every host with a production adapter draws EXACTLY ONE chip row",
      hosts: ["run_card", "chat_thread", "site_widget", "page_gate_region"],
    },
  },
  // DRAWN by S9d (cinatra#2788), which is why this row no longer reads as a
  // placeholder. Its PLACEHOLDER obligation was re-read against the drawing at
  // the pin (design@92c1be7c §VI) rather than transcribed, per the header's "a
  // placeholder's anchor list is not a ratification". The ANCHOR list survived
  // that re-reading unchanged — all five are §VI regions and controls, none is
  // an artboard id — and the BODY list did not; the one correction is recorded
  // where it occurs, below.
  trigger_schedule_proposal: {
    status: "DRAWN",
    design: "§VI (the schedule proposal card) — three phases, one card",
    component: "ScheduleProposalCard",
    wireCarriage: "data_part",
    deliveries: ["platform_injected", "tool_represented"],
    owner: "packages/agents/src/schedule-proposal-card.tsx",
    composes: [],
    openObligations: [],
    body: {
      // The placeholder named this hook and the shipped card really calls it
      // (see the review row's note above for the parse-seam property the name
      // asserts), so this line is unchanged.
      validator: "useLifecycleCardResolve",
      params: ["view"],
      // THE PLACEHOLDER'S GUESS, CORRECTED — against the SERVER rather than
      // against the card. The obligation read
      // `["state", "proposal", "options", "estimatedDuration"]`: a paraphrase of
      // §VI's regions, written before the body existed, and not one of those
      // four is a field name any producer sends. The AUTHORIZED body is
      // `triggerScheduleProposalViewBodySchema`
      // (packages/agent-ui-protocol/src/renderable-views/trigger-schedule-proposal-view.ts),
      // a THREE-VARIANT union — proposal / settled / expired — so the list below
      // is `phase` (the discriminant the card branches on), the fields of each
      // variant the drawing consumes, plus the envelope's own `state`. Naming
      // the paraphrase instead would make this gate assert that the card
      // consumes fields the server never sends.
      //
      // `superseded` AND `scheduleCopy` ARE NOT ON THIS LIST, and the reason is
      // the plan rather than an omission. Both were briefly drawn as a warning
      // line above the settled rows; the S9d capture round graded that line a
      // conformance FAIL against plan (A) §7.2 — "the same card, with the same
      // option rows, shows the schedule as it stands — no label, no summary
      // box" — so the renderer stopped drawing it. `superseded` remains a
      // RESOLVER answer (cinatra#2859: does this card's own token hold the rows
      // the family settled on?) and remains on the wire, because Confirm
      // refuses on the same comparison; what it no longer is, is chrome.
      // `scheduleCopy` lost its only reader with that line, for the same reason
      // the "Armed ·" line has none: the settled card IS the form. `agentName`
      // is likewise sent and read by no part of the drawing. All four are
      // server fields no host draws — pruning them from the protocol is a wire
      // change with its own version story (the schema is `.strict()`) and is
      // deliberately NOT folded into this rework. Listed here so the gap is
      // discovered by reading rather than by a later gate failure.
      //
      // `triggerType` IS BACK, because a drawing reads it again: plan (A) §7.2
      // closes the fired one-off to changes ("once a one-off has fired it
      // cannot be changed"), and the card tells a fired one-off from a released
      // or still-arming schedule by reading `triggerType` beside `canSave`.
      // `runId` (the "Open the run" link) and `gatedSteps` (the held-steps
      // tree) stay off the list: §7.2 as amended 2026-08-23 removes both
      // drawings.
      //
      // `released` IS REMOVED, AND NOTHING TAKES ITS PLACE (cinatra#3174 fix
      // leg 2) — the second time this list has retired a field with the reading
      // that read it, and for the same reason as the first. `released` marks
      // the side-effect gate OPENING, not the firing. §VI names five readings —
      // first shown, configured, expired, "Fired, one-off — the schedule was
      // spent", "Fired, recurring — runs still to come" — and each is keyed on
      // the phase and on whether the schedule has FIRED; the section carries no
      // reading for a gate that opened, and forbids one standing in: "No
      // summary box is ever drawn, no status label, and nothing stands between
      // the reader and the form — the rows are the reading."
      //
      // Fix leg 1 acted on that: the first graded proof round drew the spent
      // reading over a run whose gate had opened and which then failed without
      // ever starting, so the election moved to `firedOnce` (carried BESIDE
      // this body, for the `.strict()` reason recorded in the view module) and
      // the status label that was this field's last reader was removed. A field
      // no drawing may read is not an authorized body field, so it leaves the
      // list — the sentence this row already wrote for `canRelease`, applied to
      // the field beside it.
      //
      // IT STAYS ON THE WIRE, and that is not the same claim. A stale
      // bundle's own copy of the settled schema declares `released` a REQUIRED
      // key, and a missing required key fails that parse, so the producer goes
      // on sending it exactly as it goes on sending `canRelease` — dropping the
      // emission would blank every settled schedule card on such a tab. Pruning it from the protocol is
      // the wire change with its own version story this row already names
      // below, and is deliberately not folded in here. Both halves are pinned
      // in `scripts/audit/__tests__/chat-hitl-one-card-gate.test.mjs`.
      //
      // `canRelease` IS REMOVED AND `stopped` TAKES ITS PLACE (cinatra#2972).
      // Plan (A) §7.2 as amended 2026-08-25 withdrew the control it authorized:
      // "there is no Run now". A field no drawing may read is not an authorized
      // body field, so it leaves the list with the control — and the reading
      // that replaced it joins: **Cancel schedule** "stops the recurring
      // schedule and then makes the scheduler non-editable", which the card
      // draws off `stopped`.
      fields: [
        "state",
        "phase",
        "schedule",
        "durationCopy",
        "canConfirm",
        "restrictedReason",
        "triggerType",
        "timezone",
        "arming",
        "canSave",
        "canCancel",
        "stopped",
      ],
    },
    // THE RATIFIED SET, RE-RATIFIED AGAINST THE PLAN RATHER THAN REFRESHED.
    // All five members below are the placeholder's, VERBATIM — the option rows,
    // the floor, the settled trigger's chrome and its two quiet controls all
    // survive the rework and are all still emitted by the owner. What the plan
    // moved is WHERE two of them are drawn (the chrome and its controls are the
    // page hosts' step, never the conversation — §7.2), which is a host reading
    // rather than an anchor.
    //
    // ONE MEMBER IS ADDED, and it is added because the plan added the control it
    // names: "to change it you return to the card, change the rows and press
    // **Save changes**, which re-arms the trigger" (§7.2), and §7.4's
    // as-designed step 6, "change the rows and press **Save changes** →
    // **End state: re-armed**". An armed card with no Save-changes control does
    // not implement the plan, so the anchor set has to be able to say so.
    //
    // NO `adjust` ANCHOR IS ADDED OR KEPT, and its absence is the point: "the
    // rows are never locked behind a separate step. The floor is **Confirm**"
    // (§7.2). The ratified set never named one, which is the one place the
    // placeholder's list was already right about the target.
    //
    // WHERE THE DRAWING AND THE PLAN DISAGREE. §VI at the pinned design commit
    // still draws `Adjust · Confirm` and a settled card that is the trigger's
    // chrome wherever it appears. The plan supersedes both, so the design page
    // needs the amendment — the same shape §9.1 already records for the chip row
    // and for the pinned capture pair. Named here rather than implemented around.
    //
    // `scheduled-run-chrome` IS RETIRED FROM THIS SET (PR #2939). It named the
    // read-only summary box and the held-steps tree, and plan (A) §7.2 as
    // amended 2026-08-23 removes both from every host: "The schedule step on the
    // run page and the review page shows the same form and nothing else — no
    // summary box, no status label". An anchor no host may draw cannot be a
    // requirement, so it is dropped rather than made conditional. The two
    // operations keep their data-action ids and change only their labels
    // (Cancel schedule, Run now), which is why the ids below are untouched.
    //
    // `[data-action="release-trigger-now"]` IS RETIRED FROM THIS SET
    // (cinatra#2972), for the same reason `scheduled-run-chrome` was: plan (A)
    // §7.2 as amended 2026-08-25 says "there is no Run now", and an anchor no
    // host may draw cannot be a requirement. **Cancel schedule** stays a
    // requirement and keeps its id — what the same amendment narrowed is WHEN
    // it is drawn ("shown only for a recurring schedule that has fired once"),
    // which is a body reading rather than an anchor.
    anchors: [
      "schedule-option-rows",
      "schedule-proposal-floor",
      '[data-action="save-schedule-changes"]',
      '[data-action="cancel-trigger-schedule"]',
    ],
    instanceRootSelector: '[data-lifecycle-card="trigger_schedule_proposal"]',
    hosts: {
      chat_thread: [
        {
          module: "packages/chat/src/renderable-views/registry.tsx",
          adapter: "registry",
          region: "transcript",
          surface: "production",
          why: "the transcript dispatch — the same one registry row the review and verification cards use; the chat column declares the host once and every turn resolves inside it",
        },
      ],
      site_widget: [
        {
          module: "packages/chat/src/renderable-views/registry.tsx",
          adapter: "registry",
          region: "transcript",
          surface: "production",
          why: "the SAME registry row serves the widget transcript; a second table would be a parallel registry",
        },
      ],
      // THE TWO PAGE HOSTS ARE A STEP IN THE RAIL, NOT A CARD IN A REGION.
      // Plan (A) §7.2 step 5: "On the run page and the review page the schedule
      // is a **dedicated step in the step rail on the left, above '1 Review'**:
      // open that step to see the configuration or change it. The schedule is
      // never drawn as a card among the review cards — a trigger decides *when*
      // the agent runs, and a review card exists only after the agent has run
      // and produced something — so the two can never appear together."
      //
      // ONE MODULE SERVES BOTH, and that is why it is a component rather than
      // two page-local compositions: `ScheduleRailStep` is the rail ROW plus the
      // disclosure panel, it declares the host itself, and the card inside it is
      // the same `ScheduleProposalCard` the transcript registry dispatches. The
      // pages pass it a ref and a host and draw nothing of the schedule
      // themselves — so "one renderer per kind" survives the move, and the
      // review page's gate region draws no schedule card at all.
      run_card: [
        {
          module: "packages/agents/src/schedule-rail-step.tsx",
          adapter: "mount",
          region: "step_rail",
          surface: "production",
          why: "the run page's schedule STEP: the first row of the run detail's left rail, which declares host=\"run_card\" and opens onto the card — the run screen renumbers its own rail around it and mounts no schedule drawing of its own",
        },
        {
          module: "packages/agents/src/run-schedule-tab.tsx",
          adapter: "mount",
          region: "page_region",
          surface: "production",
          why: "the SAME run's schedule tab (cinatra#3004): the agent page's schedule surface, which declares host=\"run_card\" and draws the form on its own — no rail to be a row of. It replaces a second drawing of the same facts (a Trigger-configuration summary, a held-steps tree and a Cancel that deleted the row), so this adapter REMOVES a parallel renderer rather than adding one",
        },
      ],
      page_gate_region: [
        {
          module: "packages/agents/src/schedule-rail-step.tsx",
          adapter: "mount",
          region: "step_rail",
          surface: "production",
          why: "the review page's schedule STEP: the same row at the head of ReviewRunSteps, declaring host=\"page_gate_region\" — the page's gate region beside it draws no schedule card. It holds the review gate card and the run's own parked question and NOTHING else: the recommendation hold card stood there too until cinatra#3047, and it is the surface of this rail's own Skills step now, because no reading is drawn as a row above another card",
        },
      ],
    },
    // TWO ADAPTERS ON THE RUN'S OWN HOST, AND THEY ARE ROUTES (cinatra#3004).
    // The run detail opens the schedule as a step in its rail; the run's
    // schedule tab is the same form on its own page region. One run is never
    // both screens at once, and the picker below is where that is decided in
    // code rather than inferred from two mounts.
    exclusions: {
      run_card: {
        selector: "runScheduleAdapterFor",
        module: "packages/agents/src/instance-screens.tsx",
        proof: {
          file: "packages/agents/src/__tests__/schedule-run-card-adapters-3004.test.ts",
          testName:
            "answers exactly one adapter for every screen and trigger shape — the two run_card schedule adapters are never both chosen",
        },
      },
    },
    // All four hosts carry a mount, so there is no `hostGap` to write. §IX's
    // "every card appears on every host" is met for this kind.
    //
    // ONE rendered test carries both proofs, as the review and verification rows
    // do: it drives all four hosts, counts the roots on each, reads the two
    // required root attributes, and reads all five ratified anchors back out of
    // real DOM. §VI's set spans two phases, so that one test walks the proposal
    // and the settled phase on every host rather than splitting the set across
    // two cases — a contract that reads its anchors off ONE named proof is what
    // stops a card borrowing half its evidence from a neighbouring case.
    renderedProof: {
      file: "packages/agents/src/__tests__/schedule-proposal-card.test.tsx",
      testName:
        "the root carries its lifecycle-card identity, its host and its state — one instance per host, drawing the ratified anchor set",
    },
    instanceProof: {
      file: "packages/agents/src/__tests__/schedule-proposal-card.test.tsx",
      testName:
        "the root carries its lifecycle-card identity, its host and its state — one instance per host, drawing the ratified anchor set",
      // Named explicitly, like the review and verification rows': two of the
      // four hosts are registry-served, so a JSX-mount scan alone would leave
      // them uncounted.
      hosts: ["chat_thread", "site_widget", "run_card", "page_gate_region"],
    },
  },

  // DRAWN by S9e (cinatra#2789), which is why this row no longer reads as a
  // placeholder. Its PLACEHOLDER obligation was re-read against the drawing at
  // the pin (design@92c1be7c §VII) rather than transcribed, per the header's
  // "a placeholder's anchor list is not a ratification"; the three places the
  // obligation and the drawing disagreed are corrected where they occur, each
  // with the drawing sentence it rests on. A row that keeps a guess after the
  // drawing lands is the same dishonesty as a placeholder that keeps a name
  // after the card lands.
  verification_summary: {
    status: "DRAWN",
    design: "§VII (the verification card) — advisory, no floor",
    component: "VerificationSummaryCard",
    wireCarriage: "data_part",
    deliveries: ["platform_injected", "tool_represented"],
    owner: "packages/agents/src/verification-summary-card.tsx",
    composes: [],
    openObligations: [],
    body: {
      // #2870 split `useLifecycleCardState` apart; the validated seam is
      // `useLifecycleCardResolve` (see the review row's note above for the
      // parse-seam property this name asserts). The placeholder named this hook
      // and the shipped card really calls it, so this line is unchanged.
      validator: "useLifecycleCardResolve",
      params: ["view"],
      // The placeholder's guess is corrected here (1 of 3), against the SERVER
      // rather than against the card. The obligation read
      // `["state", "outcome", "revisions", "fields", "comments"]`
      // — a paraphrase of §VII's regions, written before the body existed. The
      // AUTHORIZED body is `verificationSummaryBodySchema`
      // (packages/agent-ui-protocol/src/renderable-views/lifecycle-cards.ts),
      // and these are its field names, plus the envelope's own `state`. Naming
      // the paraphrase instead would make this gate assert that the card
      // consumes fields the server never sends.
      fields: [
        "state",
        "outcome",
        "reviewedRevisionId",
        "repairedRevisionId",
        "fieldDiff",
        "advisoryComments",
      ],
    },
    // THE RATIFIED SET, CLOSED — and the placeholder's guess is corrected here
    // (2 of 3). Read the header's "a placeholder's anchor list is not a
    // ratification" first: the requirement below comes from the DRAWING, and
    // only the NAMES come from the tree's convention.
    //
    // WHAT WAS WRONG. The obligation PINNED `["verification-in-thread"]` — it
    // recorded that name, which is not the same act as ratifying it. That
    // is an ARTBOARD id: in the drawing at design@92c1be7c it wraps the specimen
    // slot inside §VII's "the verification card in the assistant turn" figure,
    // exactly as `state-loading` wraps §IV's and `review-target-in-thread` wraps
    // §II's — and this table ratifies neither of those for the review card. An
    // artboard marker is how the design page labels its own examples; it is not
    // something a shipped card emits. The corroboration is independent of this
    // slice: scripts/audit/lib/chat-hitl-capture-recorder.mjs has graded a
    // capture of this kind against the conformance id `verification-card` since
    // before either S9a or S9e, and `verification-in-thread` appears nowhere in
    // this repository's executable expectations.
    //
    // WHAT THE DRAWING RATIFIES. §VII names this card's regions in one sentence:
    // "the **Core analysis** heading with its outcome pill, the scope sentence,
    // and the two revision pins, and the field-by-field before / after of
    // exactly what was inspected … It closes with **Advisory comments**: a label
    // over one panel per comment." That is the closed set — chrome, outcome,
    // revisions, field-diff, advisory — and it is the drawing's, not this
    // slice's. The scope sentence is deliberately NOT in it: §VII draws it as
    // copy inside the chrome rather than as a region, so it gets no anchor, and
    // an anchor nobody drew is the implementer choice a closed set forbids.
    //
    // WHERE THE NAMES COME FROM. §VII gives those five regions no ids of its
    // own, so they are named here in the tree's existing attribute convention —
    // the same footing, and the same wording, as the schedule-proposal row's two
    // controls three rows up ("ratified in prose and are now named, in the
    // existing verb-object convention"). Naming a prose-ratified region is not
    // choosing the requirement; adding or dropping one would be, and neither
    // happened. A reader checking this row checks it against §VII's sentence,
    // not against the card.
    //
    // The same five are `VERIFICATION_CORE_ANCHORS` below, which is what R2 bans
    // outside this owner. One list, read from both ends: the drawing may not be
    // redrawn elsewhere, and it may not quietly stop being drawn here.
    anchors: [
      "[data-verification-chrome]",
      "[data-verification-outcome]",
      "[data-verification-revisions]",
      "[data-verification-field-diff]",
      "[data-verification-advisory]",
    ],
    instanceRootSelector: '[data-lifecycle-card="verification_summary"]',
    // NO `anchorsOneOf`, and the placeholder's guess is corrected here (3 of 3).
    // The obligation expressed §VII's three outcomes as three conformance ids
    // (`verification-verified` / `-drift` / `-findings-not-met`) — again the
    // drawing's three SPECIMEN artboards, not three things one card emits. The
    // shipped card carries the outcome as the VALUE of one anchor,
    // `data-verification-outcome={body.outcome}`, over the closed enum
    // `VERIFICATION_SUMMARY_OUTCOMES`. That is the same requirement, better
    // drawn: "exactly one of the three at a time" is structural in a single
    // valued attribute rather than a rule about three ids, and all three remain
    // reachable. Keeping the three-id form would have failed R7 against a card
    // that draws §VII correctly — a gate rejecting a correct tree.
    //
    // The three-outcome requirement is not dropped, it MOVED to where it can be
    // proven: `renderedProof` below drives `verified`, `drifted` and `unmet`
    // through real DOM and reads §VII's own three labels back out.
    hosts: {
      chat_thread: [
        {
          module: "packages/chat/src/renderable-views/registry.tsx",
          adapter: "registry",
          region: "transcript",
          surface: "production",
          why: "the transcript dispatch — the same one registry row the review card uses; the chat column declares the host once and every turn resolves inside it",
        },
      ],
      site_widget: [
        {
          module: "packages/chat/src/renderable-views/registry.tsx",
          adapter: "registry",
          region: "transcript",
          surface: "production",
          why: "the SAME registry row serves the widget transcript; a second table would be a parallel registry",
        },
      ],
      run_card: [
        {
          module: "packages/agents/src/instance-screens.tsx",
          adapter: "mount",
          region: "run_panel",
          surface: "production",
          why: "the run screen draws one card per verification record the run carries, under its own <LifecycleCardSurfaceProvider host=\"run_card\">",
        },
      ],
      page_gate_region: [
        {
          module:
            "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/verification-view.tsx",
          adapter: "mount",
          region: "page_region",
          surface: "production",
          why: "the review page's verification region mounts the card and composes only its page-only adjunct around it — R2's 'page-direct-verification-composition' entry is what keeps it from drawing the core itself",
        },
      ],
    },
    // All four hosts carry a mount, so there is no `hostGap` to write. §IX's
    // "every card appears on every host" is met for this kind.
    // The SAME rendered test carries both proofs, exactly as the review card's
    // does: it drives all four hosts, counts the roots on each, reads the two
    // required root attributes, and reads all five ratified anchors back out of
    // real DOM. One executed test, so the declaration above and the pixels can
    // never be two separate claims.
    renderedProof: {
      file: "packages/agents/src/__tests__/verification-summary-card.test.tsx",
      testName:
        "the root carries its identity, host and state, and draws EXACTLY ONE instance per host",
    },
    instanceProof: {
      file: "packages/agents/src/__tests__/verification-summary-card.test.tsx",
      testName:
        "the root carries its identity, host and state, and draws EXACTLY ONE instance per host",
      // Named explicitly, like the review card's: two of the four hosts are
      // registry-served, so a JSX-mount scan alone would leave them uncounted.
      hosts: ["chat_thread", "site_widget", "run_card", "page_gate_region"],
    },
  },

  // Registered by cinatra#2928 (lifecycle-b W2a) as the FIFTH kind and drawn by
  // W3 (cinatra#2930). The moment the agent pauses to ask for input had no name
  // in this vocabulary, so every surface told it apart from a review by
  // pattern-matching the shape of the pause. Naming it is what lets a run STATE
  // it; the card below is what lets a person see one card for it on every host.
  agent_hitl_screen: {
    status: "DRAWN",
    // DRAWN by W3 (cinatra#2930), which is why this row no longer reads as a
    // placeholder. Its PLACEHOLDER obligation was re-read against the drawing
    // rather than transcribed, per the header's "a placeholder's anchor list is
    // not a ratification". The ANCHOR list survived that re-reading unchanged —
    // the fields region and the Continue are exactly the two things the screen
    // has always been — and the BODY list did not: the placeholder guessed
    // `useLifecycleCardResolve`, which is the DATA_PART resolve seam this kind
    // has no envelope for. The correction is recorded where it occurs, below.
    design:
      "the pause screen in specs/app-components.html, drawn inside the base page's section-I card chrome — fields with a Continue, which is what the run page has always shown",
    component: "AgentHitlScreenCard",
    wireCarriage: "interrupt",
    deliveries: ["platform_injected"],
    owner: "packages/agents/src/agent-hitl-screen-card.tsx",
    composes: [],
    body: {
      // THE PLACEHOLDER'S GUESS, CORRECTED. It named `useLifecycleCardResolve`
      // beside a comment saying the opposite in as many words — "a typed
      // INTERRUPT like `recommendation_hold`, so its authorized state does not
      // come from the data-part resolve seam". The comment was right and the
      // value was wrong: an interrupt kind mints no resolve envelope, so there
      // is nothing for that hook to POST. The reader that exists is this one,
      // and it carries the same posture the resolve seam does — the run access
      // door first, a failed read left as a failure rather than turned into a
      // state, and no answer at all until an authorized one lands.
      validator: "useAgentHitlScreenState",
      params: ["runId"],
      fields: ["state", "gate"],
    },
    // The two the plan states in prose — the fields the screen asks for, and
    // the Continue that submits them — VERBATIM from the placeholder, because
    // re-reading them against the drawing changed neither.
    anchors: ["hitl-screen-fields", '[data-action="submit-hitl-screen"]'],
    openObligations: [],
    hosts: {
      // THE CONVERSATION HOSTS, both served by the ONE shared column
      // (packages/chat/src/chat-messages-view.tsx). `/chat` mounts it under the
      // module's `chat_thread` default; the widget embed passes
      // `host: "site_widget"` down to the same column. One adapter, two hosts —
      // enumerated once per host because a host is what R8 counts instances on.
      chat_thread: [
        {
          module: "packages/chat/src/chat-messages-view.tsx",
          adapter: "mount",
          region: "transcript",
          surface: "production",
          why: "the parked dispatch turn: the card mounts on the run identity read off the `agent_run` tool result, as a SIBLING of the inline run card, and NOT through the renderable-view registry, because this kind's carriage is an interrupt rather than a data part",
        },
      ],
      site_widget: [
        {
          module: "packages/chat/src/chat-messages-view.tsx",
          adapter: "mount",
          region: "transcript",
          surface: "production",
          why: "the same column on the widget arm draws the same card for the same `agent_run` part; the card's host declaration selects its transport, so the read travels on that host's own credential and the mount is not gated on the surface kind",
        },
      ],
      run_card: [
        {
          module: "packages/agents/src/agentic-run-panel.tsx",
          adapter: "mount",
          region: "run_panel",
          surface: "production",
          why: "the agentic panel wraps its own pause screen — the gate renderer's fields and the Continue that submits them — in this card's root, so the run page draws the screen it always drew and the card is its identity rather than a second drawing",
        },
      ],
      // THE FOURTH HOST, for the epic's own reason rather than for a product
      // flow that produces it often: §IX's "every card appears on every host" is
      // the structural thesis this gate's done-check enforces, and a card that
      // draws on three hosts and is absent from the fourth is a card a reader
      // can be sent to a page that will not show it.
      page_gate_region: [
        {
          module:
            "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
          adapter: "mount",
          region: "gate_region",
          surface: "production",
          why: "the review page mounts the same card inside its gate region, above the review card and under that region's own `page_gate_region` host declaration, keyed by the run and nothing else; a run that is not parked asking a question draws nothing, so the mount costs the page nothing and shows the question to a reviewer who arrives while the run is waiting",
        },
      ],
    },
    hostGap:
      "NO HOST CARRIES A GAP. All four are mounted and each is counted: the two conversation hosts by the ONE shared column, the run page by the panel that already draws the pause screen, and the review page's gate region by its own composition. The panel's copy stands down inside either conversation host (`runCardOwnsLifecycleCopy`), which is what keeps one mount per host true where two adapters are in scope.",
    instanceRootSelector: '[data-lifecycle-card="agent_hitl_screen"]',
    renderedProof: {
      file: "packages/agents/src/__tests__/agent-hitl-screen-card.test.tsx",
      testName:
        "the root carries its identity, host and state, and draws the fields and the Continue",
    },
    instanceProof: {
      file: "packages/agents/src/__tests__/agent-hitl-screen-card.test.tsx",
      testName: "every host with a production adapter draws EXACTLY ONE screen card",
      hosts: ["chat_thread", "site_widget", "run_card", "page_gate_region"],
    },
  },
});

/**
 * The SOLE module that may define each interaction's card component — derived
 * from the contract so the two can never disagree. A PLACEHOLDER kind
 * contributes no owner row; the S1 shell keeps its own row so a second shell
 * definition is still an R1 violation while the shell is still in service.
 */
/**
 * THE TWO DELIVERIES, per kind (cinatra#2930, epic #2926 W3).
 *
 * The plan's implementation note: "the held-turn contract … and the one-card
 * gate are updated to the two deliveries." A delivery is WHO decided the card
 * should be in the conversation:
 *
 *   `platform_injected` — the run reached a moment and the platform wrote the
 *     card into the run's own turn. No model was asked and none can withhold it.
 *   `tool_represented`  — a "show me" tool brought the card back into view. The
 *     plan keeps those tools and keeps them second: "recorded as exactly that".
 *
 * MIRRORED from src/lib/lifecycle/held-turn-card-contract.ts, which takes both
 * carriage axes from the protocol registry; the pinned suite next door checks
 * the two tables agree, so neither can drift alone.
 */
export const LIFECYCLE_CARD_DELIVERIES = Object.freeze([
  "platform_injected",
  "tool_represented",
]);

/**
 * The deliveries a kind really has. Every kind has the injected one — a kind
 * delivered only by a tool would be a card a model can withhold, which is the
 * defect this wave closes — and only a DATA_PART-carried kind can also be
 * re-presented, because an INTERRUPT carriage mints no resolve envelope for a
 * pull tool to hand back.
 */
export function deliveriesFor(kind) {
  return LIFECYCLE_CARD_CONTRACTS[kind]?.deliveries ?? [];
}

export const CARD_OWNERS = Object.freeze(
  Object.fromEntries([
    ...Object.entries(LIFECYCLE_CARD_CONTRACTS)
      .filter(([, c]) => c.status === "DRAWN")
      .map(([kind, c]) => [kind, { component: c.component, owner: c.owner }]),
    ["s1_placeholder_shell", { component: S1_SHELL.component, owner: S1_SHELL.owner }],
  ]),
);

/**
 * The definition pattern for one card component: the component's own name, or
 * any `Prefixed…` look-alike of it. The optional prefix group is what makes a
 * second, differently-named implementation of the SAME card visible — a
 * `CompactReviewGateCard` is exactly the drift this rule exists to catch — while
 * the bare name is matched at the owner so the allowlist can never go vacuous.
 */
export function cardDefinitionPattern(component) {
  return new RegExp(
    String.raw`\b(?:function|const|class)\s+((?:[A-Z][A-Za-z0-9]*)?${component})\b`,
    "g",
  );
}

/**
 * R2 — the retired parallel renderers, as exact JSX / identifier / anchor forms.
 *
 * Each entry names WHAT was deleted and WHY it may not return, because the ban
 * is the whole content of the criterion. `allow` lists the modules where the
 * token is legitimate: the component's own definition module, and (for the
 * decision bar / blocked state) the ONE card that composes them.
 */
/**
 * The STRUCTURAL ANCHORS of §VII's core — the data attributes that identify the
 * verification drawing itself, independently of what any component is called.
 *
 * Exported because two things read them and they must not drift: the R2 rule
 * below (which bans them outside the owner module) and the slice's own
 * one-renderer test (which asserts the owner really emits every one of them, so
 * the ban can never go vacuous by the anchors quietly disappearing).
 *
 * They are the sections §VII names: the Core-analysis chrome, the outcome pill,
 * the REVISION PINS, the field-by-field before/after, and the advisory
 * comments. §VII draws no authorized-scope region — the plan's own binding
 * correction puts the authorization in the card's copy and in the before/after
 * columns — so there is no anchor for one, and an "authorized-scope" anchor
 * appearing anywhere would be a region outside the closed set rather than a
 * parallel drawing of one inside it (cinatra#2861).
 *
 * `revisions` is in this list and must stay: the two revision pins are §VII
 * CORE, not a page adjunct. The page's own requirement names exactly two adjuncts —
 * the pinned VISUAL pair (#2044 L-D) and the back-to-gate route affordance —
 * and the revision pins are neither. The name collision between "the revision
 * pins" and "the pinned visual pair" is precisely how this anchor was left out
 * of the first cut of this list (restored in cinatra#2861): without it, a
 * production module could emit `data-verification-revisions` and redraw that
 * portion of the reading without tripping R2 or the emitter test — which is
 * exactly the parallel renderer this gate exists to forbid.
 */
export const VERIFICATION_CORE_ANCHORS = Object.freeze([
  "chrome",
  "outcome",
  "revisions",
  "field-diff",
  "advisory",
]);

export const RETIRED_PARALLELS = Object.freeze([
  {
    id: "review-redirect-card",
    // The display-only "Continue to review" card that navigated the reader away
    // instead of letting them decide in the conversation. Deleted by S2 (#2566).
    re: /\bArtifactReviewRedirectCard\b/g,
    allow: [],
    fix: "The review gate renders `ReviewGateCard` on every host; there is no redirect card.",
  },
  {
    id: "direct-chip-row-mount",
    // The pre-S4 mount: a host rendering the chip row itself (and polling for
    // its state) rather than mounting `RecommendationHoldCard`, which owns
    // WHETHER the row appears, WHICH state it is in, and WHEN it re-reads.
    re: /<\s*RunRecommendationChipRow\b/g,
    allow: [
      // The card that composes the shipped row — the one legitimate mount, and
      // now the ONLY one.
      //
      // HISTORY, kept because an empty-looking allowlist hides what it cost.
      // S7 first shipped this rule with `packages/agents/src/instance-screens.tsx`
      // allowlisted BY NAME: the run-DETAIL screen rendered the recommendation
      // interaction ITSELF — its own park read, its own candidate prefetch and a
      // direct `<RunRecommendationChipRow holdRef={…}>` — bypassing
      // `RecommendationHoldCard`, the host declaration and the card's
      // authoritative-refetch contract. That was defect D-1, and it was not
      // cosmetic: `AgenticRunPanel` (which mounts the card correctly under
      // `host="run_card"`) renders only for `run.status !== "pending_input"`,
      // and a HELD run IS `pending_input`, so the HELD state on the run-detail
      // page was drawn ONLY by the parallel path. cinatra#2710 (`7123d2bf1`)
      // deleted that path: the screen now mounts `RecommendationHoldCard`
      // inside its own `<LifecycleCardSurfaceProvider host="run_card">`, on
      // every branch and gated by nothing (cinatra#3047 deleted the branch gate
      // together with the run panel's own copy), so exactly one renderer draws.
      // The allowlist entry was deleted with the parallel path, which is what
      // makes this gate's pass mean the criterion.
      "packages/agents/src/run-recommendation-chip-row.tsx",
    ],
    fix: "Mount <RecommendationHoldCard> under a declared host; the card composes the row.",
  },
  {
    id: "page-direct-verification-composition",
    // The review page's `VerificationView` DRAWING §VII itself. Before S9e
    // (cinatra#2789) that component composed the whole reading — the
    // Core-analysis chrome, the outcome pill, the revision pins, the
    // field-by-field before/after and the advisory comments — while the same
    // reading in a chat transcript drew the S1 shell. Two drawings of one
    // reading is exactly the drift this gate exists to catch, so the core moved
    // into `VerificationSummaryCard` and `VerificationView` became a composition
    // of that card plus its one page-only adjunct, the pinned visual pair. (The
    // navigation back to the gate went with the drawing: plan §8.3(5) and §8.4
    // say the link exists only because the reading lived on its own page, so it
    // goes when the card lands — cinatra#2861.)
    //
    // BANNED BY THE §VII ANCHORS, NOT BY A COMPONENT NAME, and deliberately so.
    // `VerificationView` still exists and must — it is the legitimate adjunct
    // composition — so banning its name would ban the right answer. What may
    // not come back is the DRAWING, and the drawing is identified by the
    // structural anchors §VII's core carries: the Core-analysis chrome, the
    // outcome pill, the REVISION PINS, the before/after table and the
    // advisory-comment list — every section the history above says the page
    // used to draw, because the ban and that history have to name the same
    // drawing or the ban has a hole in it.
    // Emitting any of those outside the owner module is a second §VII renderer
    // whatever it is called — which also catches the look-alike that R1's name
    // patterns structurally cannot see.
    //
    // R9'S RETIREMENT, COMPLETED HERE — the history kept, because an
    // empty-looking allowlist hides what it cost (the same posture the
    // `direct-chip-row-mount` entry above keeps for S7's). S9a (cinatra#2792)
    // shipped this ban in its PENDING form: the pattern was the identifier
    // `VerificationView`, and the allowlist named the two route modules that
    // carried the parallel drawing —
    // `…/review/[reviewTaskId]/verification-view.tsx` and its `page.tsx`. That
    // record said, in its own words, that it was "valid ONLY while the
    // verification kind is a placeholder: the slice that draws the card must
    // delete the parallel renderer with it", and that "the slice that draws the
    // card deletes this and empties the allowlist in the same change". This is
    // that slice, and this is that change:
    //
    //   · the PARALLEL DRAWING is deleted — `VerificationView` composed §VII's
    //     five regions itself and now composes none of them; it mounts
    //     `VerificationSummaryCard` under `host="page_gate_region"` and adds one
    //     page-only adjunct. Neither route module emits a single
    //     `data-verification-*` anchor any more, which is a property this very
    //     rule now checks on every run rather than a claim in a comment.
    //   · the ROUTE-MODULE ALLOWLIST is emptied — both entries are gone above.
    //     What remains in `allow` is the owner's own definition module, which is
    //     not an exception at all: every entry in this table allows the module
    //     that defines the shipped thing (`run-recommendation-chip-row.tsx` for
    //     the row, `review-gate-card.tsx` / `review-decision-bar.tsx` for the
    //     floor). An `allow: []` here would flag the one renderer for drawing.
    //   · the PENDING_RETIREMENT record is deleted, with its expiry check in
    //     `auditContracts`. Its whole content was "these modules must be gone
    //     the moment the kind is DRAWN"; the kind is DRAWN and the drawing is
    //     gone from them, so carrying the record would be carrying a debt
    //     nobody owes.
    //
    // AND THE IDENTITY OF THE BAN MOVED WITH IT, deliberately. A name ban plus
    // an empty allowlist would have banned the RIGHT answer: `VerificationView`
    // survives, and must, because it carries the page-only visual pair (#2044
    // L-D) that no card in a turn can draw. So the ban now names the DRAWING —
    // §VII's five regions — instead of the identifier that used to carry it.
    //
    // WHAT THAT TRADE COSTS AND BUYS, stated both ways rather than as a win.
    // WIDER: any module redrawing a §VII region trips it whatever it is called,
    // which is precisely the look-alike R1's name patterns structurally cannot
    // see. NARROWER: a second component merely NAMED `VerificationView` that
    // emits no §VII region no longer trips R2 — but that is a wrapper, an alias
    // or a harness, not a parallel core renderer, and R9 never existed to catch
    // it. UNCHANGED, and recorded because it is the honest limit: a renderer
    // that copies the drawing under a novel name AND invents its own attributes
    // evades both forms. It always did — it is the first entry in this file's
    // MISSES list — and R3, R4 and review are what stand behind the lexical
    // rule there.
    //
    // OVER-DETECTION, accepted on purpose: the `\b` makes the pattern fire on a
    // prefixed relative too (`data-verification-chrome-extra`). A neighbouring
    // attribute on a §VII region drawn outside the owner is the same second
    // drawing, and this file's recorded posture is that a spurious red is one
    // conversation while a miss is a second approval surface.
    re: new RegExp(
      String.raw`data-verification-(?:${VERIFICATION_CORE_ANCHORS.join("|")})\b`,
      "g",
    ),
    allow: ["packages/agents/src/verification-summary-card.tsx"],
    fix: "`VerificationView` mounts <VerificationSummaryCard> and keeps only its page-only adjunct; the card owns §VII's core.",
  },
  {
    id: "page-direct-decision-composition",
    // The review PAGE composing the DECISION FLOOR itself. S2 moved the bar into
    // the card so all four hosts draw one floor, bound to one decision module.
    //
    // SCOPED TO THE BAR, DELIBERATELY. `ReviewGateBlocked` is NOT banned here
    // even though S2 moved it too: the page uses it for its own ROUTE-LEVEL
    // absence ("this route resolves to no gate at all"), which happens before
    // and outside any gate region, and it uses the SHIPPED component rather
    // than a look-alike — which is the property the criterion actually protects.
    // Banning it would force the page to grow a second absence panel, i.e. the
    // exact duplication this gate exists to prevent.
    re: /<\s*ReviewDecisionBar\b/g,
    allow: [
      "packages/agents/src/review-gate-card.tsx",
      "packages/agents/src/review-decision-bar.tsx",
    ],
    fix: "The page mounts <ReviewGateCard> in its gate region; the card owns the floor.",
  },
]);

/**
 * WHERE ON THE HOST A MOUNT DRAWS — the closed region vocabulary
 * (cinatra#2788, epic #2784 S9d).
 *
 * WHY IT EXISTS. `adapter` says HOW a card is reached (a registry row, or a JSX
 * mount) and `surface` says whether it ships. Neither says WHERE on the page it
 * lands, and for one kind that is now a ratified property rather than a layout
 * detail: plan (A) §7.2 step 5 puts the schedule on the run page and the review
 * page as "a **dedicated step in the step rail on the left, above '1 Review'**"
 * and rules out the alternative in the same sentence — "The schedule is never
 * drawn as a card among the review cards … so the two can never appear
 * together." A contract that could only say "mount, production" recorded the
 * composition the plan forbids and the composition it requires identically.
 *
 * SMALLEST TRUTHFUL SET. One member per place a lifecycle card is actually
 * drawn today, named after the region rather than after the file:
 *
 *   transcript   a conversation turn (the chat column or the widget frame)
 *   run_panel    inside the run detail's right-hand panel or screen body
 *   gate_region  the review page's decision region — where the review card is
 *   page_region  a page's own non-gate region (the review page's verification
 *                region, which is a separate reading of the same run)
 *   step_rail    a STEP in the left step rail, opening onto its configuration
 *
 * It is descriptive, not prescriptive: the gate checks that every entry names
 * one of these, so a mount that moves has to say so here, and a reader of this
 * table can see that the schedule kind is a rail step on both pages while the
 * review kind is the gate region. WHICH regions a KIND may use is decided by
 * the plan, not by this file.
 */
export const LIFECYCLE_MOUNT_REGIONS = Object.freeze([
  "transcript",
  "run_panel",
  "gate_region",
  "page_region",
  "step_rail",
]);

/** R3 — the JSX mounts that are lifecycle CARD mounts. */
const CARD_MOUNT_RE =
  /<\s*(ReviewGateCard|RecommendationHoldCard|LifecycleCard|VerificationSummaryCard|ScheduleProposalCard|AgentHitlScreenCard)\b/g;
const HOST_PROVIDER_RE = /<\s*LifecycleCardSurfaceProvider\b/;

/**
 * Files that mount a lifecycle card whose host provider is supplied by a PARENT
 * component in another file. Allowlisted BY NAME with that parent, because a
 * per-file scan structurally cannot see it — and because an unexplained
 * exception is how a fail-closed gate rots.
 */
export const HOST_PROVIDED_BY_PARENT = Object.freeze({
  // The chat/widget conversation column declares the host once, at the column
  // root, and every turn's renderable-view dispatch happens inside it.
  "packages/chat/src/renderable-views/registry.tsx":
    "packages/chat/src/chat-messages-view.tsx (<LifecycleCardSurfaceProvider {...lifecycleSurface}>)",
  "packages/chat/src/renderable-views/lifecycle-card.tsx":
    "packages/chat/src/chat-messages-view.tsx (<LifecycleCardSurfaceProvider {...lifecycleSurface}>)",
});

/** R4 — the one registry, the one line per kind inside it, and WHAT that line
 * dispatches to.
 *
 * CHECKING THE RIGHT-HAND SIDE IS THE POINT (cinatra#2861). Counting `kind:`
 * occurrences alone leaves the rule half-blind: reverting
 * `verification_summary: VerificationSummaryCard` to
 * `verification_summary: LifecycleCard` keeps the count at exactly one and
 * sails through, silently un-retiring the S1 shell for a kind the epic has
 * DRAWN. So the row's component is compared against `CARD_OWNERS[kind]`, which
 * is the same table R1 enforces ownership with — one source of truth for who
 * draws a kind, read from both ends.
 *
 * SCOPED TO THE DATA-PART KINDS. `recommendation_hold` rides a typed INTERRUPT,
 * not a `DATA_PART` (`LIFECYCLE_CARD_CARRIAGE`), so it is correctly absent from
 * the renderable-view registry — its single mount is the `RecommendationHoldCard`
 * on each declared host, which R1 and R3 cover. Requiring a registry row for it
 * would demand the second dispatch path this gate exists to forbid. */
export const REGISTRY_MODULE = "packages/chat/src/renderable-views/registry.tsx";
export const REGISTRY_KINDS = Object.freeze([
  "artifact_review_gate",
  "verification_summary",
  "trigger_schedule_proposal",
]);

/** Paths exempt from every rule: tests, fixtures, docs, this script. */
export function isExempt(rel) {
  return (
    rel.startsWith("docs/") ||
    rel.startsWith("scripts/") ||
    rel.startsWith("tests/") ||
    rel.endsWith(".d.ts") ||
    rel.includes("/__tests__/") ||
    rel.includes("/__fixtures__/") ||
    /\.test\.tsx?$/.test(rel)
  );
}

/** Tracked application sources this gate scans. */
export function collectFiles(repoRoot = DEFAULT_REPO_ROOT) {
  const out = execSync(
    'git ls-files "src/**/*.ts" "src/**/*.tsx" "packages/**/*.ts" "packages/**/*.tsx"',
    { encoding: "utf8", cwd: repoRoot },
  );
  return out.split("\n").filter(Boolean).filter((rel) => !isExempt(rel));
}

function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (code[i] === "\n") line += 1;
  return line;
}

/**
 * Scan ONE module. Pure: source text in, findings out — so the CLI and the
 * pinned tests share exactly one matcher and can never drift.
 *
 * @param {string} rel  repo-relative path (decides which allowlists apply)
 * @param {string} source raw file contents
 */
export function scanModule(rel, source) {
  const code = stripComments(source);
  const findings = [];

  // R1 — a card DEFINITION outside its owner module.
  for (const [kind, spec] of Object.entries(CARD_OWNERS)) {
    if (rel === spec.owner) continue;
    const re = cardDefinitionPattern(spec.component);
    let m;
    while ((m = re.exec(code)) !== null) {
      findings.push({
        rule: "R1",
        detail: `a second '${kind}' card implementation (${m[1]}) — the sole owner is ${spec.owner}`,
        line: lineOf(code, m.index),
      });
    }
  }

  // R2 — a retired parallel renderer, back by name.
  for (const parallel of RETIRED_PARALLELS) {
    if (parallel.allow.includes(rel)) continue;
    const re = new RegExp(parallel.re.source, parallel.re.flags);
    let m;
    while ((m = re.exec(code)) !== null) {
      findings.push({
        rule: "R2",
        detail: `retired parallel renderer '${parallel.id}' is back — ${parallel.fix}`,
        line: lineOf(code, m.index),
      });
    }
  }

  // R3 — a card mount with no host declaration in this file.
  const mounts = [...code.matchAll(CARD_MOUNT_RE)];
  if (mounts.length > 0 && !HOST_PROVIDER_RE.test(code)) {
    const parent = HOST_PROVIDED_BY_PARENT[rel];
    if (!parent) {
      findings.push({
        rule: "R3",
        detail:
          `mounts ${[...new Set(mounts.map((m) => m[1]))].join(", ")} with no ` +
          "<LifecycleCardSurfaceProvider> in this file — a card must be host-declared " +
          "(add the provider, or record the providing parent in HOST_PROVIDED_BY_PARENT)",
        line: lineOf(code, mounts[0].index),
      });
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}

/**
 * R4 — the registry maps each lifecycle kind exactly once. Separate from
 * scanModule because it is a property of ONE named module, not of every file.
 */
export function scanRegistry(source) {
  const code = stripComments(source);
  const findings = [];
  for (const kind of REGISTRY_KINDS) {
    // The row and its WHOLE right-hand side in one match: everything from the
    // colon to the value's own terminator, which in an object literal is the
    // next `,` or the closing `}`. The side is then required to be a BARE
    // IDENTIFIER — the registry is a map of imported components, so that is its
    // only legal shape, and a call, an inline arrow, a member expression, a
    // ternary or a string is reported as a row whose owner could not be read.
    //
    // TWO FAIL-OPENS, both found by cinatra#2861's Codex rounds, both fixed
    // here, and recorded because the shape of the mistake is instructive: each
    // time, the pattern read only the FRONT of the value and the expected name
    // was sitting there.
    //   · capturing a leading identifier — `verification_summary:
    //     VerificationSummaryCard(kind),` passed, because the capture stopped at
    //     the `(` and the prefix equalled the owner.
    //   · stopping the capture at a NEWLINE — the same call written across two
    //     lines passed for the same reason. A newline does not end a JavaScript
    //     value, so it may not end the capture either.
    // So the terminator set is `,` and `}` ONLY. Whitespace, newlines and the
    // rest of a continued expression stay inside the captured side, where the
    // bare-identifier test can see them and refuse them.
    const hits = [
      ...code.matchAll(new RegExp(String.raw`^\s*${kind}\s*:([^,}]*)`, "gm")),
    ];
    if (hits.length !== 1) {
      findings.push({
        rule: "R4",
        detail: `the renderable-view registry maps '${kind}' ${hits.length} time(s) — expected exactly 1`,
        line: hits.length > 0 ? lineOf(code, hits[0].index) : 1,
      });
      continue;
    }
    const expected = CARD_OWNERS[kind]?.component;
    const side = hits[0][1].trim();
    const actual = /^[A-Za-z_$][\w$]*$/.test(side) ? side : null;
    if (expected && actual !== expected) {
      findings.push({
        rule: "R4",
        detail:
          `the renderable-view registry dispatches '${kind}' to ` +
          `${actual ? `'${actual}'` : "an expression this gate cannot read"} — ` +
          `CARD_OWNERS names '${expected}' (${CARD_OWNERS[kind].owner}) as the one renderer of this kind`,
        line: lineOf(code, hits[0].index),
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The completeness rules — R5 to R9
// ---------------------------------------------------------------------------

/** Skip a string or template literal from `i`; returns the index after it. */
function skipQuoted(code, i) {
  const quote = code[i];
  for (let j = i + 1; j < code.length; j++) {
    if (code[j] === "\\") {
      j += 1;
      continue;
    }
    if (code[j] === quote) return j + 1;
  }
  return code.length;
}

/**
 * The index just past the block that opens at `open` (a `{`, `(` or `[`),
 * skipping quoted spans so a brace inside a string cannot end it early.
 */
export function matchBlock(code, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const close = pairs[code[open]];
  if (close === undefined) return -1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipQuoted(code, i) - 1;
      continue;
    }
    if (ch === code[open]) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Remove the branches that can never run: `if (false) {…}`, `if (0) {…}` and the
 * `false && (…)` / `0 && (…)` short-circuit form.
 *
 * This is what stops an anchor from being satisfied by dead text. It is
 * deliberately narrow — a statically-false literal is the shape that reads as
 * "the anchor is here" while nothing ever renders it. A branch that is false for
 * a runtime reason is NOT dead code and is left alone; the rendered owner test
 * is what proves those paths draw.
 */
export function stripUnreachable(code) {
  let out = code;
  for (const guard of [/\bif\s*\(\s*(?:false|0)\s*\)\s*\{/g, /(?:\bfalse|(?<![\w.])0)\s*&&\s*\(/g]) {
    for (;;) {
      guard.lastIndex = 0;
      const m = guard.exec(out);
      if (m === null) break;
      const open = m.index + m[0].length - 1;
      const end = matchBlock(out, open);
      if (end < 0) break;
      out = out.slice(0, m.index) + out.slice(end);
    }
  }
  return out;
}

/**
 * The body of one top-level component, or `null` when it is not defined here.
 * Handles the `function X(…) {…}` and `const X = (…) => {…}` forms.
 */
export function extractComponentBody(code, component) {
  const decl = new RegExp(
    String.raw`\b(?:export\s+)?(?:function\s+${component}\s*\(|const\s+${component}\s*(?::[^=]+)?=\s*(?:function\s*)?\()`,
  );
  const m = decl.exec(code);
  if (m === null) return null;
  const paramsOpen = code.indexOf("(", m.index + m[0].length - 1);
  const afterParams = matchBlock(code, paramsOpen);
  if (afterParams < 0) return null;
  const bodyOpen = code.indexOf("{", afterParams);
  if (bodyOpen < 0) return null;
  const bodyEnd = matchBlock(code, bodyOpen);
  if (bodyEnd < 0) return null;
  return code.slice(bodyOpen, bodyEnd);
}

/**
 * Is `anchor` emitted anywhere in `code`?
 *
 * The ratified list is written in TWO forms and both are kept verbatim, because
 * a closed set stops being closed the moment it is paraphrased:
 *   `[data-lifecycle-card="recommendation_hold"]` — an attribute selector, with
 *       or without a value (`[data-run-recommendation-chip-row]`);
 *   `review-gate-card` — a bare conformance id.
 */
export function emitsAnchor(code, anchor) {
  const selector = /^\[([a-zA-Z0-9-]+)(?:=["']([^"']+)["'])?\]$/.exec(anchor);
  if (selector === null) {
    return new RegExp(String.raw`data-conformance-id=["']${anchor}["']`).test(code);
  }
  const [, attr, value] = selector;
  return value === undefined
    ? new RegExp(String.raw`\b${attr}(?==|\s|>|$)`, "m").test(code)
    : new RegExp(String.raw`\b${attr}=["']${value}["']`).test(code);
}

/**
 * The attributes every owner ROOT must carry, so a card can be addressed by the
 * host it drew on and the state it drew in. Ratified with the closed anchor
 * sets; a capture that cannot say which host and which state it photographed is
 * not evidence of a matrix cell.
 */
export const REQUIRED_ROOT_ATTRIBUTES = Object.freeze([
  "data-lifecycle-card-host",
  "data-lifecycle-card-state",
]);

/**
 * Does the RENDERED owner test read `anchor` back out of the DOM?
 *
 * A test may address an anchor as a selector (`[data-action="skip-…"]`) or as an
 * attribute in rendered HTML (`toContain('data-action="skip-…"')`). Both are the
 * same assertion about the same pixels, so both count. What does NOT count is a
 * test that never names the anchor at all.
 *
 * THE LIMIT, stated rather than left to be discovered: this function is LEXICAL
 * over whatever text it is handed, so on its own it counts an anchor named in a
 * comment. The GATE does not hand it that text: the window comes from
 * `extractTestBlock`, which searches and slices a comment-stripped copy, and the
 * caller strips statically-dead branches on top. What survives the strip is an
 * anchor named in a live STRING that nothing renders — a fixture list, an
 * unused constant. So this rule still cannot be the proof on its own, and it is
 * not asked to be: the same named test is EXECUTED by vitest, where the anchor
 * has to come back off real DOM. Negative fixtures pin both readings so they
 * stay known rather than assumed.
 */
export function proofAssertsAnchor(proofSource, anchor) {
  const selector = /^\[([a-zA-Z0-9-]+)(?:=["']([^"']+)["'])?\]$/.exec(anchor);
  if (selector === null) return proofSource.includes(anchor);
  const [, attr, value] = selector;
  if (value === undefined) return proofSource.includes(attr);
  return (
    proofSource.includes(`${attr}="${value}"`) || proofSource.includes(`${attr}='${value}'`)
  );
}

/**
 * The body of ONE named test, or `null` when that test is not in this file.
 *
 * This is what stops a proof from being a file-wide substring match. A rendered
 * assertion counts only when it sits INSIDE the test the contract names, so a
 * card cannot borrow the assertions of some unrelated case that happens to live
 * in the same file — which is exactly how an empty proof test passed before.
 *
 * HOW THE WINDOW IS CHOSEN, and what that rules out. The search runs over a
 * COMMENT-STRIPPED copy of the file, and it matches a test DECLARATION — an
 * `it(`/`test(` (with any `.only`/`.skip`/`.concurrent` modifiers) whose first
 * argument is the quoted name — not a bare quoted occurrence of the name. Three
 * shapes that used to select the wrong window therefore cannot any more:
 *   - the name repeated inside a COMMENT, which is not in the searched text;
 *   - the name as a `describe` title or as a plain string somewhere else, which
 *     is not a test declaration;
 *   - the enclosing `(` guessed by scanning backwards, which could open at any
 *     arbitrary paren before the name; the block now opens at the declaration's
 *     own paren.
 * When several declarations share one name the EARLIEST is taken, and that is
 * chosen across all three quote characters at once rather than by quote-type
 * priority — so the window is the first test with that name, whichever quote it
 * was written with.
 *
 * THE LIMIT that remains, stated rather than left to be discovered: this is
 * still LEXICAL, not a parse. Two tests really sharing one name read as the
 * first of them, and the end of the block is found by brace matching, which
 * skips quoted spans but not a regex literal carrying an unbalanced brace
 * (`/\{/`) — such a literal inside the named test can end the window early.
 * A table-driven declaration (`it.each([…])("name")`) is not recognised as a
 * declaration at all, so a contract may not name one. What the rule buys is a
 * narrower window than the file, not a guarantee that the window is the right
 * test. It cannot be the proof on its own, and it is not asked to be: the same
 * named test is EXECUTED by vitest, where a wrong or absent body fails on its
 * own.
 */
export function extractTestBlock(source, testName) {
  const code = stripComments(source);
  const name = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const decl = new RegExp(
    String.raw`\b(?:it|test)(?:\s*\.\s*\w+)*\s*\(\s*(["'\`])${name}\1`,
    "g",
  );
  const m = decl.exec(code);
  if (m === null) return null;
  const open = code.indexOf("(", m.index);
  if (open < 0) return null;
  const end = matchBlock(code, open);
  if (end < 0) return null;
  return code.slice(open, end);
}

/**
 * Does `block` COUNT the rendered roots and require exactly one?
 *
 * The runtime property the epic states is "one rendered instance per kind ×
 * host". A presence check cannot see a second instance; only a count can. So
 * the named test must select every root and assert the length is one.
 */
export function assertsExactlyOneInstance(block, rootSelector) {
  const selector = rootSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    String.raw`querySelectorAll\(\s*["'\`][^"'\`]*${selector}[^"'\`]*["'\`]\s*\)[\s\S]{0,200}?(?:toHaveLength\(\s*1\s*\)|length\s*\)?\s*\)?\s*\.toBe\(\s*1\s*\))`,
  ).test(block);
}

/** An `expect(…)` argument that carries no reading — a bare literal constant. */
const LITERAL_SUBJECT = /^(?:true|false|null|undefined|-?\d+(?:\.\d+)?|["'`][^"'`]*["'`])$/;

/**
 * Does `block` assert something ABOUT `subject` — the thing it is named as the
 * proof of?
 *
 * "The test is not empty" was too weak to be a proof. ANY live `expect(` used to
 * satisfy it, so `expect(true).toBe(true)`, an expectation parked in a branch
 * that never runs, or an assertion about something else entirely all read as a
 * proof of the picker. Two production adapters could then be declared exclusive
 * by a test that never touched the selector.
 *
 * So an expectation counts here only when BOTH hold:
 *   LIVE AND NOT VACUOUS  it survives comment stripping and dead-branch
 *                         stripping, and its `expect(…)` argument is not a bare
 *                         literal constant — `expect(true).toBe(true)` and
 *                         `expect(1).toBe(1)` carry no reading of anything;
 *   ABOUT THE SUBJECT     the subject's identifier appears in that same
 *                         expectation statement, in the argument or in the
 *                         matcher, so the assertion reads the thing under proof
 *                         rather than a neighbour of it.
 *
 * THE LIMIT that remains: this is LEXICAL inside the extracted block. A live
 * expectation that names the subject and asserts something trivial about it
 * still reads as an assertion, and the subject may be named through a wrapper
 * rather than called directly. It cannot be the proof on its own, and it is not
 * asked to be: the same named test is EXECUTED by vitest, where the expectation
 * has to hold. Negative fixtures pin the shapes it DOES reject — an empty proof,
 * one whose only assertion is commented out, one that borrows a neighbour's, a
 * vacuous `expect(true).toBe(true)`, an expectation inside `if (false)`, and one
 * that never names the subject — so the reading stays known rather than assumed.
 */
export function assertsAbout(block, subject) {
  const live = stripUnreachable(stripComments(block));
  const named =
    subject === undefined || subject === null
      ? null
      : new RegExp(String.raw`\b${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`);
  const re = /\bexpect\s*\(/g;
  for (let m = re.exec(live); m !== null; m = re.exec(live)) {
    const open = live.indexOf("(", m.index);
    const end = matchBlock(live, open);
    if (end < 0) continue;
    const arg = live.slice(open + 1, end - 1).trim();
    if (LITERAL_SUBJECT.test(arg)) continue;
    if (named === null) return true;
    // The statement is the expectation plus its matcher chain, up to the `;`
    // that ends it — `expect(x).toBe(pick(y))` names the subject in the matcher.
    const semi = live.indexOf(";", end);
    const statement = live.slice(m.index, semi < 0 ? live.length : semi);
    if (named.test(statement)) return true;
  }
  return false;
}

/** Every requirement a kind has recorded as open, flattened to plain strings. */
export function openRequirements(contract) {
  const out = new Set();
  for (const o of contract.openObligations ?? []) for (const r of o.requires) out.add(r);
  return out;
}

/**
 * R5/R6/R7 for ONE drawn kind. Pure over the sources it is handed, so a fixture
 * drives exactly what CI runs.
 *
 * @param {string} kind
 * @param {object} contract  the row from LIFECYCLE_CARD_CONTRACTS
 * @param {Record<string,string>} sourcesByRel  owner + composed module sources
 */
export function scanOwnerModule(kind, contract, sourcesByRel) {
  const findings = [];
  const push = (rule, detail, file = contract.owner) =>
    findings.push({ rule, file, line: 1, detail });

  const ownerRaw = sourcesByRel[contract.owner];
  if (typeof ownerRaw !== "string") {
    push("R5", `'${kind}': the declared owner module is not readable — a named owner must exist`);
    return findings;
  }
  const owner = stripComments(ownerRaw);

  // R5 — the owner module really defines the component it is named for.
  if (!new RegExp(String.raw`\b(?:export\s+)?(?:function|const|class)\s+${contract.component}\b`).test(owner)) {
    push("R5", `'${kind}': ${contract.owner} does not define ${contract.component}`);
  }

  const body = extractComponentBody(owner, contract.component);
  if (body === null) {
    push("R5", `'${kind}': ${contract.component} has no readable component body in ${contract.owner}`);
  } else {
    const live = stripUnreachable(body);
    // R7 — an owner that never returns DOM draws nothing. The empty stub and the
    // null-returning owner both land here.
    if (!/return\s*[(<]/.test(live)) {
      push(
        "R7",
        `'${kind}': ${contract.component} never returns drawn DOM — an owner that only returns null is a placeholder with a name`,
      );
    }
    // R6 — a body parameter the component never reads is a body it does not use.
    for (const param of contract.body.params) {
      if (!new RegExp(String.raw`\b${param}\b`).test(live)) {
        push(
          "R6",
          `'${kind}': ${contract.component} declares the body parameter '${param}' and never reads it — the card would draw something the server did not authorize`,
        );
      }
    }
  }

  // R6/R7 — the owner plus everything it composes. The floor lives in its own
  // module; anchors and fields it consumes belong to the card that mounts it.
  const parts = [owner];
  for (const rel of contract.composes) {
    const src = sourcesByRel[rel];
    if (typeof src !== "string") {
      push("R5", `'${kind}': the composed module ${rel} is not readable`, rel);
      continue;
    }
    parts.push(stripComments(src));
  }
  const consumed = parts.join("\n");
  const drawn = parts.map(stripUnreachable).join("\n");

  if (!new RegExp(String.raw`\b${contract.body.validator}\b`).test(consumed)) {
    push(
      "R6",
      `'${kind}': the owner never reads its authorized body through ${contract.body.validator} — an unvalidated body is not an authorized one`,
    );
  }
  for (const field of contract.body.fields) {
    if (!new RegExp(String.raw`\.${field}\b`).test(consumed)) {
      push("R6", `'${kind}': the authorized body field '${field}' is never consumed`);
    }
  }
  const open = openRequirements(contract);
  for (const anchor of contract.anchors) {
    if (emitsAnchor(drawn, anchor)) continue;
    if (open.has(anchor)) continue; // recorded as an open obligation, not hidden
    const dead = parts.some((p) => emitsAnchor(p, anchor));
    push(
      "R7",
      dead
        ? `'${kind}': the anchor '${anchor}' is emitted only from a branch that can never run`
        : `'${kind}': the ratified anchor '${anchor}' is never emitted`,
    );
  }
  // "plus exactly one outcome anchor of A / B / C" — every branch must be
  // reachable, so the owner emits all of them and draws one at a time.
  for (const alt of contract.anchorsOneOf?.of ?? []) {
    if (emitsAnchor(drawn, alt) || open.has(alt)) continue;
    push("R7", `'${kind}': the ratified '${contract.anchorsOneOf.id}' anchor '${alt}' is never emitted, so that outcome cannot be drawn`);
  }
  // Every owner ROOT carries its host and its state.
  for (const attr of REQUIRED_ROOT_ATTRIBUTES) {
    if (new RegExp(String.raw`\b${attr}\b`).test(drawn) || open.has(attr)) continue;
    push("R7", `'${kind}': the owner root never emits '${attr}' — a card that cannot say which host and state it drew on cannot be captured as a matrix cell`);
  }
  return findings;
}

/**
 * R8 for ONE drawn kind — the RUNTIME instance rule, not a callsite count.
 *
 * The rule the epic states is: exactly ONE rendered card instance per kind ×
 * host at runtime; every production callsite enumerated, host-declared, and
 * proven mutually exclusive where more than one adapter serves the same host.
 *
 * A literal one-mount-per-host rule would be WRONG here, and rejecting a correct
 * tree is how a gate gets disabled. The run card is legitimately served by two
 * exclusive adapters, chosen by a branch selector: one panel draws for a leaf
 * run, the other for a stepped one, and never both. So this rule checks the
 * three properties that actually make "one instance" true:
 *
 *   ENUMERATED   every callsite in the tree is declared here, and every declared
 *                module really mounts the component.
 *   HOST-DECLARED each adapter sits under a host declaration (R3 proves the file
 *                carries the provider; this rule proves the adapter was claimed).
 *   EXCLUSIVE    a host with more than one adapter names the selector that picks
 *                between them, and a test that proves the selector covers every
 *                branch. Two adapters and no named selector is two instances
 *                waiting to happen.
 *
 * A DEV-PREVIEW adapter is enumerated like any other and does NOT count as a
 * production adapter: it draws only inside an explicitly opened preview and
 * addresses a different run. Hiding it would leave a real callsite unenumerated;
 * counting it as production would claim a host mount nobody ships.
 *
 * @param {string} kind
 * @param {object} contract
 * @param {string[]} mountedIn  modules where the component is mounted
 * @param {string} registrySource  the renderable-view registry's source
 * @param {(rel: string) => string|null} readModule  for the exclusion check
 */
export function scanHostMounts(kind, contract, mountedIn, registrySource, readModule = () => null) {
  const findings = [];
  const push = (detail, file = contract.owner) =>
    findings.push({ rule: "R8", file, line: 1, detail });
  const declaredMounts = new Set();
  const registryModules = new Set();

  for (const host of LIFECYCLE_CARD_HOSTS) {
    const entries = contract.hosts[host];
    if (entries === null || entries === undefined) continue;
    const production = entries.filter((e) => e.surface !== "dev_preview");
    for (const e of entries) {
      if (!e.why || e.why.length < 20) {
        push(`'${kind}': the adapter ${e.module} on host '${host}' does not say what it is — every enumerated callsite states its own reason`, e.module);
      }
      if (e.surface !== "production" && e.surface !== "dev_preview") {
        push(`'${kind}': the adapter ${e.module} on host '${host}' declares no surface — production or dev_preview`, e.module);
      }
      // WHERE ON THE HOST IT DRAWS. A mount that cannot say this cannot be
      // checked against a plan that rules on it (see LIFECYCLE_MOUNT_REGIONS).
      if (!LIFECYCLE_MOUNT_REGIONS.includes(e.region)) {
        push(
          `'${kind}': the adapter ${e.module} on host '${host}' declares no region — one of ${LIFECYCLE_MOUNT_REGIONS.join(", ")}. A mount that does not say WHERE it draws records "a step in the rail" and "a card beside the review card" identically`,
          e.module,
        );
      }
      if (e.adapter === "registry") registryModules.add(e.module);
      else declaredMounts.add(e.module);
    }
    // More than one PRODUCTION adapter on one host needs a proven picker.
    if (production.length > 1) {
      const exclusion = (contract.exclusions ?? {})[host];
      if (!exclusion || !exclusion.selector || !exclusion.module || !exclusion.proof) {
        push(
          `'${kind}': host '${host}' has ${production.length} production adapters and no named mutual-exclusion selector — two adapters with nothing choosing between them is two rendered instances`,
        );
      } else {
        const source = readModule(exclusion.module);
        if (source === null) {
          push(`'${kind}': the exclusion selector's module ${exclusion.module} is not readable`, exclusion.module);
        } else if (!new RegExp(String.raw`\bexport\s+(?:function|const)\s+${exclusion.selector}\b`).test(stripComments(source))) {
          push(`'${kind}': ${exclusion.module} does not export the exclusion selector '${exclusion.selector}' — the picker must be readable, not implied`, exclusion.module);
        }
        // The proof is read the way the instance proof is read: the named test
        // is EXTRACTED and must assert something ABOUT THE PICKER inside its own
        // body. A file-wide match on the test name passes for a test that is
        // empty; "asserts anything" passes for `expect(true).toBe(true)` and for
        // an assertion about an unrelated subject. Neither is a proof of the
        // claim the row makes.
        const proof = readModule(exclusion.proof.file);
        const proofBlock = proof === null ? null : extractTestBlock(proof, exclusion.proof.testName);
        if (proofBlock === null) {
          push(`'${kind}': the exclusion proof "${exclusion.proof.testName}" is not in ${exclusion.proof.file} — an unproven picker is an assumption`, exclusion.proof.file);
        } else if (!assertsAbout(proofBlock, exclusion.selector)) {
          push(`'${kind}': the exclusion proof "${exclusion.proof.testName}" in ${exclusion.proof.file} runs no live expectation that reads '${exclusion.selector}' — an empty, vacuous or unrelated assertion under a picker's name proves no branch of it`, exclusion.proof.file);
        }
      }
    }
  }

  const found = new Set(mountedIn);
  for (const rel of declaredMounts) {
    if (!found.has(rel)) {
      push(`'${kind}': ${rel} is declared as a host adapter and does not mount ${contract.component} — a missing host adapter`, rel);
    }
  }
  for (const rel of found) {
    if (declaredMounts.has(rel) || registryModules.has(rel)) continue;
    push(`'${kind}': ${rel} mounts ${contract.component} and is not an enumerated adapter — an unenumerated callsite is a second rendered instance nobody chose`, rel);
  }

  // A registry-served host is served by the registry ROW, not by a JSX mount.
  if (registryModules.size > 0 && typeof registrySource === "string") {
    const code = stripComments(registrySource);
    const row = new RegExp(String.raw`^\s*${kind}\s*:\s*${contract.component}\b`, "m");
    if (!row.test(code)) {
      push(
        `'${kind}': the renderable-view registry does not dispatch this kind to ${contract.component} — the transcript hosts would draw something else`,
        REGISTRY_MODULE,
      );
    }
  }
  return findings;
}

/**
 * R5 at the TABLE level, plus R9's expiry. Shape only — no file reads — so the
 * fixtures can hand it a synthetic table.
 */
export function auditContracts(contracts = LIFECYCLE_CARD_CONTRACTS) {
  const findings = [];
  const push = (rule, detail) => findings.push({ rule, file: "scripts/audit/chat-hitl-one-card-gate.mjs", line: 1, detail });

  const kinds = Object.keys(contracts);
  for (const kind of LIFECYCLE_CARD_KINDS) {
    if (!kinds.includes(kind)) push("R5", `'${kind}' has no contract row — every lifecycle card kind needs one named owner`);
  }
  for (const kind of kinds) {
    if (!LIFECYCLE_CARD_KINDS.includes(kind)) push("R5", `'${kind}' is not a lifecycle card kind`);
  }

  const byComponent = new Map();
  const byOwner = new Map();
  for (const [kind, c] of Object.entries(contracts)) {
    if (c.status !== "DRAWN" && c.status !== "PLACEHOLDER") {
      push("R5", `'${kind}': status "${c.status}" is neither DRAWN nor PLACEHOLDER`);
      continue;
    }
    // The epic's table gained two columns — component owner and wire carriage.
    // The contract mirrors that shape, and the carriage is checked against the
    // protocol rather than against the prose, so the two can never disagree.
    if (LIFECYCLE_CARD_CARRIAGE[kind] !== undefined && c.wireCarriage !== LIFECYCLE_CARD_CARRIAGE[kind]) {
      push("R5", `'${kind}': the contract carries it as ${c.wireCarriage ?? "nothing"}; the protocol says ${LIFECYCLE_CARD_CARRIAGE[kind]}`);
    }
    // An OPEN OBLIGATION is a ratified requirement the tree does not meet yet.
    // It must name what it requires, why it is open, and who closes it — a bare
    // exemption is the shape this whole round exists to end.
    for (const o of c.openObligations ?? []) {
      if (!Array.isArray(o.requires) || o.requires.length === 0) {
        push("R7", `'${kind}': the open obligation '${o.id}' names no requirement`);
      }
      for (const r of o.requires ?? []) {
        const known =
          (c.anchors ?? []).includes(r) ||
          (c.anchorsOneOf?.of ?? []).includes(r) ||
          REQUIRED_ROOT_ATTRIBUTES.includes(r);
        if (!known) {
          push("R7", `'${kind}': the open obligation '${o.id}' defers '${r}', which is not part of the ratified set — an obligation may only defer a requirement, never invent one`);
        }
      }
      if (!o.why || o.why.length < 40) push("R7", `'${kind}': the open obligation '${o.id}' does not say what is absent`);
      if (!o.closedBy || o.closedBy.length < 20) push("R7", `'${kind}': the open obligation '${o.id}' does not say who closes it`);
    }
    // An OPEN ANCHOR NAME is a control the ratified list names in prose only.
    // The set is closed, so nobody here may choose the missing name.
    for (const a of c.openAnchors ?? []) {
      if (!a.id || !a.describedAs || !a.why || a.why.length < 40) {
        push("R7", `'${kind}': the open anchor '${a.id ?? "?"}' must say what control it is and why it has no name yet`);
      }
    }
    if (c.anchorsOneOf !== undefined) {
      if (!Array.isArray(c.anchorsOneOf.of) || c.anchorsOneOf.of.length < 2) {
        push("R7", `'${kind}': a one-of anchor group needs at least two alternatives`);
      }
    }
    if (!c.component) push("R5", `'${kind}': no component name`);
    if (!Array.isArray(c.anchors) || c.anchors.length === 0) {
      push("R7", `'${kind}': no ratified anchor set — the requirement must be written down before the drawing`);
    }
    if (c.component) {
      const seen = byComponent.get(c.component);
      if (seen !== undefined) push("R5", `'${kind}' and '${seen}' both name ${c.component} — one component serving two kinds is how a placeholder passes for a card`);
      else byComponent.set(c.component, kind);
    }
    if (c.status === "DRAWN") {
      if (!c.owner) {
        push("R5", `'${kind}': DRAWN with no owner module`);
      } else {
        const seen = byOwner.get(c.owner);
        if (seen !== undefined) push("R5", `'${kind}' and '${seen}' share the owner module ${c.owner}`);
        else byOwner.set(c.owner, kind);
      }
      if (!c.renderedProof || !c.renderedProof.file || !c.renderedProof.testName) {
        push("R7", `'${kind}': DRAWN with no rendered owner test — the anchors would be a source-text claim`);
      }
      if (c.owner === S1_SHELL.owner || c.component === S1_SHELL.component) {
        push("R5", `'${kind}': DRAWN but pointing at the S1 shell, which draws no card`);
      }
    } else {
      if (c.owner !== null) push("R5", `'${kind}': PLACEHOLDER rows may not claim an owner — ${c.owner}`);
      if (!c.gap || c.gap.length < 40) push("R5", `'${kind}': PLACEHOLDER rows must say what is absent, in \`gap\` (a real sentence)`);
    }
    for (const host of LIFECYCLE_CARD_HOSTS) {
      if (!(host in (c.hosts ?? {}))) push("R8", `'${kind}': host '${host}' is not declared`);
    }
    const unmounted = LIFECYCLE_CARD_HOSTS.filter((h) => (c.hosts ?? {})[h] === null);
    if (unmounted.length > 0 && (!c.hostGap || c.hostGap.length < 40)) {
      push("R8", `'${kind}': ${unmounted.join(", ")} carry no mount and the row does not say why, in \`hostGap\``);
    }
  }

  // R9's expiry check is gone with the record it checked. It asked one
  // question — "is `verification_summary` DRAWN while the pending-retirement
  // record still stands?" — and cinatra#2789 answered it by drawing the card
  // and retiring the record in the same change. The BAN did not go anywhere:
  // it is the `page-direct-verification-composition` entry in
  // RETIRED_PARALLELS, which now identifies the retired drawing by §VII's own
  // anchors and is enforced on every module in the tree. See that entry for
  // what the record cost and why the allowlist is down to the owner.
  return findings;
}

/** The kinds with no drawing today, named. */
export function placeholderKinds(contracts = LIFECYCLE_CARD_CONTRACTS) {
  return Object.entries(contracts)
    .filter(([, c]) => c.status === "PLACEHOLDER")
    .map(([kind, c]) => ({ kind, design: c.design, gap: c.gap }));
}

/**
 * R5–R9 over the real tree.
 *
 * `complete` turns the honesty check into the DONE check: a placeholder kind and
 * an unmounted host stop being honest records and become the violations they
 * describe.
 */
export function collectContractViolations({
  contracts = LIFECYCLE_CARD_CONTRACTS,
  files,
  complete = false,
  repoRoot = DEFAULT_REPO_ROOT,
  readFileImpl = (p) => readFileSync(p, "utf8"),
} = {}) {
  const violations = [...auditContracts(contracts)];
  const read = (rel) => {
    try {
      return readFileImpl(resolve(repoRoot, rel));
    } catch {
      return null;
    }
  };
  const list = files ?? collectFiles(repoRoot);
  const registrySource = read(REGISTRY_MODULE);

  // Every production mount of every contracted component, in one pass.
  const mountsByComponent = new Map();
  const definitionsByComponent = new Map();
  for (const rel of list) {
    const code = stripComments(read(rel) ?? "");
    for (const [, c] of Object.entries(contracts)) {
      if (!c.component) continue;
      if (new RegExp(String.raw`<\s*${c.component}\b`).test(code)) {
        const seen = mountsByComponent.get(c.component) ?? [];
        seen.push(rel);
        mountsByComponent.set(c.component, seen);
      }
      if (cardDefinitionPattern(c.component).test(code)) {
        const seen = definitionsByComponent.get(c.component) ?? [];
        seen.push(rel);
        definitionsByComponent.set(c.component, seen);
      }
    }
  }

  for (const [kind, c] of Object.entries(contracts)) {
    if (c.status === "DRAWN") {
      const sources = {};
      for (const rel of [c.owner, ...c.composes]) {
        const src = read(rel);
        if (src !== null) sources[rel] = src;
      }
      violations.push(...scanOwnerModule(kind, c, sources));
      violations.push(
        ...scanHostMounts(kind, c, mountsByComponent.get(c.component) ?? [], registrySource, read),
      );
      if (c.renderedProof) {
        const proofFile = read(c.renderedProof.file);
        // The assertions must live INSIDE the named test, not merely in the
        // same file. A file-wide match lets one card borrow another case's
        // assertions, which is how an empty proof test passed before.
        const block = proofFile === null ? null : extractTestBlock(proofFile, c.renderedProof.testName);
        if (block === null) {
          violations.push({ rule: "R7", file: c.renderedProof.file, line: 1, detail: `'${kind}': the rendered owner test "${c.renderedProof.testName}" is not in this file` });
        } else {
          const openHere = openRequirements(c);
          // Read off text that RUNS. The window is already comment-stripped, and
          // the dead-branch strip removes an anchor parked in `if (false)`.
          const liveProof = stripUnreachable(block);
          for (const anchor of [...c.anchors, ...(c.anchorsOneOf?.of ?? [])]) {
            if (openHere.has(anchor)) continue;
            if (!proofAssertsAnchor(liveProof, anchor)) {
              violations.push({ rule: "R7", file: c.renderedProof.file, line: 1, detail: `'${kind}': the named rendered test never reads the anchor '${anchor}' off the card it mounted` });
            }
          }
          for (const attr of REQUIRED_ROOT_ATTRIBUTES) {
            if (openHere.has(attr)) continue;
            // Read OFF THE ROOT, not merely mentioned: the test must pull the
            // attribute from an element it selected.
            if (!new RegExp(String.raw`getAttribute\(\s*["']${attr}["']\s*\)`).test(block)) {
              violations.push({ rule: "R7", file: c.renderedProof.file, line: 1, detail: `'${kind}': the named rendered test never reads '${attr}' off the rendered root` });
            }
          }
        }
      }

      // The RUNTIME instance property: one rendered instance per kind × host.
      const jsxHosts = LIFECYCLE_CARD_HOSTS.filter((h) =>
        (c.hosts[h] ?? []).some((e) => e.adapter !== "registry" && e.surface === "production"),
      );
      if (!c.instanceProof) {
        violations.push({ rule: "R8", file: c.owner ?? REGISTRY_MODULE, line: 1, detail: `'${kind}': no rendered instance proof — module enumeration cannot show that exactly ONE card draws` });
      } else {
        const src = read(c.instanceProof.file);
        const block = src === null ? null : extractTestBlock(src, c.instanceProof.testName);
        if (block === null) {
          violations.push({ rule: "R8", file: c.instanceProof.file, line: 1, detail: `'${kind}': the instance proof "${c.instanceProof.testName}" is not in this file` });
        } else {
          if (!assertsExactlyOneInstance(block, c.instanceRootSelector)) {
            violations.push({ rule: "R8", file: c.instanceProof.file, line: 1, detail: `'${kind}': the instance proof never COUNTS the rendered roots (${c.instanceRootSelector}) and requires exactly one — a presence check cannot see a second instance` });
          }
          // The claimed host must be named in text that RUNS. `extractTestBlock`
          // already hands back a comment-stripped window, and the dead-branch
          // strip removes a host parked in `if (false)`. THE LIMIT, stated: a
          // host named in a live array the test iterates cannot be told apart
          // lexically from one named in a live array nothing reads — the shape
          // these proofs use drives every member, and vitest is what proves it,
          // because an undriven member would render nothing to assert on.
          const liveBlock = stripUnreachable(block);
          for (const host of c.instanceProof.hosts) {
            if (!liveBlock.includes(host)) {
              violations.push({ rule: "R8", file: c.instanceProof.file, line: 1, detail: `'${kind}': the instance proof claims host '${host}' and never drives it` });
            }
          }
          for (const host of jsxHosts) {
            if (!c.instanceProof.hosts.includes(host)) {
              violations.push({ rule: "R8", file: c.instanceProof.file, line: 1, detail: `'${kind}': host '${host}' has a production adapter and no rendered instance proof` });
            }
          }
        }
      }
      continue;
    }

    // PLACEHOLDER — the claim must be true in BOTH directions.
    const defined = definitionsByComponent.get(c.component) ?? [];
    if (defined.length > 0) {
      violations.push({
        rule: "R5",
        file: defined[0],
        line: 1,
        detail: `'${kind}' is recorded as a placeholder and ${c.component} is defined in ${defined.join(", ")} — flip the row, or delete the component`,
      });
    }
    if (complete) {
      violations.push({
        rule: "R5",
        file: "scripts/audit/chat-hitl-one-card-gate.mjs",
        line: 1,
        detail: `'${kind}' has no card of its own (${c.design}) — ${c.gap}`,
      });
    }
  }

  // An open obligation must still be OPEN. If the tree now satisfies it, the
  // record is stale and hides a requirement that is actually met — the same
  // both-directions honesty the placeholder rows carry.
  for (const [kind, c] of Object.entries(contracts)) {
    if (c.status !== "DRAWN" || !c.owner) continue;
    const parts = [c.owner, ...c.composes].map((rel) => stripComments(read(rel) ?? ""));
    const drawn = parts.map(stripUnreachable).join("\n");
    for (const o of c.openObligations ?? []) {
      const met = o.requires.every((r) =>
        REQUIRED_ROOT_ATTRIBUTES.includes(r)
          ? new RegExp(String.raw`\b${r}\b`).test(drawn)
          : emitsAnchor(drawn, r),
      );
      if (met) {
        violations.push({
          rule: "R7",
          file: c.owner,
          line: 1,
          detail: `'${kind}': the open obligation '${o.id}' is recorded as unmet and the owner now emits every part of it — strike the record here, in whichever change lands second`,
        });
      }
    }
  }

  if (complete) {
    for (const [kind, c] of Object.entries(contracts)) {
      for (const o of c.openObligations ?? []) {
        violations.push({
          rule: "R7",
          file: c.owner ?? "scripts/audit/chat-hitl-one-card-gate.mjs",
          line: 1,
          detail: `'${kind}': ${o.requires.join(", ")} — ${o.why} Closed by: ${o.closedBy}`,
        });
      }
      for (const a of c.openAnchors ?? []) {
        violations.push({
          rule: "R7",
          file: "scripts/audit/chat-hitl-one-card-gate.mjs",
          line: 1,
          detail: `'${kind}': ${a.describedAs} has no ratified anchor name — ${a.why}`,
        });
      }
      if (c.status !== "DRAWN") continue;
      for (const host of LIFECYCLE_CARD_HOSTS) {
        if ((c.hosts ?? {})[host] !== null) continue;
        violations.push({
          rule: "R8",
          file: c.owner ?? "scripts/audit/chat-hitl-one-card-gate.mjs",
          line: 1,
          detail: `'${kind}' has no production mount on host '${host}' — ${c.hostGap ?? "no reason recorded"}`,
        });
      }
    }
  }
  return violations;
}

export function collectViolations({
  files,
  repoRoot = DEFAULT_REPO_ROOT,
  readFileImpl = (p) => readFileSync(p, "utf8"),
} = {}) {
  const list = files ?? collectFiles(repoRoot);
  const violations = [];
  for (const rel of list) {
    for (const f of scanModule(rel, readFileImpl(resolve(repoRoot, rel)))) {
      violations.push({ file: rel, ...f });
    }
  }
  if (!files) {
    for (const f of scanRegistry(readFileImpl(resolve(repoRoot, REGISTRY_MODULE)))) {
      violations.push({ file: REGISTRY_MODULE, ...f });
    }
  }
  return violations;
}

function main(argv = []) {
  // THE REQUIRED GATE IS THE DONE-CHECK. It used to be opt-in, with the lenient
  // mode as the default — and a default that passes while two kinds are
  // placeholders makes "this gate fails on main" untrue in the only run anybody
  // actually makes. So the done-check is what you get when you run this script.
  // `--audit` is the lenient read, for a lane that wants to see whether it has
  // added a NEW dishonesty on top of the recorded ones. It is not the gate.
  // `--complete` is RECOGNISED rather than swallowed. #2785 rules that the
  // done-check has that name, so the name has to keep working — and an
  // unrecognised flag must not silently select a mode, which is how a typo
  // ("--audti") reads as a passing done-check.
  const KNOWN_FLAGS = new Set(["--audit", "--complete"]);
  const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(
      `[${LABEL}] unknown flag(s): ${unknown.join(", ")} — this gate takes ` +
        `no flag (the done-check), --complete (the same done-check, named) or --audit (the lenient read).`,
    );
    return 2;
  }
  // A flag passed twice is refused the way an unknown flag is. Accepting
  // `--complete --complete` silently while `--audti` exits 2 makes the argument
  // reading inconsistent, and an inconsistent reading is one a caller has to
  // guess at. One mode word, once.
  const repeated = [...new Set(argv.filter((a, i) => argv.indexOf(a) !== i))];
  if (repeated.length > 0) {
    console.error(`[${LABEL}] repeated flag(s): ${repeated.join(", ")} — pass each mode flag once.`);
    return 2;
  }
  if (argv.includes("--audit") && argv.includes("--complete")) {
    console.error(`[${LABEL}] --audit and --complete ask for different modes — pass one.`);
    return 2;
  }
  const complete = !argv.includes("--audit");
  const violations = [
    ...collectViolations(),
    ...collectContractViolations({ complete }),
  ];
  const placeholders = placeholderKinds();

  if (violations.length === 0) {
    if (complete) {
      console.log(`[${LABEL}] clean — every lifecycle card kind is drawn, consumed, mounted and proven.`);
      return 0;
    }
    console.log(
      `[${LABEL}] --audit: no NEW false claim — ${Object.keys(LIFECYCLE_CARD_CONTRACTS).length - placeholders.length}/` +
        `${Object.keys(LIFECYCLE_CARD_CONTRACTS).length} kinds drawn by a named owner, ` +
        `every mount host-declared, every placeholder recorded.`,
    );
    if (placeholders.length > 0) {
      console.log(
        `\nSTILL A PLACEHOLDER — the REQUIRED gate (no flag) fails on these: ` +
          placeholders.map((p) => `${p.kind} ${p.design}`).join("; "),
      );
    }
    return 0;
  }

  console.error(
    `[${LABEL}]${complete ? "" : " --audit:"} ${violations.length} violation(s):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.detail}`);
  }
  console.error(
    "\nThe epic's structural rule is ONE card per interaction, rendered on every host —" +
      "\nonly the frame adapts. A second renderer is not a smaller feature; it is a second" +
      "\nplace where 'approved' can come to mean something different — and a kind with NO" +
      "\nrenderer is not one implementation either, however few duplicates it has.",
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`[${LABEL}] fatal:`, e);
    process.exit(2);
  }
}

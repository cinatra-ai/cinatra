"use client";

// ---------------------------------------------------------------------------
// Conversation message-list view (cinatra#918 — split out of chat-page.tsx).
// ---------------------------------------------------------------------------
// This module is the LAZY BOUNDARY for the chat route's heavy renderers:
// ChatPage mounts it via next/dynamic, so marked + katex (./markdown-render →
// ./math-render), the mermaid wrapper (./mermaid-block) and the shiki wrapper
// (./syntax-highlight) load in their own client chunk only when a conversation
// actually renders — they no longer ride the initial /chat bundle (the empty
// state + composer stay eager). The `chart` renderable-view COMPONENT (formerly
// the in-tree recharts ChartEmbed) is now extension-provided
// (@cinatra-ai/chart-artifact, resolved server-side into the `chatViews` map by
// src/lib/chat-views-catalog.server.ts and dispatched here — cinatra#1626).
// Everything here is moved UNCHANGED from chat-page.tsx: same components,
// same markup, same class names. The only edits are mechanical — closure
// state became props (isStreaming(id) reads the same abort-controller
// registry via a callback; pause/edit handlers are threaded as callbacks) and
// the four identical embed/citation adjunct blocks are factored into local
// components that emit byte-identical DOM.

import { isRunStartToolName } from "./run-start-tool-names";
import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from "react";
import Link from "next/link";
import { PauseCircle, PlayCircle, Copy, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
// cinatra#2020 S5 (PR-4) — destructive-tool confirmation cards, mounted at the
// bottom of the conversation column (directly above the composer chat-page
// renders below this view) so a parked call is actionable regardless of
// scroll position. The prefix match on tool results is the poll trigger.
import {
  PendingToolConfirmationCards,
  PENDING_CONFIRMATION_RESULT_PREFIX,
} from "./pending-tool-confirmation-card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
// Direct per-icon imports — avoid Turbopack processing the full simple-icons barrel (see apis-page.tsx note)
import SiAnthropic from "@icons-pack/react-simple-icons/icons/SiAnthropic.mjs";
import SiGooglegemini from "@icons-pack/react-simple-icons/icons/SiGooglegemini.mjs";
import { cn } from "@/lib/utils";
import { CINATRA_LOGO } from "@/lib/cinatra-brand";
import type { Mentionable, WidgetDefinition, WidgetSubmitHandle } from "@cinatra-ai/sdk-ui";
import type { ChatGateDescriptor } from "@cinatra-ai/agents/client-entry";
import { highlightCodeAsync, type ThemeName } from "./syntax-highlight";
import { renderMarkdown, detectCharts, detectMermaidBlocks } from "./markdown-render";
import { MermaidBlock } from "./mermaid-block";
import {
  LifecycleCardSurfaceProvider,
  RenderableViewCard,
  RenderableViewFallback,
  type ApplyIntentRef,
} from "./renderable-views";
import { AppRouteLink } from "./app-route-link";
import { buildChartView } from "@cinatra-ai/agent-ui-protocol/renderable-views/chart";
import { FriendlyErrorBody } from "./chat-error-display"; // friendly error card (#534)
import { InlineAgentRunCard } from "./inline-agent-run-card";
// The ONE §V renderer, reached by its own SUBPATH rather than the client
// barrel: the barrel drags the whole agents client graph into every consumer
// (and into every test that mounts this list), while this leaf is all the
// transcript needs. Same reason `lifecycle-card-runtime` and `review-gate-card`
// are subpaths.
import {
  RECOMMENDATION_UNRESOLVED,
  RecommendationHoldCard,
  recommendationWasDecided,
  runCardWaitsForRecommendation,
  type RunRecommendationHoldResolution,
} from "@cinatra-ai/agents/run-recommendation-card";
// The ONE renderer of `agent_hitl_screen`, reached by its own SUBPATH for the
// same reason the §V renderer is: the barrel drags the whole agents client
// graph into every consumer, and this leaf is all the transcript needs.
import {
  AgentHitlScreenCard,
  type AgentHitlScreenCarry,
} from "@cinatra-ai/agents/agent-hitl-screen-card";
// The turn's own register for the settled schedule card (cinatra#3174), reached
// by the same subpath the host declaration is.
import { SettledScheduleRegisterProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
// The run's OWN reading of the moment it stands at (cinatra#3044), reached by
// the same subpath the host declaration is, and for the same reason.
import {
  isConversationMomentCardKind,
  parseRunMomentCard,
  runMomentCardIsOpen,
  ScheduleReadingReport,
  useRunMomentCard,
  type RunMomentCardReader,
  type ScheduleCardReading,
} from "@cinatra-ai/agents/lifecycle-card-runtime";
// The one wording a start answers with, and the correction the conversation
// applies to a sentence that has been outlived by its own card (cinatra#3044).
// The zero-dependency run-status leaf, reached by its own subpath.
import {
  correctRunStartSentenceForFiredRecurringSchedule,
  correctRunStartSentenceForFiredSchedule,
  correctRunStartSentenceForScheduleWait,
  runIsWaitingForItsSchedule,
  RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE,
  RUN_START_SCHEDULE_FIRED_SENTENCE,
  RUN_START_SCHEDULE_STOPPED_RECURRING_SENTENCE,
} from "@cinatra-ai/agents/run-status";
import { useConversationCredential } from "./conversation-credential";
import { runSeedRequest } from "./run-seed-request";
import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { UndoActionChip } from "./chat-undo-action-chip";
import { ResponseActionBar } from "./response-action-bar";
import {
  trimIncompleteEmbeds,
  getLiveProgressStatus,
  shouldShowLiveProgressStatus,
  formatToolName,
  lifecycleSlotParts,
  turnCarriesLifecycleItems,
  type AssistantMessagePart,
} from "./assistant-parts";
import { resolveAssistantDisplayName } from "./assistant-display-name";
import type { ChatWidgetRuntime, DetectedWidget } from "./widget-runtime";
import type { UiMessage, UiThoughtGroup } from "./types";

/**
 * The host declaration this conversation list wraps its cards in
 * (cinatra#2683, epic #2564 S8f).
 *
 * Derived from the provider's OWN props rather than restated, so the host/auth/
 * frame contract can never drift from `LifecycleCardSurfaceProvider` — including
 * its fail-closed credential rule (a non-cookie host without
 * `credentials: "omit"` declares no host at all, so the subtree draws no card
 * DOM and issues no request).
 *
 * WHY THIS IS A PROP AND NOT A CONSTANT. Before S8f the declaration was written
 * into this module as a literal `host="chat_thread"`, which was correct while
 * `/chat` was the only consumer. The widget conversation column now mounts the
 * SAME list, and a hardcoded `chat_thread` there would be the exact defect the
 * provider was hardened against: `chat_thread` is a cookie-session host, so the
 * declaration would have re-enabled ambient-cookie resolves INSIDE the broker
 * surface — answering, and deciding, as whoever else is signed in on that
 * browser. The host now says who it is; the default keeps `/chat` unchanged.
 */
export type LifecycleSurfaceDeclaration = Omit<
  Parameters<typeof LifecycleCardSurfaceProvider>[0],
  "children"
>;

/** `/chat`'s declaration — the literal this module used to hardcode. */
const CHAT_THREAD_LIFECYCLE_SURFACE: LifecycleSurfaceDeclaration = { host: "chat_thread" };

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function IconCheck() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
      <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" />
    </svg>
  );
}

function IconAgent() {
  return (
    <svg viewBox={CINATRA_LOGO.fullViewBox} fill="none" aria-hidden="true" style={{ height: "0.75rem", width: "auto", flexShrink: 0 }}>
      <path d={CINATRA_LOGO.brim} fill="currentColor" />
      <path d={CINATRA_LOGO.crown} fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Collapsible thought group (like ChatGPT's "Thought & used N tools")
// ---------------------------------------------------------------------------

function ThoughtGroupSection({ group, isLive }: { group: UiThoughtGroup; isLive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const toolCount = group.toolCalls.length;
  const allDone = group.toolCalls.every((tc) => tc.status === "completed");
  const seconds = group.thinkingSeconds ?? 0;

  // Build the summary label.
  let summary: string;
  if (isLive && !allDone) {
    summary = toolCount > 0 ? `Thinking & using ${toolCount} tool${toolCount === 1 ? "" : "s"}` : "Thinking...";
  } else if (toolCount > 0 && seconds > 1) {
    summary = `Thought for ${seconds}s & used ${toolCount} tool${toolCount === 1 ? "" : "s"}`;
  } else if (toolCount > 0) {
    summary = `Used ${toolCount} tool${toolCount === 1 ? "" : "s"}`;
  } else if (seconds > 1) {
    summary = `Thought for ${seconds} second${seconds === 1 ? "" : "s"}`;
  } else {
    return null; // Nothing interesting to show.
  }

  return (
    <div className="mb-2">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setExpanded((v) => !v)}
        className="flex h-auto items-center gap-1.5 px-0 py-0 text-xs text-muted-foreground transition hover:bg-transparent hover:text-foreground"
      >
        {isLive && !allDone ? (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
        ) : (
          <IconAgent />
        )}
        <span className="font-medium">{summary}</span>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`h-3 w-3 transition ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
      {expanded && group.toolCalls.length > 0 && (
        <div className="ml-4 mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
          {group.toolCalls.map((tc) => (
            <div key={tc.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              {tc.status === "running" ? (
                <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-muted-foreground" />
              ) : (
                <svg viewBox="0 0 16 16" fill="currentColor" className="h-2.5 w-2.5 text-muted-foreground">
                  <circle cx="8" cy="8" r="3" />
                </svg>
              )}
              <span>{tc.resultLabel || (tc.serverLabel && tc.serverLabel !== "cinatra"
                ? `${tc.serverLabel.replace(/^external-/, "").replace(/-connector$/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} · ${tc.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`
                : formatToolName(tc.name))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The `agent_run` part's own container.
// ---------------------------------------------------------------------------
//
// WHAT IT DRAWS, AND IN WHICH ORDER THE PERSON MEETS IT (plan section 6.2/6.4):
//
//   "An agentic run progress card is not visible while the recommended skills
//    can be selected, because they are being chosen before the agent actually
//    runs."
//   "The agentic run progress card appears once the skills are decided; no
//    skill inside it can be selected."
//
// So while the row is open the turn carries the assistant's text and the chip
// row and nothing else; the decision is what brings the run card in, with the
// settled chips above it. Both readings live in ONE container — the `agent_run`
// part's own slot — so the card that arrives lands exactly where the panel
// always was, not at the end of the turn.
//
// ONE RESOLVE ANSWERS BOTH QUESTIONS. The hold's authoritative state is read by
// the card (the ONE renderer of `recommendation_hold`) and published here; this
// container asks nothing itself, so the row and the run card cannot disagree
// about the same run. The same answer travels on into the run card, because the
// panel inside it must draw no skill picker for a run whose skills were already
// decided on this row.
//
// UNRESOLVED IS NOT "NOT HELD", and the difference is the whole correctness of
// this. Until the authoritative read lands, the answer may still be "held", so
// the run card WAITS — drawing it on "not yet" and taking it away on the answer
// would make the forbidden card visible, briefly and every single time, which is
// what the sentence above rules out. The price is paid by the ordinary run: its
// progress card appears one authoritative read later than it used to.
//
// A READ THAT CANNOT BE COMPLETED FAILS OPEN. When the card reports its read
// unreadable — the failure budget spent, or no lifecycle host to read on — the
// turn draws exactly what it drew before this rule existed. A dead endpoint must
// not be able to empty every conversation of its run cards.
//
// BOTH CONVERSATION HOSTS. This container is shared by `/chat` and the site
// widget, and nothing here is gated on the surface: the card selects its own
// transport from the declared host, and the shape of the turn is the same one.
function AgentRunTurnSlot({
  runId,
  slot,
  views,
  onActiveGateChange,
  onScheduleWaitChange,
  onScheduleFiredChange,
  onScheduleFiredRecurringChange,
  onApplyIntent,
  children,
}: {
  runId: string;
  /** The part index this container is the slot for (S9i's positional mark). */
  slot: number;
  /** The MOMENT views this step produced, raw, as the wire carries them
   *  (cinatra#3044) — the platform-injected parts whose card is this run's own
   *  reading. They are handed over UNRENDERED, because whether one is still the
   *  run's reading is a question only the run's row answers; every other view
   *  the step produced arrives already rendered in `children`. */
  views: readonly Record<string, unknown>[];
  onActiveGateChange?: (
    runId: string,
    gate: ChatGateDescriptor | null,
    instanceId: string,
  ) => void;
  /** THE TURN'S SENTENCE, TOLD WHAT THIS RUN IS DOING (cinatra#3044). The run's
   *  own row is read HERE, so the line above the card learns from the same
   *  reading the card itself is drawn from — never from a second poller and
   *  never from the frozen text. */
  onScheduleWaitChange?: (runId: string, waiting: boolean) => void;
  /** THE OTHER HALF OF THE SAME REPORT (cinatra#3044). A run whose one-off has
   *  FIRED is not waiting for anything, and the drawing gives that reading its
   *  own line; the answer is read here — off this container's own settled
   *  reading and the card's own body — and reported up to the parts list for
   *  exactly the reason the wait is: the sentence is a SIBLING of this
   *  container, not a child of it. */
  onScheduleFiredChange?: (runId: string, fired: boolean) => void;
  /** THE THIRD READING THE DRAWING HAS A LINE FOR (cinatra#3174 fix leg 3,
   *  criterion 4). A RECURRING schedule that has fired is not waiting and is
   *  not spent: §VI gives it its own sentence, and it is reported here on
   *  exactly the terms the other two are — off this container's own settled
   *  reading, up to the parts list that draws the sibling line. */
  onScheduleFiredRecurringChange?: (runId: string, firedRecurring: boolean) => void;
  /** The §6e apply-intent seam, threaded to the settled reading this container
   *  draws for exactly the reason the ordinary slotted views get it: the card is
   *  the same card, drawn through the same registry, and the gesture the widget
   *  owns must not depend on which mount drew it. */
  onApplyIntent?: (ref: ApplyIntentRef) => void;
  /** The renderable views this same step produced, drawn under the run card. */
  children?: ReactNode;
}) {
  const [hold, setHold] = useState<RunRecommendationHoldResolution>(
    RECOMMENDATION_UNRESOLVED,
  );
  const runCardWaits = runCardWaitsForRecommendation(hold);
  const decided = recommendationWasDecided(hold);

  // ONE SLOT, TWO READINGS (cinatra#3044).
  //
  // This container is the ONE place the drawing gives this run in the turn: the
  // progress reading while it works, the moment's card when a moment opens,
  // then that card's settled reading. A run-progress card stacked above the
  // moment's card is two readings in one slot, and the person then meets a card
  // that says "Awaiting input · No messages yet" standing between the
  // assistant's sentence and the form they are being asked to fill in.
  //
  // WHAT DECIDES IT IS THE RUN'S OWN ROW, read here rather than derived from
  // the turn's content, because the turn's content cannot answer it on either
  // road. The tab that STREAMED this turn will never see the part the platform
  // wrote into the stored turn afterwards — that is the silent wait — and a
  // RELOADED turn carries the part for ever, including after the run has moved
  // on, so the part's presence alone would keep the run's own reading away.
  //
  // THE READ IS THE RUN'S OWN, on the surface's own credential: the same route
  // the inline panel seeds from, which is what already turns "queued" into
  // "Awaiting input" on this page. That makes the moment reach the OPEN page
  // live, and the card mount here with no reload.
  const credential = useConversationCredential();
  const momentReader = useMemo<RunMomentCardReader | null>(() => {
    const request = runSeedRequest(credential, runId);
    // A host that cannot say who is asking reads NOTHING, and the turn keeps
    // exactly the reading it drew before this rule existed.
    if (!request) return null;
    return async (signal) => {
      const response = await fetch(request.url, { ...request.init, signal });
      if (!response.ok) return null;
      return parseRunMomentCard(await response.json());
    };
  }, [credential, runId]);
  const {
    card: momentCard,
    answered: momentAnswered,
    gaveUp: momentUnreadable,
  } = useRunMomentCard({ read: momentReader });
  const momentIsOpen = runMomentCardIsOpen(momentCard);
  // WHAT THE TURN'S OWN CONTENT CARRIES FOR THIS MOMENT. The platform-injected
  // part is the carriage a reload reads, and it is drawn HERE — inside the
  // producing part's own container — exactly as every slotted view is.
  //
  // USABLE OR NOT CARRIED AT ALL. `carriedMomentView` is what the caller
  // recognised as a moment's card AND could address: this container reconstructs
  // the payload from it, so a part with no reference, or one written at a schema
  // version this bundle does not know, is not something to hold a place with. It
  // is not silently dropped either — the caller leaves it in the ordinary
  // slotted views, where it draws the registry's own fallback exactly as any
  // other unreadable view does.
  const carriedMoment = views.find(carriedMomentView) as
    | { viewType?: string; ref?: string }
    | undefined;
  const turnCarriesMomentCard = carriedMoment !== undefined;

  // THE ONE MOMENT CARD THIS SLOT DRAWS, and where its identity comes from.
  //
  //   · THE ROW ANSWERED AND STATES THE MOMENT — the card is addressed by the
  //     reference the row states. The row is the authority: it is what the
  //     reload's resolver answers from, and it is the only thing that is right
  //     on BOTH roads (the streamed turn that carries no part, and the reloaded
  //     turn that carries one for ever).
  //   · THE ROW HAS NOT ANSWERED YET — the turn's own part holds the place, so
  //     a reader who opens a parked conversation sees the card immediately and
  //     a read that never lands never empties a turn that has one.
  //   · THE ROW ANSWERED AND STATES NO SUCH MOMENT — NOTHING. This is the
  //     "run right after setup" road: the run moved on, so its slot goes back
  //     to the run's own reading and the part it still carries draws nothing
  //     beside it. Leaving that part to draw itself is how a settled schedule
  //     card would end up standing next to the next gate's card.
  //   · THE RUN CANNOT BE READ AT ALL — nothing either, and the run's own
  //     reading comes back below. This is the fail-open case, and it fails open
  //     to ONE reading rather than to both: a card whose currency nothing can
  //     establish is exactly the stale card standing in the run's place that
  //     this whole rule exists to prevent, and drawing it beside the run's
  //     progress reading would be the two-readings defect again. Nothing is
  //     lost for good — the first read that lands brings the card back.
  const stillLooking = !momentAnswered && !momentUnreadable;

  // THE READING THE ROW ALREADY NAMED, KEPT (cinatra#3044 — the LIVE road).
  //
  // TWO ROADS CARRY THIS RUN'S SPENT SCHEDULE, AND ONLY ONE OF THEM IS A PART.
  // A RELOADED turn carries the platform-injected part in its stored content
  // for ever, so "what did this run already settle" can be read out of `views`.
  // The STREAMED turn cannot: the platform writes that part into the STORED
  // turn after the stream has closed, so the tab that sent the turn has an
  // `agent_run` part with no views on it and never will. The rule that
  // answered only from `views` therefore closed the reloaded road and left the
  // live one exactly as it was measured — four walks holding ZERO schedule
  // cards after the fire while the durable rows carried the part in the same
  // instant, and the run's own next screen standing in the card's place.
  //
  // THE LIVE ROAD'S CARRIAGE IS THIS CONTAINER'S OWN READ. While the schedule
  // is open the row NAMES it — that is how the card reaches this page at all —
  // and the row stops naming it the moment the run moves on. So the reference
  // is remembered as it goes past, and the settled reading is drawn from what
  // was remembered. It is this run's own schedule by construction: the
  // container is scoped to one run, and the row is that run's.
  //
  // ONE-WAY, AND NEVER RE-ARMED BY AN ABSENCE. Only a row that NAMES a schedule
  // writes here, so a read that fails, a run that never parked and a run that
  // has moved on all leave the memory exactly as it was — which is what makes
  // the fail-open case below still fail open to ONE reading.
  //
  // ADJUSTED DURING RENDER, not in an effect, for the same reason the card's own
  // wire reference is: an effect would let one paint go out with the reference
  // already gone from the row and not yet remembered here — a single frame in
  // which the card is drawn by neither road. This is React's own
  // adjust-state-when-the-input-changes shape: it is guarded by a comparison, so
  // it re-renders once when the row first names a schedule and never again.
  const [seenScheduleRef, setSeenScheduleRef] = useState<string | null>(null);
  const namedScheduleRef =
    momentIsOpen && momentCard.kind === SPENT_MOMENT_CARD_VIEW_TYPE
      ? momentCard.ref
      : null;
  if (namedScheduleRef !== null && seenScheduleRef !== namedScheduleRef) {
    setSeenScheduleRef(namedScheduleRef);
  }

  const momentKind = momentIsOpen
    ? momentCard.kind
    : stillLooking
      ? (carriedMoment?.viewType ?? null)
      : null;
  const momentRef = momentIsOpen
    ? momentCard.ref
    : stillLooking
      ? (carriedMoment?.ref ?? null)
      : null;

  // THE SPENT SCHEDULE KEEPS ITS OWN READING (cinatra#3044). The ratified
  // drawing's section VI, fifth reading:
  //
  //   "Once it has fired, the card is a reading. A one-off that has fired
  //    cannot be changed, so the rows go read-only - the values still legible,
  //    the pickers gone - and the card carries no floor at all: no hairline, no
  //    button, nothing to press. A spent schedule is still worth reading, so
  //    nothing is hidden; it simply asks nothing."
  //
  // The selection above answers ONE question: which card is the run's CURRENT
  // reading. It is not an answer to "what did this run already settle", and
  // reading it as one is what took the fired card off the conversation
  // altogether: the run moved on to its next screen, the row stopped naming the
  // schedule, and the part the turn still carries drew nothing at all.
  //
  // So a carried moment card the row does NOT name is not withdrawn - it is a
  // reading of its own, at its own place in this container, and the run's next
  // screen takes its own place beside it. Neither displaces the other, which is
  // the whole of what the drawing asks for.
  //
  // ONLY ONCE THE ROW HAS ANSWERED. Before the answer the placeholder above is
  // already holding this very part's place, and drawing it a second time as a
  // settled reading is the "once, never twice" defect the slot partition exists
  // to prevent. A read that never lands therefore changes nothing here: the
  // turn keeps exactly the reading it drew before this rule existed.
  //
  // AND THE CARD SAYS WHAT IT IS, never this container. The reading is drawn
  // through the SAME registry every other view goes through and resolves its own
  // state, so a schedule that has fired draws the read-only rows with no floor
  // and one that has not draws whatever it honestly is. This states only WHERE.
  //
  // ONE READING, ADDRESSED BY KIND AND NOT BY REFERENCE. A card reference is
  // MINTED, not derived: every encoding draws a fresh initialisation vector, so
  // the same run's same schedule has as many distinct references as the number
  // of times it was minted, and a run that re-enters its moment mints another.
  // Comparing the row's reference to the carried part's bytes therefore answers
  // "is this the same MINTING", which is not the question - two mintings of one
  // run's schedule would leave the older one standing beside the newer as a
  // second card for one schedule. This container is already scoped to ONE run,
  // and this kind's reference carries nothing but that run, so every carried
  // schedule part in it is a reading of the SAME schedule: the question is only
  // whether the row still names one, and the answer is one reading either way.
  //
  // AND THE READING IS ELECTED FROM WHICHEVER ROAD CARRIES IT. The turn's own
  // part first, because on the reloaded road it is the durable carriage and it
  // is what the reader arrived with; the reference this container itself saw
  // the row name otherwise, which is the only carriage the streamed turn has.
  // Never both: one schedule, one reading, on either road.
  const settledMomentViews = useMemo<readonly Record<string, unknown>[]>(() => {
    // The row still names this run's schedule: it is the run's CURRENT reading
    // and the mount below draws it. Nothing settled to draw here.
    if (!momentAnswered || momentKind === SPENT_MOMENT_CARD_VIEW_TYPE) return [];
    const carried = views.find((view) => view.viewType === SPENT_MOMENT_CARD_VIEW_TYPE);
    if (carried) return [carried];
    if (seenScheduleRef === null) return [];
    return [
      {
        viewType: SPENT_MOMENT_CARD_VIEW_TYPE,
        schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
        ref: seenScheduleRef,
      },
    ];
  }, [views, momentAnswered, momentKind, seenScheduleRef]);

  // WHAT THAT READING TURNED OUT TO BE, ASKED OF THE CARD (cinatra#3044).
  //
  // The container states WHERE a reading is drawn and never what it says, so it
  // does not know whether the schedule it kept was a one-off that is now spent
  // or a recurring one that is still live. The card resolved that answer to
  // draw itself, and it reports it back through the sink below — the same
  // "where the sentence and the card could disagree, the card is right" the
  // wait correction already follows, applied to the half the row cannot answer.
  const [settledReading, setSettledReading] = useState<ScheduleCardReading>("other");
  const scheduleHasFired =
    settledMomentViews.length > 0 && settledReading === "spent-one-off";
  useEffect(() => {
    onScheduleFiredChange?.(runId, scheduleHasFired);
    // A SLOT THAT LEAVES TAKES ITS ANSWER WITH IT, exactly as the wait does.
    if (!scheduleHasFired) return;
    return () => {
      onScheduleFiredChange?.(runId, false);
    };
  }, [onScheduleFiredChange, runId, scheduleHasFired]);

  // THE RECURRING HALF OF THE SAME REPORT (cinatra#3174 fix leg 3). Kept as its
  // own list rather than folded into the fired one: §VI draws a DIFFERENT
  // sentence over it, so a turn that could not tell the two apart would say
  // "the rows below are the record of it and cannot be changed" over a schedule
  // whose rows still take a change.
  const scheduleFiredRecurring =
    settledMomentViews.length > 0 && settledReading === "fired-recurring";
  useEffect(() => {
    onScheduleFiredRecurringChange?.(runId, scheduleFiredRecurring);
    if (!scheduleFiredRecurring) return;
    return () => {
      onScheduleFiredRecurringChange?.(runId, false);
    };
  }, [onScheduleFiredRecurringChange, runId, scheduleFiredRecurring]);

  // THE RUN'S PROGRESS READING STANDS DOWN while the moment's card owns the
  // slot. It also WAITS on a turn that carries the moment's card until the run
  // has been read: drawing it on "not yet" and taking it away on the answer
  // would show the stacked reading briefly, every single time a parked
  // conversation is opened. An ordinary run pays nothing for this — its turn
  // carries no moment card, so it draws exactly when it always did.
  //
  // AND THE WAIT FAILS OPEN. A read that never lands — a dead endpoint, a
  // surface with no credential — must not be able to leave a turn with nothing
  // in it at all: once the watch has given up unanswered, the run's own reading
  // comes back and the turn draws what it drew before this rule existed.
  const runCardStandsDown =
    momentIsOpen || (turnCarriesMomentCard && stillLooking);

  // THE SENTENCE ABOVE THE CARD MAY NOT CONTRADICT IT (cinatra#3044).
  //
  // The line that introduces this card was written when the run was dispatched
  // — before the schedule moment existed — and it says the run started. The
  // card beneath it is still asking when the run should happen, and the row
  // says the run has not run. One of the two readings is false, and it is not
  // the card's: "where the sentence and the card could disagree, the card is
  // right". So the run's own reading, already read here for the card, is
  // reported UP to the parts list, which corrects the platform's own sentence
  // for this run and leaves everything else in the turn alone.
  //
  // IT IS THE SAME READING, not a second one. Nothing extra is fetched, no
  // second poller is started, and a turn whose run never parks at a schedule
  // reports `false` once and is never touched again.
  const waitingForSchedule = momentIsOpen && runIsWaitingForItsSchedule(momentCard);
  useEffect(() => {
    onScheduleWaitChange?.(runId, waitingForSchedule);
    // A SLOT THAT LEAVES TAKES ITS ANSWER WITH IT: a run whose container
    // unmounts while still waiting must not leave the turn correcting a
    // sentence for a card that is no longer drawn.
    if (!waitingForSchedule) return;
    return () => {
      onScheduleWaitChange?.(runId, false);
    };
  }, [onScheduleWaitChange, runId, waitingForSchedule]);

  // WHEN THE RUN STARTS ASKING, AND HOW THIS TURN HEARS ABOUT IT
  // (cinatra#2930, lifecycle-b W3).
  //
  // The §V card above is live the moment this turn renders: a hold parks the run
  // BEFORE dispatch, so its answer is already there and one read on mount is the
  // whole story. The HITL screen is not like that — the agent parks MID-RUN, long
  // after the turn was drawn — so a card that read once on mount would answer
  // "no screen" and never ask again, and the person would sit in front of a run
  // that is waiting on them with nothing on screen to say so.
  //
  // The signal is the run panel's OWN: it already polls the run and publishes a
  // descriptor up this tree whenever the open gate's identity changes
  // (`onActiveGateChange`, the chat prompt-window lift). This slot listens to
  // that and hands the card a CHANGE SIGNAL built from the gate's identity, so
  // the card re-reads its authority exactly when the answer can have changed —
  // no timer, no second poller, and nothing read out of the signal itself.
  // WHAT THIS TURN IS CARRYING (cinatra#3174, criteria 1 and 2).
  //
  // The schedule card's own section draws its turn with the card and the
  // assistant line and nothing else - "The card is the scheduling step, in the
  // turn - and it is the only thing drawn" - while this container drew the run
  // panel, the agent's own next screen and the produced views as siblings. The
  // reading that decides it is the CARD's (the payload here is a ref), so the
  // card reports into this register and the container reads the count.
  //
  // A SET, NOT A BOOLEAN: two schedule cards in one turn each report for
  // themselves, and one leaving the settled reading must not answer for the
  // other. The identity check keeps the state object stable when nothing
  // changed, so a report cannot loop a render.
  const [settledScheduleCards, setSettledScheduleCards] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const registerSettledSchedule = useCallback((cardId: string, settled: boolean) => {
    setSettledScheduleCards((current) => {
      if (current.has(cardId) === settled) return current;
      const next = new Set(current);
      if (settled) next.add(cardId);
      else next.delete(cardId);
      return next;
    });
  }, []);
  const turnCarriesSettledSchedule = settledScheduleCards.size > 0;

  const [gateSignal, setGateSignal] = useState<string | null>(null);
  const onGateChange = useCallback(
    (changedRunId: string, gate: ChatGateDescriptor | null, instanceId: string) => {
      if (changedRunId === runId) {
        // THE WHOLE SIGNATURE, not the gate's id alone. Sequential per-field
        // setup gates share one review-task id AND one renderer and differ only
        // in the field they ask for, so a signal built from those two would go
        // quiet exactly where the question changes — the card would keep the
        // previous field on screen and could answer the new gate with it. This
        // mirrors the panel's own `gateSignature`: the identity, the field name
        // and the field shape.
        setGateSignal(
          gate === null
            ? null
            : [
                gate.reviewTaskId,
                gate.xRenderer,
                gate.fieldName ?? "",
                gate.fields
                  .map((f) => `${f.name}:${f.type}:${f.required ? 1 : 0}`)
                  .join(","),
              ].join("::"),
        );
      }
      onActiveGateChange?.(changedRunId, gate, instanceId);
    },
    [runId, onActiveGateChange],
  );

  // THE AGENT'S OWN NEXT SCREEN, written once and placed in one of two marked
  // containers (cinatra#3174, criterion 2), because the schedule card's turn may
  // not carry a second decidable card beside it.
  //
  // AND THE ANSWER TRAVELS WITH IT (cinatra#3193). The two placements have
  // different parents, so this is not one component moving: React reconciles
  // them as different trees and the shape flipping unmounts one instance and
  // mounts another. There is no placement that is both a different container
  // and the same parent, so the instance cannot be kept - what can be kept is
  // everything the instance was holding.
  //
  // WHICH MATTERS BECAUSE THE FLIP CAN HAPPEN MID-ANSWER. A schedule card in
  // this same turn settles when the run's own resolve says it has, which on a
  // reload is after the screen has already drawn and can be long after the
  // person started typing into it. Without the box below, that moment cost them
  // the words they had not sent yet AND blanked the screen for as long as the
  // new instance took to re-read its own authority.
  //
  // THE BOX IS THIS CONTAINER'S. It is scoped to this one run's turn, it is
  // never read by anything else, and it dies with the turn - see
  // `AgentHitlScreenCarry` for why that is deliberately not a cache.
  const screenCarrier = useRef<AgentHitlScreenCarry | null>(null);
  const hitlScreen = (
    <AgentHitlScreenCard runId={runId} wireRef={gateSignal} carrier={screenCarrier} />
  );

  // THE RUN-PROGRESS PANEL, written once for the same reason.
  const runPanel = (
    <InlineAgentRunCard
      runId={runId}
      onActiveGateChange={onGateChange}
      recommendationDecided={decided}
    />
  );

  const turn = (
    // THE REGISTER THIS CONTAINER LISTENS ON (cinatra#3174), around the whole
    // of its own turn rather than around the produced views alone: #3044 draws
    // this run's schedule card from THREE places in here - the moment's own
    // mount, the settled reading beside it, and the ordinary slotted views -
    // and a card that cannot report is a turn that never learns what it is
    // carrying. It is still this container asking what IT holds: the provider
    // is scoped to one run's turn and declares nothing surface-wide.
    // `data-agent-run-slot` names WHICH run this marked slot belongs to. The
    // slot index alone says "some marked container" — this view marks three —
    // and the run panel's own link used to be what told them apart, which stops
    // being true the moment a held turn draws no panel. It is passive: a name
    // for the container, driving nothing.
    <SettledScheduleRegisterProvider register={registerSettledSchedule}>
      <div data-transcript-slot={slot} data-agent-run-slot={runId}>
      {/* THE §V RECOMMENDATION HOLD, ON THE chat_thread HOST.
          A chat-started run can PARK on the run-start recommendation hold, and
          the decision belongs where the person is: in the conversation. This
          mounts the ONE §V renderer (`RecommendationHoldCard`, which composes
          the chip row) keyed by the server-produced `agent_run` tool-result
          runId, under the outer `chat_thread` LifecycleCardSurfaceProvider this
          view already declares. It resolves through the card's own state
          action — or, on a credential-declaring host, through the broker.

          AT ITS PRODUCING SLOT, like every other kind (S9i, #2827). Section V's
          carriage is an INTERRUPT rather than a DATA_PART, so its producing step
          is the `agent_run` dispatch itself — this very container, which carries
          the slot mark S9i introduced. The card therefore satisfies the same
          positional rule as the slotted views below it without going through the
          wire: same container, same `data-transcript-slot`, drawn once.

          A SIBLING of the inline run panel, never a child of it: nesting these
          would put one card inside another host's subtree and make "which host
          drew it" unanswerable.

          AND THE ONLY ONE IN THE TURN. The inline run panel beside this card
          used to mount the same card on its own `run_card` host, so a sibling
          that also drew it showed the person two cards for one run; it withheld
          its copy inside a conversation host and kept one on the run page. That
          copy is gone entirely (cinatra#3047) — the run page draws the row in one
          place, its own rail step — so the panel mounts none on any host and this
          container is the conversation's single mount, in EVERY state.

          BOTH ARMS OF THE ONE COLUMN (cinatra#2790, epic #2784 S9f). This
          container is shared by `/chat` and by the site widget, and the mount is
          deliberately NOT gated on the surface kind. On the widget the card's
          read and its two decisions travel on the host's own credential — the
          host declaration selects the transport inside the card itself — so the
          same mount is correct on both, and the widget's `site_widget` cell is
          drawn by this line.

          NOT a DATA_PART and NOT registered in `renderable-views`: a registry
          entry would create a second dispatch path for the same interaction and
          would reach the shared widget transcript, which this host is not
          authorized to decide on. That is also why it cannot arrive in the
          slotted views below and cannot be drawn twice by the two mounts S9i
          partitions.

          Mounted for every `agent_run` part rather than gated on the tool
          result's status, exactly as the run panel mounts it: the card
          self-gates (no live hold ⇒ it renders nothing), which is also what
          makes it survive a transcript reload and what lets it settle IN PLACE
          into its confirmed/skipped summary after a decision instead of
          disappearing. */}
      <RecommendationHoldCard runId={runId} wireRef={null} onStateChange={setHold} />
      {/* THE SETTLED MOMENT'S OWN READING (cinatra#3044). Drawn here, in the
          producing part's own container, ABOVE the reading the run has now:
          the schedule was settled before the run moved on, and a conversation
          reads downwards. Its own marked container, so the reading has a place
          of its own rather than sharing the run's - "the fired part keeps its
          own slot; a later run's screens take their own". See the selection
          above for which views reach this line and why none of them can be the
          run's current reading.

          IT CARRIES NO SLOT MARK OF ITS OWN. The producing part's container
          already carries `data-transcript-slot`, and the positional rule asks
          which marked container a card is inside -- an answer that has to stay
          single. A second mark with the same index nested inside the first
          would give `closest` a container that names no run. */}
      <ScheduleReadingReport onReading={setSettledReading}>
        {settledMomentViews.map((view) => (
          <div
            key={`settled-moment-${String(view.viewType)}-${String(view.ref)}`}
            data-settled-moment-reading={String(view.ref)}
          >
            <RenderableViewCard data={view} {...(onApplyIntent ? { onApplyIntent } : {})} />
          </div>
        ))}
      </ScheduleReadingReport>
      {/* THE HITL SCREEN, ON THE CONVERSATION HOSTS (cinatra#2930, lifecycle-b
          W3). The second kind whose carriage is a typed INTERRUPT, mounted for
          exactly the same reasons as the §V card above it and in exactly the
          same place: at the `agent_run` dispatch part's own container, which is
          this kind's producing slot, as a SIBLING of the inline run panel and
          never a child of it.

          THE PANEL STANDS DOWN INSIDE EITHER CONVERSATION HOST
          (`runCardOwnsLifecycleCopy`), so a paused run shows ONE screen here —
          this card — and the run page keeps the panel's own. Both draw the same
          fields and the same Continue; what differs is which host declared the
          root.

          BOTH ARMS OF THE ONE COLUMN. This container is shared by `/chat` and
          by the site widget, and the mount is deliberately not gated on the
          surface kind: the card's host declaration selects its transport, so
          the same mount is correct on both.

          Mounted for every `agent_run` part rather than gated on the tool
          result's status: the card self-gates — a run that states no HITL
          moment renders nothing — which is also what makes it survive a
          transcript reload. */}
      {/* THE AGENT'S OWN NEXT SCREEN, at the placement this turn has elected
          (cinatra#3174, criterion 2). One element, two containers - see the
          construction above for why the person's half-typed answer travels
          with it rather than living inside the instance that moves. */}
      {turnCarriesSettledSchedule ? null : hitlScreen}
      {/* THE RUN-PROGRESS PANEL IS NOT DRAWN FOR A SETTLED SCHEDULE CARD - AND
          IS NOT UNMOUNTED EITHER (cinatra#3174, criterion 1, as converged).

          NOT DRAWN. Its heading, its status pill and its "No messages yet."
          line are three of the things the section's turn does not draw, and
          this panel is where all three come from. For a settled schedule card
          it is taken out of the picture and out of the accessibility tree, so
          nothing of it reaches the reader and nothing stands between them and
          the form.

          STILL LISTENING. It is also this conversation's ONLY publisher of the
          run's gate changes: `onActiveGateChange` above is what builds the
          change signal the agent's own next screen re-reads on, and what lifts
          an open gate into the composer. A schedule parks the run BEFORE it
          starts and the card stays settled for the whole of the run that
          follows, so unmounting the panel here would leave a gate that opens
          mid-run with nothing at all to announce it until the reader refocused
          the window or reloaded the thread - which is the exact failure this
          repository already states in `hitl-screen-gate-signal.test.ts`: "the
          agent parks MID-RUN, long after the turn was drawn, so a card that
          read once would answer 'no screen' and never ask again while the
          person sat in front of a run that was waiting on them."

          AND THE MOMENT'S OWN STAND-DOWN IS UNTOUCHED (cinatra#3044). A run
          whose row still NAMES its moment already withholds the panel outright,
          and that rule is left exactly as it landed: it is asked first, so the
          two readings can never both draw a panel and the settled card's own
          stand-down applies only where #3044 was drawing one.

          The run page's own panel is untouched - what the section governs is
          this turn. */}
      {runCardWaits || runCardStandsDown ? null : turnCarriesSettledSchedule ? (
        <div hidden aria-hidden data-inline-run-panel-stood-down={runId}>
          {runPanel}
        </div>
      ) : (
        runPanel
      )}
      {/* Inline undo for a recent restorable change-set produced by this run. */}
      <UndoActionChip runId={runId} />
      {/* THE MOMENT'S ONE CARD (cinatra#3044).
          ONE mount, whichever road the reader arrived by: the page that STARTED
          the run has no part in its copy of the turn (the turn was streamed
          here and the platform wrote the part into the STORED turn afterwards),
          and a reloaded turn has one for ever. Both draw through the SAME
          registry every other slotted view draws through, in the producing
          part's own container, under this column's declared host - so the card
          a person meets live and the card they meet after a reload are the same
          card in the same place. See the selection above for which reference it
          is addressed by, and for why a run that has moved on draws none. */}
      {momentKind && momentRef ? (
        <RenderableViewCard
          data={{
            viewType: momentKind,
            schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
            ref: momentRef,
          }}
        />
      ) : null}
        {children}
      </div>
    </SettledScheduleRegisterProvider>
  );

  // THE SCREEN'S OWN MARKED PLACE (cinatra#3174, criterion 2). Where the turn
  // carries a settled schedule card, the agent's own next screen is not
  // withheld - it is moved out of that container into its own, a sibling in the
  // same conversation, so the two roots are never both children of one turn
  // container and neither is nested inside the other. Where the turn carries no
  // such card, this container does not exist and the turn is exactly what it
  // always was.
  if (!turnCarriesSettledSchedule) return turn;
  return (
    <>
      {turn}
      <div data-agent-run-screen-slot={runId}>{hitlScreen}</div>
    </>
  );
}

/**
 * THE ONE MOMENT CARD A CONVERSATION KEEPS AFTER ITS MOMENT HAS CLOSED
 * (cinatra#3044).
 *
 * Named rather than spelled inline, and deliberately ONE kind: the ratified
 * drawing's section VI is the sentence that gives a spent card a standing
 * reading -- "A spent schedule is still worth reading, so nothing is hidden; it
 * simply asks nothing" -- and no other moment has one. A kind added to the
 * conversation's moment map does NOT join this rule by default; it joins when a
 * drawing sentence says what its closed moment reads as.
 */
export const SPENT_MOMENT_CARD_VIEW_TYPE = "trigger_schedule_proposal";

/**
 * IS THIS PRODUCED VIEW A MOMENT'S CARD THIS COLUMN CAN ADDRESS (cinatra#3044)?
 *
 * ONE definition, used by the caller that hands moment views to the run's
 * container and by the container that decides what to draw with them, so the
 * two cannot disagree about which views left the ordinary slotted list.
 *
 * IT IS DELIBERATELY STRICT. The run's container reconstructs the payload from
 * what this returns, so anything it cannot address — a kind it does not draw
 * from the run, a missing or empty reference, a schema version this bundle does
 * not know — is NOT a moment's card here. Such a view stays in the ordinary
 * slotted views and meets the registry's own validation and fallback, which is
 * the forward-compatibility contract every other view already has.
 */
function carriedMomentView(view: Record<string, unknown>): boolean {
  const candidate = view as {
    viewType?: unknown;
    ref?: unknown;
    schemaVersion?: unknown;
  };
  return (
    isConversationMomentCardKind(candidate.viewType) &&
    typeof candidate.ref === "string" &&
    candidate.ref.length > 0 &&
    candidate.schemaVersion === LIFECYCLE_VIEW_SCHEMA_VERSION
  );
}

/**
 * THE LINE SECTION VI DRAWS OVER A SCHEDULE THAT HAS FIRED (cinatra#3174 fix
 * leg 7, criterion 4).
 *
 * The section gives the two fired readings their own words and gives them
 * DIFFERENT words — see `RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE` and
 * `RUN_START_SCHEDULE_FIRED_SENTENCE` for the sentences and for why each is a
 * standing sentence rather than a clause after a dispatch head. Every other
 * reading draws no line of its own: a schedule that has never run says nothing
 * extra above its rows, and a graded round measured that as correct.
 *
 * AND THE STOP IS A READING TOO (fix leg 8). Section VI's Cancel schedule
 * "stops the recurring schedule and then leaves the rows no longer editable",
 * and the fourth graded round measured the fired-recurring sentence standing
 * over a card that had just been stopped — the firing that elects that sentence
 * stays true across the press, so nothing in the turn moved. The stopped
 * reading takes the section's own words: see
 * `RUN_START_SCHEDULE_STOPPED_RECURRING_SENTENCE`. It is asked FIRST, because a
 * stopped schedule is a fired one until the stop is consulted.
 */
function standingScheduleLineFor(reading: ScheduleCardReading): string | null {
  if (reading === "stopped-recurring") return RUN_START_SCHEDULE_STOPPED_RECURRING_SENTENCE;
  if (reading === "fired-recurring") return RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE;
  if (reading === "spent-one-off") return RUN_START_SCHEDULE_FIRED_SENTENCE;
  return null;
}

/**
 * A STEP'S OWN CONTAINER, AND THE READING ITS CARD SETTLED ON (cinatra#3174 fix
 * leg 7, criterion 4).
 *
 * WHY THE CORRECTION ROAD COULD NOT REACH THIS TURN. The two fired sentences
 * already existed and were already wired — into the correction that rewrites
 * the PLATFORM's own start sentence for a run this turn dispatched. That road
 * is real and is kept: a run started from the conversation carries
 * "Dispatched `pkg` (runId: `…`, status: `…`)." into its turn, and a card that
 * has outlived that sentence corrects it. But it is not the road the schedule
 * card usually arrives by. The schedule proposal primitive is its own tool, not
 * a run dispatch, so the turn it produces carries no platform sentence at all —
 * only the model's own lead-in — and there was nothing in it for a corrector to
 * find. A graded round measured exactly that: the fired-recurring turn and the
 * never-fired turn read the identical line, because the only difference between
 * them lived in a reported reading nothing drew.
 *
 * SO THE TURN DRAWS THE LINE, rather than rewriting one. The reading is the
 * CARD's — the payload here is a ref and only the card's own resolve knows
 * whether the schedule has fired — so the card reports it into this container's
 * sink, exactly as it already reports into the run container's, and the
 * container draws the section's sentence above the card for the readings that
 * have one.
 *
 * AND IT IS NOT A SECOND AUTHOR OF THE MODEL'S PROSE. Nothing written by the
 * model is read, matched or rewritten here: the lead-in stands as it was
 * written and the reading's line is drawn beside it, which is the same
 * narrowness `rewritePlatformStartSentence` keeps for the road it serves.
 *
 * ABOVE THE CARD, NEVER INSIDE IT. The section rules a summary node out of the
 * card itself — "No summary box is ever drawn, no status label, and nothing
 * stands between the reader and the form" — so the card goes on drawing the
 * card, and this line is the turn's.
 *
 * THE CONTAINER IS OTHERWISE UNCHANGED: same key, same `data-transcript-slot`,
 * same children, so a step whose views are not a schedule card draws exactly
 * what it drew before this seam existed.
 */
function ProducedViewsSlot({
  slot,
  onStandingLineChange,
  children,
}: {
  slot: number;
  /** THE ANSWER THIS SLOT OWES THE TURN (cinatra#3174 fix leg 9). Whether a
   *  standing line is drawn here is decided by the CARD's own reported reading,
   *  which only this container holds — and the prose the turn draws above this
   *  slot is a SIBLING of it, so the answer has to travel one level up, exactly
   *  as the run container's readings already do. Reported after mount, because
   *  the reading itself is. */
  onStandingLineChange?: (slot: number, drawn: boolean) => void;
  children: ReactNode;
}): ReactElement {
  const [reading, setReading] = useState<ScheduleCardReading>("other");
  const line = standingScheduleLineFor(reading);
  const drawn = line !== null;
  useEffect(() => {
    onStandingLineChange?.(slot, drawn);
  }, [onStandingLineChange, slot, drawn]);
  // A slot that leaves the turn is drawing nothing, so it says so on the way
  // out and the prose it was standing for comes back.
  useEffect(() => () => onStandingLineChange?.(slot, false), [onStandingLineChange, slot]);
  return (
    <ScheduleReadingReport onReading={setReading}>
      <div data-transcript-slot={slot}>
        {line === null ? null : (
          <p
            // Passive: it names WHICH reading drew the line, for a test and for
            // a rendered reading of the screen. The words are what is drawn.
            data-schedule-standing-line={reading}
            className="max-w-none text-[15px] leading-relaxed text-foreground"
          >
            {line}
          </p>
        )}
        {children}
      </div>
    </ScheduleReadingReport>
  );
}

// ---------------------------------------------------------------------------
// Ordered parts renderer (chronologically interleaved text + tool badges)
// ---------------------------------------------------------------------------

function OrderedPartsSection({
  parts,
  trimContent,
  theme,
  detectWidgets,
  onMarkdownClick,
  onActiveGateChange,
  onApplyIntent,
  onWaitingRunsChange,
  onFiredRunsChange,
  onFiredRecurringRunsChange,
}: {
  parts: AssistantMessagePart[];
  trimContent?: (content: string) => string;
  theme: ThemeName;
  /** Live widget detector from the chat widget runtime (renderMarkdown needs
   *  it to strip URL lines already rendered as widget embeds). */
  detectWidgets: (content: string) => DetectedWidget[];
  // Delegated click handler so the same code-copy / table-action behaviour
  // that the legacy `message.content` div provides also works for text
  // parts rendered here. Bound at the parent level so the `closest`
  // selectors still match any child element inside any text part.
  onMarkdownClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  // Threaded down to the inline agent-run card so an open HITL gate can be
  // driven from the chat prompt window.
  onActiveGateChange?: (
    runId: string,
    gate: ChatGateDescriptor | null,
    instanceId: string,
  ) => void;
  /** §6e apply-intent gesture seam (cinatra#2683), threaded to the views a part
   *  produced so a SLOTTED card keeps the one gesture the widget owns. Absent
   *  (`/chat`) ⇒ display-only, exactly as for the turn-level list. */
  onApplyIntent?: (ref: ApplyIntentRef) => void;
  /** cinatra#3044 — the same answer, reported OUT, for the layouts that render
   *  the turn's prose as flat `content` beside this list rather than inside it
   *  (the pinned Slack layout, and any turn that carries no ordered trace). */
  onWaitingRunsChange?: (runIds: readonly string[]) => void;
  /** The same answer for the runs whose one-off has FIRED (cinatra#3044), for
   *  the same layouts and the same reason. */
  onFiredRunsChange?: (runIds: readonly string[]) => void;
  /** The fired-RECURRING readings in this turn (cinatra#3174 fix leg 3). */
  onFiredRecurringRunsChange?: (runIds: readonly string[]) => void;
}) {
  // WHICH RUNS IN THIS TURN ARE WAITING FOR A SCHEDULE (cinatra#3044). Each
  // run's own container reads its row for the card it draws and reports the
  // answer here, because the sentence that has to be corrected is a SIBLING of
  // that container, not a child of it — the platform writes the line and the
  // dispatch part into one turn, and only the run's row can say which of the
  // two readings the person is looking at is still true.
  //
  // A LIST, not a boolean: one turn can start more than one run, and a
  // correction is addressed to the run it names.
  const [scheduleWaitRunIds, setScheduleWaitRunIds] = useState<readonly string[]>([]);
  const onScheduleWaitChange = useCallback((runId: string, waiting: boolean) => {
    setScheduleWaitRunIds((prev) => {
      const known = prev.includes(runId);
      // Identity is preserved when nothing changed, so a run that reports the
      // same answer on every read cannot re-render the transcript.
      if (waiting === known) return prev;
      return waiting ? [...prev, runId] : prev.filter((id) => id !== runId);
    });
  }, []);
  useEffect(() => {
    onWaitingRunsChange?.(scheduleWaitRunIds);
  }, [onWaitingRunsChange, scheduleWaitRunIds]);
  // WHICH RUNS IN THIS TURN HAVE A SPENT ONE-OFF ON SCREEN (cinatra#3044). The
  // mirror of the wait list above, kept apart from it because the two say
  // different things about the same run at different times and the sentence
  // they choose is a different sentence. A run cannot be in both: the container
  // reports "waiting" only while the row still names the schedule and "fired"
  // only once it no longer does.
  const [scheduleFiredRunIds, setScheduleFiredRunIds] = useState<readonly string[]>([]);
  const onScheduleFiredChange = useCallback((runId: string, fired: boolean) => {
    setScheduleFiredRunIds((prev) => {
      const known = prev.includes(runId);
      if (fired === known) return prev;
      return fired ? [...prev, runId] : prev.filter((id) => id !== runId);
    });
  }, []);
  useEffect(() => {
    onFiredRunsChange?.(scheduleFiredRunIds);
  }, [onFiredRunsChange, scheduleFiredRunIds]);
  // AND WHICH OF THEM ARE RECURRING SCHEDULES THAT HAVE FIRED (cinatra#3174 fix
  // leg 3). A third list, for the third sentence §VI draws.
  const [scheduleFiredRecurringRunIds, setScheduleFiredRecurringRunIds] = useState<
    readonly string[]
  >([]);
  const onScheduleFiredRecurringChange = useCallback(
    (runId: string, firedRecurring: boolean) => {
      setScheduleFiredRecurringRunIds((prev) => {
        const known = prev.includes(runId);
        if (firedRecurring === known) return prev;
        return firedRecurring ? [...prev, runId] : prev.filter((id) => id !== runId);
      });
    },
    [],
  );
  useEffect(() => {
    onFiredRecurringRunsChange?.(scheduleFiredRecurringRunIds);
  }, [onFiredRecurringRunsChange, scheduleFiredRecurringRunIds]);
  // WHICH SLOTS IN THIS TURN DRAW SECTION VI's OWN SENTENCE (cinatra#3174 fix
  // leg 9). Section VI draws every one of its example turns the same way: one
  // prose line, then the card. The settled readings — fired one-off, fired
  // recurring, stopped — have a sentence OF THEIR OWN, and it is the turn's one
  // line; the example turn for a recurring schedule that has fired carries
  // "It is still recurring, so the rows below still take a change — it applies
  // to the runs still to come." and nothing above it.
  //
  // Fix leg 7 drew that sentence BESIDE the model's own lead-in rather than in
  // its place, on the reasoning that prose the model wrote is not this
  // renderer's to touch. A graded round then measured the shipped turn drawing
  // TWO prose lines on every settled reading, which is more than the drawing
  // gives — and the drawing, not the reasoning, is the anchor. So the lead-in
  // is not rewritten here either: it is not DRAWN, because the reading's own
  // sentence is what this turn says.
  //
  // A LIST OF SLOTS, not a boolean, and the FIRST one decides: a turn can carry
  // more than one produced-views slot, and what §VI rules out is prose standing
  // ABOVE the sentence. Prose below a slot is not what this measured, and is
  // left exactly as it was drawn.
  //
  // AND ONLY THE READINGS THAT HAVE A SENTENCE. A schedule that has never fired
  // draws no line of its own, so its lead-in is the turn's ONE line and stays —
  // which is what §VI's first-shown and configured examples draw.
  const [standingLineSlots, setStandingLineSlots] = useState<readonly number[]>([]);
  const onStandingLineChange = useCallback((slot: number, drawn: boolean) => {
    setStandingLineSlots((prev) => {
      const known = prev.includes(slot);
      // Identity is preserved when nothing changed, so a slot that reports the
      // same answer on every read cannot re-render the transcript.
      if (drawn === known) return prev;
      return drawn ? [...prev, slot].sort((a, b) => a - b) : prev.filter((s) => s !== slot);
    });
  }, []);
  const firstStandingLineSlot = standingLineSlots.length === 0 ? null : standingLineSlots[0]!;
  if (parts.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" onClick={onMarkdownClick}>
      {parts.map((part, idx) => {
        if (part.kind === "text") {
          // THE TURN'S ONE PROSE LINE IS THE DRAWN SENTENCE (cinatra#3174 fix
          // leg 9) — see the note on `standingLineSlots`. Nothing is read,
          // matched or rewritten: a text part standing above the slot that
          // draws §VI's sentence is simply not drawn, and the transcript's own
          // history — the reader's request, every earlier turn — is untouched
          // because this decision is scoped to the parts of THIS turn.
          if (firstStandingLineSlot !== null && idx < firstStandingLineSlot) return null;
          let raw = trimContent ? trimContent(part.content) : part.content;
          // THE PLATFORM'S OWN SENTENCE, CORRECTED AT THE CARD. Narrow by
          // construction: only the sentence this platform minted, only for a
          // run this turn is drawing a schedule card for, and only while that
          // run is waiting. Prose the model wrote is not touched.
          // THE SPENT ONE-OFF'S LINE FIRST. Its correction replaces the whole
          // platform sentence rather than its clause, so a run corrected here
          // leaves nothing for the wait correction below to match — which is
          // what keeps the two from ever composing into one line.
          for (const firedRunId of scheduleFiredRunIds) {
            raw = correctRunStartSentenceForFiredSchedule({
              text: raw,
              runId: firedRunId,
              // THE TURN'S OWN SCHEDULE RUNS, so the headless fallback can tell
              // whether a standing clause is provably this run's line.
              scheduleRunIds: [
                ...scheduleFiredRunIds,
                ...scheduleFiredRecurringRunIds,
                ...scheduleWaitRunIds,
              ],
              // AND WHICH OF THEM HAVE FIRED (converge round), so a turn whose
              // schedule runs have ALL fired is corrected rather than left
              // permanently saying that runs which have all started have not.
              // THE READING'S OWN LIST (fix leg 3): the lift is taken only where
              // every schedule run in the turn is in THIS reading, so the two
              // fired sentences can never both claim one standing clause.
              firedScheduleRunIds: scheduleFiredRunIds,
            });
          }
          // THE FIRED RECURRING LINE, ON THE SAME TERMS (cinatra#3174 fix leg 3).
          for (const firedRunId of scheduleFiredRecurringRunIds) {
            raw = correctRunStartSentenceForFiredRecurringSchedule({
              text: raw,
              runId: firedRunId,
              scheduleRunIds: [
                ...scheduleFiredRunIds,
                ...scheduleFiredRecurringRunIds,
                ...scheduleWaitRunIds,
              ],
              firedScheduleRunIds: scheduleFiredRecurringRunIds,
            });
          }
          for (const waitingRunId of scheduleWaitRunIds) {
            raw = correctRunStartSentenceForScheduleWait({ text: raw, runId: waitingRunId });
          }
          // Skip pure-whitespace text parts (they're separator artifacts).
          if (!raw.replace(/\s+/g, "").length) return null;
          return (
            // `data-embed-content` is the stable assistant-content hook the
            // render-parity harness scrapes (one per assistant-text part). It
            // used to exist ONLY on the embed's own bespoke content block; the
            // widget now renders through THIS list, so the hook lives with the
            // content it names and both surfaces expose it identically.
            // Passive test observability — it drives no behaviour.
            <div
              key={`text-${idx}`}
              data-embed-content
              data-transcript-slot={idx}
              className="max-w-none text-[15px] leading-relaxed text-foreground [&_table]:my-0"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(raw, theme, detectWidgets) }}
            />
          );
        }
        // The views this step PRODUCED (cinatra#2827, epic #2784 S9i). A
        // lifecycle card is minted at a tool RESULT, and the wire names the call
        // it was minted at, so the card is drawn HERE — inside the producing
        // part's own container — rather than appended after the whole trace.
        // Same `RenderableViewCard` the turn-level list dispatches: ONE registry,
        // one validation path, one fallback. A card sits BESIDE the inline run
        // card, never inside it: the run card is a `run_card` host of its own,
        // and a chat card rendered in that subtree would be another host's mount.
        const producedViews = part.kind === "tool_call" ? (part.views ?? []) : [];
        // A MOMENT'S CARD IS NOT DRAWN FROM HERE (cinatra#3044). Every other
        // view a step produced is its own reading and draws unconditionally;
        // a lifecycle MOMENT's card is the run's reading, and whether it is
        // still the run's reading is a question only the run's own row can
        // answer. So it is handed to the run's container below, which draws
        // exactly one — never a settled moment card standing beside the run's
        // next reading. In a container that is not a run's (no `agent_run`
        // part), a moment view has no run to be measured against and draws as
        // it always did.
        const momentViews = producedViews.filter(carriedMomentView);
        const isRunSlot =
          part.kind === "tool_call" && isRunStartToolName(part.name) && !!part.runId;
        const slottedViews = (isRunSlot
          ? producedViews.filter((view) => !momentViews.includes(view))
          : producedViews
        ).map((view, i) => (
          <RenderableViewCard
            key={`slot-${idx}-view-${i}`}
            data={view}
            {...(onApplyIntent ? { onApplyIntent } : {})}
          />
        ));
        // `agent_run` tool_results carry a runId pinned by the tool_result
        // handler. Mount AgenticRunPanel inline so the user can drive HITL
        // gates (URL pickers, list pickers, reviewer approvals) from within
        // the chat thread instead of navigating to /agents/<v>/<s>/<runId>.
        // The card resolves to its own panel chrome — no extra Card wrapper here.
        // BOTH START DOORS (cinatra#2935, lifecycle-b W5d) — the widget's
        // `agent_named_start` produces the SAME run through the SAME primitive.
        if (part.kind === "tool_call" && isRunStartToolName(part.name) && part.runId) {
          return (
            <AgentRunTurnSlot
              key={`agent-run-${part.runId}`}
              runId={part.runId}
              slot={idx}
              views={momentViews}
              onActiveGateChange={onActiveGateChange}
              onScheduleWaitChange={onScheduleWaitChange}
              onScheduleFiredChange={onScheduleFiredChange}
              onScheduleFiredRecurringChange={onScheduleFiredRecurringChange}
              {...(onApplyIntent ? { onApplyIntent } : {})}
            >
              {slottedViews}
            </AgentRunTurnSlot>
          );
        }
        // A step that produced a view gets its own container at its own slot.
        if (slottedViews.length > 0) {
          return (
            <ProducedViewsSlot
              key={`slot-${idx}`}
              slot={idx}
              onStandingLineChange={onStandingLineChange}
            >
              {slottedViews}
            </ProducedViewsSlot>
          );
        }
        // Other tool parts feed the single live status line below the
        // message and don't render inline content.
        return null;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live progress indicator (ChatGPT-style pulsating dot + short status text)
// ---------------------------------------------------------------------------

function ThinkingIndicator({ className, label = "Thinking" }: { className?: string; label?: string } = {}) {
  const showProgressSuffix = label !== "Thinking";

  return (
    <div className={cn("flex animate-pulse items-center gap-2.5 text-muted-foreground", className)} role="status" aria-live="polite">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-current opacity-70" />
      </span>
      <span className="text-sm font-medium">
        {label}
        {showProgressSuffix ? " >" : null}
      </span>
    </div>
  );
}

// Waiting indicator — shown while an external assistant (@handle) is expected to reply.
function WaitingIndicator({ handle }: { handle: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-muted-foreground opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground opacity-40" />
      </span>
      <span className="text-sm text-muted-foreground">
        Waiting for @{handle}...
      </span>
    </div>
  );
}

// Per-assistant typing indicator shown in Slack mode while a Cinatra stream is buffering.
function SlackTypingIndicator({ handle }: { handle: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-muted-foreground opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground opacity-40" />
      </span>
      <span className="text-sm text-muted-foreground">
        @{handle} is thinking...
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error card
// ---------------------------------------------------------------------------

function ErrorCard({ error, errorRaw }: { error: string; errorRaw?: string }) {
  const [copied, setCopied] = useState(false);
  const verbatim = errorRaw || error;

  function handleCopy() {
    void navigator.clipboard.writeText(verbatim).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    // `data-chat-error-card` is the stable presence hook the two-surface
    // regression suite reads (cinatra#2683) — passive test observability on the
    // SHARED card, so "the widget shows the friendly error body, not a reduced
    // banner" is checked against the same DOM `/chat` produces.
    <div data-chat-error-card className="max-w-full overflow-hidden rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
      <div className="flex items-start gap-2.5">
        <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0 text-destructive">
          <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22Z" clipRule="evenodd" />
        </svg>
        <div className="min-w-0 flex-1">
          <FriendlyErrorBody error={error} />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end">
        <Button
          type="button"
          variant="ghost"
          onClick={handleCopy}
          className="inline-flex h-auto items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/15 hover:text-destructive"
        >
          {copied ? (
            <>
              <IconCheck />
              Copied
            </>
          ) : (
            <>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
                <path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5" />
              </svg>
              Copy error details
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget system
// ---------------------------------------------------------------------------
// The registries, detector compilation, and wizard/refresh helpers live in
// ./widget-runtime (pure factory). ChatPage builds the runtime from its
// `widgets` / `widgetManifests` props via useMemo and threads it here.

function ChatWidget({
  widget,
  def,
  submitRef,
  isOlderWidget,
  refreshKey,
}: {
  widget: DetectedWidget;
  /** Resolved by the caller from the live widget runtime (findWidget). */
  def: WidgetDefinition | undefined;
  submitRef: React.RefObject<WidgetSubmitHandle | null>;
  isOlderWidget?: boolean;
  refreshKey?: number;
}) {
  const ownRef = useRef<WidgetSubmitHandle | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  if (!def) return null;

  const Component = def.component;
  const effectiveRef = isOlderWidget ? ownRef : submitRef;

  return (
    <div className="mt-3 w-full overflow-hidden rounded-xl border border-line bg-surface-strong shadow-lg">
      <div className="p-2">
        <Component
          key={refreshKey}
          resourceId={widget.resourceId}
          submitRef={effectiveRef}
          onSave={isOlderWidget ? () => setStatus("saved") : undefined}
        />
        {isOlderWidget && (
          <div className="flex justify-end px-2 pb-1">
            {status === "saving" ? (
              <svg className="h-4 w-4 animate-spin text-muted-foreground" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" className="opacity-25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            ) : status === "saved" ? (
              <svg className="h-4 w-4 text-success" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 0 1 0 1.414l-8 8a1 1 0 0 1-1.414 0l-4-4a1 1 0 1 1 1.414-1.414L8 12.586l7.293-7.293a1 1 0 0 1 1.414 0Z" />
              </svg>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={async () => {
                  setStatus("saving");
                  const ok = await ownRef.current?.submit();
                  setStatus(ok ? "saved" : "idle");
                }}
                className="h-auto rounded-lg px-3 py-1 text-xs font-medium text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground"
              >
                Save
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mention badge renderer — converts @handle tokens in plain text to inline chips
// ---------------------------------------------------------------------------

function MentionBadge({ m }: { m: Mentionable }) {
  return (
    <span
      className="mention-chip inline-flex items-center gap-1 align-middle bg-surface-muted border border-line rounded-full pl-0.5 pr-1.5 py-0.5 text-xs leading-none select-none mx-1"
    >
      <span className="size-[1.1rem] rounded-full overflow-hidden inline-flex shrink-0 items-center justify-center bg-muted text-muted-foreground text-[8px] font-semibold">
        {m.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={m.image} alt="" className="size-full object-cover" />
        ) : (
          m.displayName.charAt(0).toUpperCase()
        )}
      </span>
      <span>{m.displayName}</span>
    </span>
  );
}

function renderWithMentions(content: string, mentionables: Mentionable[]): React.ReactNode {
  if (!mentionables.length || !content.includes("@")) return content;
  const handleMap = new Map(mentionables.map((m) => [m.handle, m]));
  const parts = content.split(/(@[a-zA-Z0-9_.\-]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      const m = handleMap.get(part.slice(1));
      if (m) return <MentionBadge key={i} m={m} />;
    }
    return part;
  });
}

// ---------------------------------------------------------------------------
// User message bubble with copy / edit actions
// ---------------------------------------------------------------------------

function UserMessageBubble({
  message,
  onEdit,
  disabled,
  isSlackMode = false,
  editRequested = false,
  onEditStarted,
  mentionables = [],
}: {
  message: UiMessage;
  onEdit: (messageId: string, newContent: string) => void;
  disabled?: boolean;
  isSlackMode?: boolean;
  editRequested?: boolean;
  onEditStarted?: () => void;
  mentionables?: Mentionable[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editRequested || editing) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }

      setEditing(true);
      onEditStarted?.();
    });

    return () => {
      cancelled = true;
    };
  }, [editRequested, editing, onEditStarted]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [editing]);

  if (editing) {
    return (
      <div className="mb-4 w-full rounded-control bg-surface-muted/60 px-4 py-3 shadow-sm">
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (draft.trim()) {
                setEditing(false);
                onEdit(message.id, draft);
              }
            }
            if (e.key === "Escape") {
              setEditing(false);
              setDraft(message.content);
            }
          }}
          style={{ boxShadow: "none" }}
          className="min-h-0 w-full resize-none border-0 bg-transparent px-3 py-2 text-sm text-foreground shadow-none outline-none focus-visible:ring-0"
          rows={1}
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => { setEditing(false); setDraft(message.content); }}
            className="h-auto rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-surface-muted"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (draft.trim()) {
                setEditing(false);
                onEdit(message.id, draft);
              }
            }}
            className="h-auto rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/80"
          >
            Send
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("group relative min-w-0", isSlackMode ? "max-w-[85%]" : "max-w-[75%]")}>
      <div className="whitespace-pre-wrap break-words rounded-control bg-surface-muted px-4 py-3 text-sm text-foreground">
        {renderWithMentions(message.content, mentionables)}
      </div>
      {!disabled && !isSlackMode && (
        <div className="absolute -bottom-1 right-0 flex translate-y-full gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void navigator.clipboard.writeText(message.content)}
            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground"
            title="Copy"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
              <path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5" />
            </svg>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => { setDraft(message.content); setEditing(true); }}
            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground"
            title="Edit message"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slack-mode helpers
// ---------------------------------------------------------------------------

function getParticipantInitials(handle: string | undefined): string {
  if (!handle || handle.length === 0) return "AS";
  const stripped = handle.startsWith("@") ? handle.slice(1) : handle;
  return stripped.slice(0, 2).toUpperCase();
}

// Inline OpenAI icon (removed from simple-icons)
function OpenAIChatIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v 5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.843-3.368L15.116 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.104v-5.678a.79.79 0 0 0-.407-.666zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/>
    </svg>
  );
}

function CinatraAvatarIcon() {
  // The Cinatra mark is wide (fullViewBox 512×320, ~1.6:1). Forcing it into a
  // square (h-3 w-3) made preserveAspectRatio shrink it to ~7.5px tall, so it
  // looked shrunken next to the square 12px provider glyphs (#502). Keep the
  // 12px height and let width follow the aspect ratio (matching the same logo's
  // other render at the response-header), so it reads at the sibling icons' size.
  return (
    <svg viewBox={CINATRA_LOGO.fullViewBox} xmlns="http://www.w3.org/2000/svg" fill="none" aria-label="Cinatra" className="h-3 w-auto">
      <path d={CINATRA_LOGO.brim} fill="currentColor" />
      <path d={CINATRA_LOGO.crown} fill="currentColor" />
    </svg>
  );
}

function getAssistantProviderIcon(handle: string | undefined): React.ReactNode | null {
  if (!handle) return null;
  const h = handle.toLowerCase();
  if (h.includes("cinatra")) return <CinatraAvatarIcon />;
  if (h.includes("claude") || h.includes("anthropic")) return <SiAnthropic size={12} />;
  if (h.includes("gpt") || h.includes("openai")) return <OpenAIChatIcon size={12} />;
  if (h.includes("gemini") || h.includes("google")) return <SiGooglegemini size={12} />;
  return null;
}

// ---------------------------------------------------------------------------
// In-message table pagination (buttons rendered by markdown-render)
// ---------------------------------------------------------------------------

function updateChatTablePage(frame: Element, requestedPage: number) {
  const pagination = frame.querySelector<HTMLElement>("[data-chat-table-pagination]");
  if (!pagination) return;

  const rows = Array.from(frame.querySelectorAll<HTMLTableRowElement>("[data-chat-table-row]"));
  const pageSize = Number(pagination.dataset.pageSize ?? "25");
  const rowCount = Number(pagination.dataset.rowCount ?? rows.length);
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 25;
  const safeRowCount = Number.isFinite(rowCount) && rowCount > 0 ? rowCount : rows.length;
  const pageCount = Math.max(1, Math.ceil(safeRowCount / safePageSize));
  const page = Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const firstIndex = page * safePageSize;
  const lastIndex = Math.min(safeRowCount, firstIndex + safePageSize);

  pagination.dataset.page = String(page);
  rows.forEach((row, index) => {
    row.classList.toggle("hidden", index < firstIndex || index >= lastIndex);
  });

  const rangeLabel = pagination.querySelector<HTMLElement>("[data-chat-table-range-label]");
  if (rangeLabel) {
    rangeLabel.textContent = `${firstIndex + 1}-${lastIndex} of ${safeRowCount}`;
  }

  const pageLabel = pagination.querySelector<HTMLElement>("[data-chat-table-page-label]");
  if (pageLabel) {
    pageLabel.textContent = `Page ${page + 1} of ${pageCount}`;
  }

  pagination.querySelectorAll<HTMLButtonElement>(".chat-table-pagination-action").forEach((button) => {
    if (button.dataset.action === "previous") {
      button.disabled = page === 0;
    } else if (button.dataset.action === "next") {
      button.disabled = page >= pageCount - 1;
    }
  });
}

// ---------------------------------------------------------------------------
// Shared rich-content adjuncts (widgets / mermaid / charts / citations)
// ---------------------------------------------------------------------------
// The four assistant render sites (Slack/ChatGPT × parts/legacy) repeated
// these blocks verbatim in chat-page.tsx; they are factored here into local
// components that emit byte-identical DOM (same keys, same markup).

function MessageWidgetEmbeds({
  message,
  isLastMessage,
  widgetRuntime,
  widgetSubmitRef,
  widgetRefreshKey,
}: {
  message: UiMessage;
  isLastMessage: boolean;
  widgetRuntime: ChatWidgetRuntime;
  widgetSubmitRef: React.RefObject<WidgetSubmitHandle | null>;
  widgetRefreshKey: number;
}) {
  const widgets = widgetRuntime.detectWidgets(message.content);
  if (widgets.length === 0) return null;
  return widgets.map((widget) => (
    <ChatWidget
      key={widget.widgetId + widget.resourceId}
      widget={widget}
      def={widgetRuntime.findWidget(widget.widgetId)}
      submitRef={isLastMessage ? widgetSubmitRef : { current: null }}
      isOlderWidget={!isLastMessage}
      refreshKey={widgetRefreshKey}
    />
  ));
}

function MessageMermaidEmbeds({ message }: { message: UiMessage }) {
  const mermaidBlocks = detectMermaidBlocks(message.content);
  if (mermaidBlocks.length === 0) return null;
  return mermaidBlocks.map((block, i) => (
    <MermaidBlock
      key={`${message.id}-mermaid-${i}`}
      id={`${message.id}-${i}`}
      source={block.source}
    />
  ));
}

/**
 * viewType → the resolved extension-provided renderable-view component
 * (a React client reference), resolved server-side from the generated
 * `cinatra.views` map by src/lib/chat-views-catalog.server.ts and threaded in
 * as a prop. Empty when no view-bearing extension is live/built.
 */
export type ChatViewComponents = Record<
  string,
  ComponentType<{ view: { viewType: string } }>
>;

/**
 * Error boundary around a mounted EXTENSION renderable-view component: a
 * render/lifecycle throw from the extension degrades to the host's never-blank
 * floor (`fallback`) instead of escaping and crashing the messages subtree /
 * `/chat` (epic #1620 AC1; mirrors the artifact-side DynamicRendererLoader's
 * RendererErrorBoundary). LOGICAL containment only — not a security boundary.
 */
class ChatViewErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { crashed: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { crashed: false };
  }
  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }
  render(): ReactNode {
    return this.state.crashed ? this.props.fallback : this.props.children;
  }
}

function MessageChartEmbeds({
  message,
  chatViews,
}: {
  message: UiMessage;
  chatViews: ChatViewComponents;
}) {
  // Host-side detection stays here permanently (epic #1620 AC2): the detector
  // emits the stable `chart` viewType payload; the COMPONENT that renders it is
  // extension-provided, dispatched through the generated `cinatra.views` map.
  const charts = detectCharts(message.content);
  if (charts.length === 0) return null;
  const ChartView = chatViews.chart;
  return charts.map((c, i) => {
    const key = `chart-${message.id}-${i}`;
    // Unclaimed / not built into this bundle → the never-blank floor (AC1),
    // never a dead arm. The floor covers the whole `chart` viewType at once.
    if (!ChartView) return <RenderableViewFallback key={key} rawViewType="chart" />;
    // The stable payload the extension receives. A malformed embed (`spec ===
    // null`) still dispatches the bare `{ viewType: "chart" }` payload — the
    // extension re-validates and renders its own non-crashing error floor, so
    // an invalid chart is never blank either. A render THROW from the extension
    // is contained by the boundary → the same never-blank floor.
    const view = c.spec ? buildChartView(c.spec) : { viewType: "chart" as const };
    return (
      <ChatViewErrorBoundary key={key} fallback={<RenderableViewFallback rawViewType="chart" />}>
        <ChartView view={view} />
      </ChatViewErrorBoundary>
    );
  });
}

/**
 * The renderable views this turn carried on the wire (cinatra#2565).
 *
 * `/chat` used to DROP the reducer's `dataParts` in its projection, so a typed
 * DATA_PART the embed's shared renderer already drew was invisible here. The
 * projection now keeps them and this mount dispatches each one through the SAME
 * `RenderableViewCard` the embed uses — one registry, one validation path, one
 * fallback. An unknown or invalid payload renders the neutral fallback rather
 * than crashing the transcript; a lifecycle card renders nothing until its
 * authoritative refetch succeeds.
 *
 * WHAT THIS LIST NO LONGER CARRIES (cinatra#2827, epic #2784 S9i). A view whose
 * `DATA_PART` named the tool call that produced it is folded onto that
 * `tool_call` part by the reducer and drawn by `OrderedPartsSection` at that
 * step's own container. So the two mounts PARTITION the turn's views by whether
 * the wire gave them a position — a view is drawn once, never twice — and this
 * list keeps exactly the ones with no producing step (an A2A artifact part, a
 * bridge part, an external producer that stamps no slot).
 */
function MessageRenderableViews({
  message,
  onApplyIntent,
}: {
  message: UiMessage;
  /** §6e (cinatra#1221 S5 Lane B) apply-intent gesture seam, threaded through
   *  the SHARED list by cinatra#2683. It lived only on the embed's own reduced
   *  renderer, so mounting this list on the widget would have SILENTLY dropped
   *  the one gesture that surface owns. Absent (`/chat`) ⇒ the proposal card
   *  stays display-only, exactly as before — the seam adds a gesture, it never
   *  changes which card renders. */
  onApplyIntent?: (ref: ApplyIntentRef) => void;
}) {
  const views = message.dataParts ?? [];
  if (views.length === 0) return null;
  return views.map((view, i) => (
    <RenderableViewCard
      key={`view-${message.id}-${i}`}
      data={view}
      {...(onApplyIntent ? { onApplyIntent } : {})}
    />
  ));
}

/**
 * The turn's LIFECYCLE SLOTS, drawn wherever the ordered-parts branch did not
 * draw them (cinatra#2825, S9l).
 *
 * A lifecycle card mounted at a slot in the ordered trace — the `agent_run`
 * anchor the recommendation card sits at (#2786) — used to disappear in two
 * situations that have nothing to do with the decision it is holding:
 *
 *   · THE SLACK LAYOUT pins its own turn shape and omits the ordered `parts`,
 *     so the anchor was never on the projected turn at all. The projection now
 *     carries the slots (and only the slots) on `lifecycleParts`.
 *   · AN ERROR TURN skips the ordered-parts branch entirely and draws the error
 *     card alone, so a card the run had already produced went with it.
 *
 * It draws through `OrderedPartsSection`, the SAME branch the full trace draws a
 * slot through, so there is one mount path for the inline run card rather than a
 * second one that could drift. Its own guard — not the caller's — decides
 * whether that branch already drew them, which is what keeps ONE rendered
 * instance per kind per host however many ladder branches mount this.
 */
// ---------------------------------------------------------------------------
// THE ONE CORRECTION, IN THE LAYOUTS THAT DO NOT RENDER AN ORDERED TRACE
// (cinatra#3044).
//
// `OrderedPartsSection` corrects the platform's dispatch sentence where the
// sentence is a text PART of the trace it renders. Two shipped layouts do not
// render that trace: the pinned Slack layout projects the turn's prose as flat
// `content` and carries only the lifecycle SLOTS beside it, and an older turn
// with no trace falls through the same way. There the sentence and the card are
// siblings in the message body, so the answer the run's own container reads has
// to travel one level up — a turn-scoped context, written by the slot list that
// draws the card and read by the block that renders the prose.
// ---------------------------------------------------------------------------
const ScheduleWaitContext = createContext<{
  waitingRunIds: readonly string[];
  firedRunIds: readonly string[];
  firedRecurringRunIds: readonly string[];
  reportWaitingRunIds: (runIds: readonly string[]) => void;
  reportFiredRunIds: (runIds: readonly string[]) => void;
  reportFiredRecurringRunIds: (runIds: readonly string[]) => void;
} | null>(null);

/** The assistant turn's body, and the scope of the correction inside it. */
function ScheduleWaitTurnBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const [waitingRunIds, setWaitingRunIds] = useState<readonly string[]>([]);
  const [firedRunIds, setFiredRunIds] = useState<readonly string[]>([]);
  const [firedRecurringRunIds, setFiredRecurringRunIds] = useState<readonly string[]>([]);
  // Identity is preserved when the answer did not change, so a run that reports
  // the same reading on every poll cannot re-render the transcript.
  const reportWaitingRunIds = useCallback((next: readonly string[]) => {
    setWaitingRunIds((prev) =>
      prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next,
    );
  }, []);
  const reportFiredRunIds = useCallback((next: readonly string[]) => {
    setFiredRunIds((prev) =>
      prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next,
    );
  }, []);
  const reportFiredRecurringRunIds = useCallback((next: readonly string[]) => {
    setFiredRecurringRunIds((prev) =>
      prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next,
    );
  }, []);
  const value = useMemo(
    () => ({
      waitingRunIds,
      firedRunIds,
      firedRecurringRunIds,
      reportWaitingRunIds,
      reportFiredRunIds,
      reportFiredRecurringRunIds,
    }),
    [
      waitingRunIds,
      firedRunIds,
      firedRecurringRunIds,
      reportWaitingRunIds,
      reportFiredRunIds,
      reportFiredRecurringRunIds,
    ],
  );
  return (
    <ScheduleWaitContext.Provider value={value}>
      <div className={className}>{children}</div>
    </ScheduleWaitContext.Provider>
  );
}

/** The turn's flat prose, corrected for every run this turn is drawing a
 *  pending schedule card for. Identical bytes to the trace's own correction —
 *  both call the one function in the run-status leaf. */
function FlatAssistantContent({
  message,
  theme,
  detectWidgets,
  streaming,
  onMarkdownClick,
}: {
  message: UiMessage;
  theme: ThemeName;
  detectWidgets: (content: string) => DetectedWidget[];
  streaming: boolean;
  onMarkdownClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const scheduleSentences = useContext(ScheduleWaitContext);
  // While streaming, trim incomplete embed prefixes so partial JSON/mermaid
  // never flashes as raw text in the markdown output.
  let raw = streaming ? trimIncompleteEmbeds(message.content) : message.content;
  // Same order as the trace's own correction, for the same reason.
  for (const runId of scheduleSentences?.firedRunIds ?? []) {
    raw = correctRunStartSentenceForFiredSchedule({
      text: raw,
      runId,
      // Same knowledge, same reason as the trace's own correction.
      scheduleRunIds: [
        ...(scheduleSentences?.firedRunIds ?? []),
        ...(scheduleSentences?.firedRecurringRunIds ?? []),
        ...(scheduleSentences?.waitingRunIds ?? []),
      ],
      firedScheduleRunIds: scheduleSentences?.firedRunIds ?? [],
    });
  }
  for (const runId of scheduleSentences?.firedRecurringRunIds ?? []) {
    raw = correctRunStartSentenceForFiredRecurringSchedule({
      text: raw,
      runId,
      scheduleRunIds: [
        ...(scheduleSentences?.firedRunIds ?? []),
        ...(scheduleSentences?.firedRecurringRunIds ?? []),
        ...(scheduleSentences?.waitingRunIds ?? []),
      ],
      firedScheduleRunIds: scheduleSentences?.firedRecurringRunIds ?? [],
    });
  }
  for (const runId of scheduleSentences?.waitingRunIds ?? []) {
    raw = correctRunStartSentenceForScheduleWait({ text: raw, runId });
  }
  return (
    <div
      data-embed-content
      className="max-w-none text-[15px] leading-relaxed text-foreground [&_table]:my-0"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(raw, theme, detectWidgets) }}
      /* renderMarkdown strips mermaid blocks; they are rendered separately below */
      onClick={onMarkdownClick}
    />
  );
}

function MessageLifecycleSlots({
  message,
  theme,
  detectWidgets,
  onActiveGateChange,
}: {
  message: UiMessage;
  theme: ThemeName;
  detectWidgets: (content: string) => DetectedWidget[];
  onActiveGateChange?: (
    runId: string,
    gate: ChatGateDescriptor | null,
    instanceId: string,
  ) => void;
}) {
  // The answer this mount reports OUT to the turn's prose, which is a sibling
  // of this block in these layouts and not a child of it (cinatra#3044).
  const scheduleSentences = useContext(ScheduleWaitContext);
  const reportWaitingRunIds = scheduleSentences?.reportWaitingRunIds;
  const reportFiredRunIds = scheduleSentences?.reportFiredRunIds;
  const reportFiredRecurringRunIds = scheduleSentences?.reportFiredRecurringRunIds;
  // The ordered-parts branch condition, restated: when it ran, it already drew
  // every slot in the trace and this mount must draw nothing.
  if (message.parts && message.parts.length > 0 && !message.error) return null;
  const slots = lifecycleSlotParts(message.parts ?? message.lifecycleParts);
  if (slots.length === 0) return null;
  return (
    <OrderedPartsSection
      parts={slots}
      theme={theme}
      detectWidgets={detectWidgets}
      onActiveGateChange={onActiveGateChange}
      {...(reportWaitingRunIds ? { onWaitingRunsChange: reportWaitingRunIds } : {})}
      {...(reportFiredRunIds ? { onFiredRunsChange: reportFiredRunIds } : {})}
      {...(reportFiredRecurringRunIds
        ? { onFiredRecurringRunsChange: reportFiredRecurringRunIds }
        : {})}
    />
  );
}

function MessageCitations({ message }: { message: UiMessage }) {
  if (!message.citations || message.citations.length === 0) return null;
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-2 text-xs font-semibold text-muted-foreground">Sources</div>
      <ol className="text-xs">
        {message.citations.map((c, i) => {
          const host = (() => {
            try { return new URL(c.url).hostname.replace(/^www\./, ""); } catch { return c.url; }
          })();
          return (
            <li key={`${message.id}-cite-${i}`} className="my-1 flex gap-2 first:mt-0">
              <span className="text-muted-foreground">{i + 1}.</span>
              <Link href={c.url} target="_blank" rel="noreferrer" className="truncate text-muted-foreground underline underline-offset-4 hover:text-foreground">
                {c.title || host}
                <span className="ml-2 text-muted-foreground/70">({host})</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation view
// ---------------------------------------------------------------------------

export type ChatMessagesViewProps = {
  messages: UiMessage[];
  isSlackMode: boolean;
  animating: boolean;
  theme: ThemeName;
  /** Signed-in user's id + display fields (from authClient.useSession()). */
  userId?: string;
  sessionUser?: { name?: string | null; image?: string | null } | null;
  activeThreadId: string | null;
  activeAssistantHandle?: string;
  /** assistantUserId → @handle map scanned from user-message mentions. */
  assistantHandleMap: Map<string, string>;
  taggedAssistantUserIds: string[];
  mentionables: Mentionable[];
  pausedParticipants: string[];
  onTogglePause: (participantId: string, next: boolean) => void;
  requestEditMessageId: string | null;
  onRequestEditMessage: (messageId: string) => void;
  onEditStarted: () => void;
  hasActiveStream: boolean;
  /** True while `messageId` has an in-flight stream (abort-controller registry). */
  isStreaming: (messageId: string) => boolean;
  onEditAndResend: (messageId: string, newContent: string) => void;
  onActivateResource: (resourceType: string, resourceId: string) => void;
  widgetRuntime: ChatWidgetRuntime;
  widgetSubmitRef: React.RefObject<WidgetSubmitHandle | null>;
  widgetRefreshKey: number;
  onActiveGateChange: (
    runId: string,
    gate: ChatGateDescriptor | null,
    instanceId: string,
  ) => void;
  pendingExternalHandle: string | null;
  /** assistantId → display handle for per-assistant typing bubbles (Slack mode). */
  typingIndicators: Map<string, string>;
  /** Extension-provided chat renderable-view components (viewType → component),
   *  resolved server-side from the generated `cinatra.views` map. Defaults to
   *  empty — the `chart` viewType then renders the never-blank fallback. */
  chatViews: ChatViewComponents;
  /** §6e apply-intent gesture seam (cinatra#2683) — see MessageRenderableViews. */
  onApplyIntent?: (ref: ApplyIntentRef) => void;
  /** The lifecycle-card host this list declares (cinatra#2683). Omitted ⇒
   *  `/chat`'s own `{ host: "chat_thread" }` — byte-identical to the literal
   *  this module carried before the widget mounted the same list. */
  lifecycleSurface?: LifecycleSurfaceDeclaration;
};

/** The list renderer's component type — the shape a host hands the ONE column
 *  (directly, or wrapped in its own `next/dynamic` lazy boundary, which yields a
 *  `ComponentType` rather than a bare function). */
export type ChatMessagesViewComponent = ComponentType<ChatMessagesViewProps>;

export function ChatMessagesView({
  messages,
  isSlackMode,
  animating,
  theme,
  userId,
  sessionUser,
  activeThreadId,
  activeAssistantHandle,
  assistantHandleMap,
  taggedAssistantUserIds,
  mentionables,
  pausedParticipants,
  onTogglePause,
  requestEditMessageId,
  onRequestEditMessage,
  onEditStarted,
  hasActiveStream,
  isStreaming,
  onEditAndResend,
  onActivateResource,
  widgetRuntime,
  widgetSubmitRef,
  widgetRefreshKey,
  onActiveGateChange,
  pendingExternalHandle,
  typingIndicators,
  chatViews,
  onApplyIntent,
  lifecycleSurface = CHAT_THREAD_LIFECYCLE_SURFACE,
}: ChatMessagesViewProps) {
  // cinatra#2020 S5 (PR-4): bump the confirmation-cards refresh whenever a
  // turn carried a parked destructive call (stable §2.1 prefix). BEST-EFFORT
  // over the text surfaces this view holds (assistant text + tool-part
  // labels); the cards' own open/focus polling is the designed self-healing
  // fallback, and the deciding client gets its outcome synchronously.
  const pendingConfirmationSignal = useMemo(() => {
    let parked = 0;
    for (const message of messages) {
      if (message.content?.includes(PENDING_CONFIRMATION_RESULT_PREFIX)) parked += 1;
      for (const part of message.parts ?? []) {
        if (
          part.kind === "tool_call" &&
          part.resultLabel?.startsWith(PENDING_CONFIRMATION_RESULT_PREFIX)
        ) {
          parked += 1;
        }
      }
    }
    return parked;
  }, [messages]);

  // Hydrate shiki placeholders after render — replace fallback <pre> blocks with
  // syntax-highlighted HTML loaded lazily from shiki. (Moved with the view: the
  // placeholders it queries exist only in this component's DOM.)
  useEffect(() => {
    const placeholders = document.querySelectorAll<HTMLElement>("[data-shiki-code]");
    if (placeholders.length === 0) return;
    placeholders.forEach((el) => {
      // URL-encoded raw source (UTF-safe, set in the code() renderer).
      const code = decodeURIComponent(el.dataset.shikiCode ?? "");
      const lang = el.dataset.shikiLang ?? "text";
      const elTheme = (el.dataset.shikiTheme ?? "github-light") as ThemeName;
      void highlightCodeAsync(code, lang, elTheme).then((html) => {
        if (!html) return;
        const pre = el.querySelector("pre");
        if (!pre) return;
        const temp = document.createElement("div");
        temp.innerHTML = html;
        const shikiPre = temp.querySelector("pre");
        if (shikiPre) {
          // Preserve our layout classes on the <pre> element.
          shikiPre.classList.add("overflow-x-auto", "whitespace-pre", "p-4", "text-[0.8rem]", "leading-relaxed", "font-mono");
          pre.replaceWith(shikiPre);
        }
        el.removeAttribute("data-shiki-code");
      });
    });
  }, [messages, hasActiveStream, theme]);

  // Shared click handler for assistant markdown content: handles
  // copy-code buttons (inside fenced code blocks) and the chat table's
  // row-pagination controls. Both the legacy `message.content` div and the new
  // `OrderedPartsSection` text parts wear this handler so the buttons
  // work the same way regardless of which render path is active. (The table
  // header strip's copy/download controls are gone — cinatra#3230; the
  // renderer emits none, so no branch handles them.)
  const handleAssistantMarkdownClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const codeBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action='copy-code']");
    if (codeBtn) {
      const block = codeBtn.closest(".chat-code-block");
      if (block) {
        const codeEl = block.querySelector("code");
        const rawText = codeEl?.textContent ?? "";
        void navigator.clipboard.writeText(rawText);
      }
      return;
    }
    const tablePageBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".chat-table-pagination-action");
    if (tablePageBtn) {
      const frame = tablePageBtn.closest("[data-chat-table-frame]");
      const pagination = frame?.querySelector<HTMLElement>("[data-chat-table-pagination]");
      if (frame && pagination) {
        const currentPage = Number(pagination.dataset.page ?? "0");
        updateChatTablePage(
          frame,
          tablePageBtn.dataset.action === "previous" ? currentPage - 1 : currentPage + 1,
        );
      }
      return;
    }
  }, []);

  return (
    /* cinatra#2565 — the surface DECLARES itself as a lifecycle-card host. The
       declaration is opt-in with no default: a surface that has not been
       reviewed for lifecycle cards renders none, rather than inheriting them
       silently. cinatra#2683 turns the literal into a prop so the widget can
       mount this same list under ITS host + broker credential (S8d enabled the
       widget host); `/chat` passes nothing and keeps `chat_thread`. */
    <LifecycleCardSurfaceProvider {...lifecycleSurface}>
    {/* gap-8 (was gap-5): action row clears next turn's header on same-side turns (#504) */}
    {/* `data-conversation-list` is the stable presence hook for the shared list
        (cinatra#2683) — the column mounts this module behind a lazy boundary, so
        a test needs one signal that says "the list is here" on every surface and
        every fixture. Passive test observability; it drives no behaviour. */}
    <div data-conversation-list className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4">
      {messages.map((message) => {
        const isUser = message.role === "user";
        if (isSlackMode) {
          const userInitials = sessionUser?.name
            ? sessionUser.name.split(" ").map((n: string) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2)
            : "Me";
          // Resolve per-message handle: authorUserId → handle map, fallback to "cinatra"
          const messageHandle = !isUser
            ? (message.authorUserId
                ? (assistantHandleMap.get(message.authorUserId) ?? activeAssistantHandle ?? "cinatra")
                : "cinatra")
            : null;
          const initials = isUser ? userInitials : getParticipantInitials(messageHandle ?? undefined);
          const displayName = isUser
            ? (sessionUser?.name ?? "You")
            : resolveAssistantDisplayName(messageHandle);
          const assistantIcon = !isUser ? getAssistantProviderIcon(messageHandle ?? undefined) : null;
          return (
            <div
              key={message.id}
              className={cn(
                "group flex flex-col gap-1",
                animating && "animate-slack-slide-left",
              )}
            >
              {/* Header row: Avatar + name aligned in the middle */}
              <div className="flex items-center gap-2">
                {/* Resolve sender user ID — covers human, external assistant, and built-in cinatra */}
                {(() => {
                  const senderUserId = isUser
                    ? userId
                    : (message.authorUserId ?? mentionables.find((m) => m.handle === (messageHandle ?? "cinatra"))?.id);
                  const profileHref = senderUserId ? `/users/${senderUserId}` : null;
                  const avatarEl = (
                    <Avatar size="sm">
                      {isUser && sessionUser?.image && <AvatarImage src={sessionUser.image} />}
                      <AvatarFallback>{assistantIcon ?? initials}</AvatarFallback>
                    </Avatar>
                  );
                  return (
                    <>
                      {profileHref ? (
                        <AppRouteLink href={profileHref} className={cn("shrink-0", animating && "animate-slack-avatar-fade-in")}>{avatarEl}</AppRouteLink>
                      ) : (
                        <span className={cn("shrink-0", animating && "animate-slack-avatar-fade-in")}>{avatarEl}</span>
                      )}
                      <div className={cn("group/name flex items-center gap-1", animating && "animate-slack-name-fade-in")}>
                        {profileHref ? (
                          <AppRouteLink href={profileHref} className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">{displayName}</AppRouteLink>
                        ) : (
                          <span className="text-xs font-medium text-muted-foreground">{displayName}</span>
                        )}
                  {!isUser && activeThreadId && (() => {
                    // Resolve participant ID: authorUserId for external, "cinatra" for built-in
                    const participantId = message.authorUserId ?? "cinatra";
                    const isPaused = pausedParticipants.includes(participantId);
                    return (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title={isPaused ? `Resume ${displayName}` : `Pause ${displayName}`}
                        onClick={() => {
                          onTogglePause(participantId, !isPaused);
                        }}
                        className="h-auto w-auto transition-opacity text-muted-foreground hover:text-foreground hover:bg-transparent"
                      >
                        {isPaused
                          ? <PlayCircle className="h-3.5 w-3.5" />
                          : <PauseCircle className="h-3.5 w-3.5" />}
                      </Button>
                    );
                  })()}
                      </div>
                    </>
                  );
                })()}
                <div className="flex-1" />
                <div className="flex items-center gap-0.5">
                  {isUser && !hasActiveStream && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Edit message"
                      onClick={() => onRequestEditMessage(message.id)}
                      className="h-auto w-auto rounded p-1 text-muted-foreground hover:text-foreground hover:bg-surface-muted transition-colors"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Copy message"
                    onClick={() => void navigator.clipboard.writeText(message.content)}
                    className="h-auto w-auto rounded p-1 text-muted-foreground hover:text-foreground hover:bg-surface-muted transition-colors"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {/* Bubble indented to align with name (past avatar + gap) */}
              <div className="relative ml-8 max-w-[85%]">
                {isUser ? (
                  <UserMessageBubble
                    message={message}
                    onEdit={(id, content) => onEditAndResend(id, content)}
                    disabled={hasActiveStream}
                    isSlackMode
                    editRequested={requestEditMessageId === message.id}
                    onEditStarted={onEditStarted}
                    mentionables={mentionables}
                  />
                ) : (
                  <ScheduleWaitTurnBody className="group min-w-0 max-w-full flex-1">
                    {/* Ordered parts: when an assistant message
                        has a `parts` trace, render text + tool badges
                        chronologically interleaved. Replaces the
                        flat thoughtGroups-above-content layout. Old
                        messages without parts fall through to the
                        legacy path below. */}
                    {message.parts && message.parts.length > 0 && !message.error ? (
                      <OrderedPartsSection
                        parts={message.parts}
                        trimContent={isStreaming(message.id) ? trimIncompleteEmbeds : undefined}
                        theme={theme}
                        detectWidgets={widgetRuntime.detectWidgets}
                        onMarkdownClick={handleAssistantMarkdownClick}
                        onActiveGateChange={onActiveGateChange}
                        onApplyIntent={onApplyIntent}
                      />
                    ) : (
                      <>
                        {message.thoughtGroups && message.thoughtGroups.length > 0 && !isStreaming(message.id) && (
                          <div>
                            {message.thoughtGroups.map((group) => (
                              <ThoughtGroupSection
                                key={group.id}
                                group={group}
                                isLive={isStreaming(message.id)}
                              />
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    {message.error ? (
                      // cinatra#2825 (S9l) — the error card is what this turn
                      // ENDED as; the lifecycle items are what it is still
                      // HOLDING. An unrelated stream error must not decide for
                      // the reader by hiding a card they still owe an answer to,
                      // so both are drawn, the error first.
                      <>
                        <ErrorCard error={message.error} errorRaw={message.errorRaw} />
                        <MessageLifecycleSlots
                          message={message}
                          theme={theme}
                          detectWidgets={widgetRuntime.detectWidgets}
                          onActiveGateChange={onActiveGateChange}
                        />
                        <MessageRenderableViews message={message} onApplyIntent={onApplyIntent} />
                      </>
                    ) : (message.parts && message.parts.length > 0) ? (
                      // Rich-content adjuncts (mermaid, charts, citations,
                      // widgets) are computed from `message.content` which
                      // is populated alongside `parts`. Render them BELOW
                      // the interleaved parts so the feature set matches
                      // the legacy path.
                      <>
                        <MessageWidgetEmbeds
                          message={message}
                          isLastMessage={message === messages[messages.length - 1]}
                          widgetRuntime={widgetRuntime}
                          widgetSubmitRef={widgetSubmitRef}
                          widgetRefreshKey={widgetRefreshKey}
                        />
                        <MessageMermaidEmbeds message={message} />
                        <MessageChartEmbeds message={message} chatViews={chatViews} />
                        <MessageRenderableViews message={message} onApplyIntent={onApplyIntent} />
                        <MessageCitations message={message} />
                        {isStreaming(message.id) && shouldShowLiveProgressStatus(message) && (
                          <ThinkingIndicator className="mt-2" label={getLiveProgressStatus(message)} />
                        )}
                      </>
                    ) : message.content ? (
                      <>
                        <FlatAssistantContent
                          message={message}
                          theme={theme}
                          detectWidgets={widgetRuntime.detectWidgets}
                          streaming={isStreaming(message.id)}
                          onMarkdownClick={handleAssistantMarkdownClick}
                        />
                        <MessageWidgetEmbeds
                          message={message}
                          isLastMessage={message === messages[messages.length - 1]}
                          widgetRuntime={widgetRuntime}
                          widgetSubmitRef={widgetSubmitRef}
                          widgetRefreshKey={widgetRefreshKey}
                        />
                        <MessageMermaidEmbeds message={message} />
                        <MessageChartEmbeds message={message} chatViews={chatViews} />
                        {/* cinatra#2825 (S9l) — in this layout the ordered trace
                            is omitted by design, so the lifecycle slot it carried
                            is drawn here, beside the other adjuncts. */}
                        <MessageLifecycleSlots
                          message={message}
                          theme={theme}
                          detectWidgets={widgetRuntime.detectWidgets}
                          onActiveGateChange={onActiveGateChange}
                        />
                        <MessageRenderableViews message={message} onApplyIntent={onApplyIntent} />
                        <MessageCitations message={message} />
                        {isStreaming(message.id) && shouldShowLiveProgressStatus(message) && (
                          <ThinkingIndicator className="mt-2" label={getLiveProgressStatus(message)} />
                        )}
                        <ResponseActionBar
                          message={message}
                          messages={messages}
                          hasActiveStream={hasActiveStream}
                          isSlackMode={isSlackMode}
                          isStreaming={isStreaming}
                          onEditAndResend={onEditAndResend}
                        />
                      </>
                    ) : turnCarriesLifecycleItems(message) ? (
                      // cinatra#2825 (S9l) — a turn with no prose and no trace,
                      // carrying only a card, used to fall through to `null` and
                      // render nothing at all.
                      <>
                        <MessageLifecycleSlots
                          message={message}
                          theme={theme}
                          detectWidgets={widgetRuntime.detectWidgets}
                          onActiveGateChange={onActiveGateChange}
                        />
                        <MessageRenderableViews message={message} onApplyIntent={onApplyIntent} />
                      </>
                    ) : isStreaming(message.id) && shouldShowLiveProgressStatus(message) ? (
                      <ThinkingIndicator label={getLiveProgressStatus(message)} />
                    ) : null}
                  </ScheduleWaitTurnBody>
                )}
              </div>
            </div>
          );
        }
        // ChatGPT branch — preserve byte-identical render behavior.
        const showParticipantHeaders = true;
        const nmUserInitials = sessionUser?.name
          ? sessionUser.name.split(" ").map((n: string) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2)
          : "Me";
        const nmUserName = sessionUser?.name ?? "You";
        const nmThreadHasMention = taggedAssistantUserIds.length >= 1
          || messages.some((m) => m.role === "user" && /@[a-z0-9_-]+/i.test(m.content));
        const nmResolvedHandle = nmThreadHasMention ? activeAssistantHandle : undefined;
        const nmHandle = !isUser
          ? (message.authorUserId
              ? (assistantHandleMap.get(message.authorUserId) ?? nmResolvedHandle ?? "cinatra")
              : (nmResolvedHandle ?? "cinatra"))
          : null;
        const nmDisplayName = isUser ? nmUserName : resolveAssistantDisplayName(nmHandle);
        const nmAssistantIcon = !isUser ? getAssistantProviderIcon(nmHandle ?? undefined) : null;
        const nmInitials = !isUser ? getParticipantInitials(nmHandle ?? undefined) : nmUserInitials;
        return (
          <div key={message.id} className={cn("flex flex-col gap-1", isUser && "items-end")}>
            {showParticipantHeaders && (
              isUser ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">{nmUserName}</span>
                  <Avatar size="sm">
                    {sessionUser?.image && <AvatarImage src={sessionUser.image} />}
                    <AvatarFallback>{nmUserInitials}</AvatarFallback>
                  </Avatar>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Avatar size="sm">
                    <AvatarFallback>{nmAssistantIcon ?? nmInitials}</AvatarFallback>
                  </Avatar>
                  <span className="text-xs font-medium text-muted-foreground">{nmDisplayName}</span>
                </div>
              )
            )}
            {isUser ? (
              <UserMessageBubble
                message={message}
                onEdit={(id, content) => onEditAndResend(id, content)}
                disabled={hasActiveStream}
                mentionables={mentionables}
              />
            ) : (
              <ScheduleWaitTurnBody className="group min-w-0 max-w-full flex-1">
                {/* Ordered parts — see comment at the first render site
                    above. Same conditional applies here in slack-mode
                    view. */}
                {message.parts && message.parts.length > 0 && !message.error ? (
                  <OrderedPartsSection
                    parts={message.parts}
                    trimContent={isStreaming(message.id) ? trimIncompleteEmbeds : undefined}
                    theme={theme}
                    detectWidgets={widgetRuntime.detectWidgets}
                    onMarkdownClick={handleAssistantMarkdownClick}
                    onActiveGateChange={onActiveGateChange}
                    onApplyIntent={onApplyIntent}
                  />
                ) : (
                  <>
                    {message.thoughtGroups && message.thoughtGroups.length > 0 && !isStreaming(message.id) && (
                      <div>
                        {message.thoughtGroups.map((group) => (
                          <ThoughtGroupSection
                            key={group.id}
                            group={group}
                            isLive={isStreaming(message.id)}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
                {message.error ? (
                  // cinatra#2825 (S9l) — same rule as the render site above: an
                  // error ends the turn, it does not dismiss the decision the
                  // turn is holding.
                  <>
                    <ErrorCard error={message.error} errorRaw={message.errorRaw} />
                    <MessageLifecycleSlots
                      message={message}
                      theme={theme}
                      detectWidgets={widgetRuntime.detectWidgets}
                      onActiveGateChange={onActiveGateChange}
                    />
                    <MessageRenderableViews message={message} onApplyIntent={onApplyIntent} />
                  </>
                ) : (message.parts && message.parts.length > 0) ? (
                  // Same rich-content adjuncts treatment as the
                  // ChatGPT-mode render site above.
                  <>
                    <MessageWidgetEmbeds
                      message={message}
                      isLastMessage={message === messages[messages.length - 1]}
                      widgetRuntime={widgetRuntime}
                      widgetSubmitRef={widgetSubmitRef}
                      widgetRefreshKey={widgetRefreshKey}
                    />
                    <MessageMermaidEmbeds message={message} />
                    <MessageChartEmbeds message={message} chatViews={chatViews} />
                    <MessageRenderableViews message={message} onApplyIntent={onApplyIntent} />
                    <MessageCitations message={message} />
                    {isStreaming(message.id) && shouldShowLiveProgressStatus(message) && (
                      <ThinkingIndicator className="mt-2" label={getLiveProgressStatus(message)} />
                    )}
                  </>
                ) : message.content ? (
                  <>
                    <FlatAssistantContent
                      message={message}
                      theme={theme}
                      detectWidgets={widgetRuntime.detectWidgets}
                      streaming={isStreaming(message.id)}
                      onMarkdownClick={handleAssistantMarkdownClick}
                    />
                    <MessageWidgetEmbeds
                      message={message}
                      isLastMessage={message === messages[messages.length - 1]}
                      widgetRuntime={widgetRuntime}
                      widgetSubmitRef={widgetSubmitRef}
                      widgetRefreshKey={widgetRefreshKey}
                    />
                    <MessageMermaidEmbeds message={message} />
                    <MessageChartEmbeds message={message} chatViews={chatViews} />
                    <MessageRenderableViews message={message} onApplyIntent={onApplyIntent} />
                    {message.role === "assistant" && <MessageCitations message={message} />}
                    {isStreaming(message.id) && shouldShowLiveProgressStatus(message) && (
                      <ThinkingIndicator className="mt-2" label={getLiveProgressStatus(message)} />
                    )}
                    {(() => {
                      const confirmMatch = message.content.match(/\[confirm-([a-z_-]+):([a-f0-9-]{36})\]/i);
                      if (!confirmMatch) return null;
                      const [, resourceType, resourceId] = confirmMatch;
                      const manifest = widgetRuntime.findManifestByConfirmationResourceType(resourceType);
                      if (!manifest?.wizard) return null;
                      const isLastMessage = message === messages[messages.length - 1];
                      if (!isLastMessage) return null;
                      return (
                        <div className="mt-3 flex gap-2">
                          <Button
                            type="button"
                            onClick={() => onActivateResource(resourceType, resourceId)}
                            disabled={hasActiveStream}
                            className="h-auto rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/80 disabled:opacity-50"
                          >
                            {manifest.wizard.confirmation.buttonLabel}
                          </Button>
                        </div>
                      );
                    })()}
                    <ResponseActionBar
                      message={message}
                      messages={messages}
                      hasActiveStream={hasActiveStream}
                      isSlackMode={isSlackMode}
                      isStreaming={isStreaming}
                      onEditAndResend={onEditAndResend}
                    />
                  </>
                ) : turnCarriesLifecycleItems(message) ? (
                  // cinatra#2825 (S9l) — the card-only turn, in this layout too:
                  // a `dataParts`-only turn has neither prose nor a trace and
                  // rendered nothing before.
                  <>
                    <MessageLifecycleSlots
                      message={message}
                      theme={theme}
                      detectWidgets={widgetRuntime.detectWidgets}
                      onActiveGateChange={onActiveGateChange}
                    />
                    <MessageRenderableViews message={message} onApplyIntent={onApplyIntent} />
                  </>
                ) : isStreaming(message.id) && shouldShowLiveProgressStatus(message) ? (
                  <ThinkingIndicator label={getLiveProgressStatus(message)} />
                ) : null}
              </ScheduleWaitTurnBody>
            )}
          </div>
        );
      })}
      {/* Waiting indicator — shown while an external assistant is expected to reply */}
      {pendingExternalHandle && (
        <div className="flex justify-start">
          <div className="min-w-0 max-w-full flex-1">
            <WaitingIndicator handle={pendingExternalHandle} />
          </div>
        </div>
      )}
      {/* Slack mode: per-assistant typing indicator while stream is buffering */}
      {isSlackMode && typingIndicators.size > 0 && Array.from(typingIndicators.entries()).map(([id, indicatorHandle]) => (
        <div key={id} className="flex justify-start">
          <div className="min-w-0 max-w-full flex-1">
            <SlackTypingIndicator handle={indicatorHandle} />
          </div>
        </div>
      ))}
      {/* cinatra#2020 S5 (PR-4): parked destructive-call confirmation cards —
          sticky above the composer, visible whether or not the parked turn's
          text is on screen. Renders nothing when the viewer has no cards. */}
      <PendingToolConfirmationCards pollSignal={pendingConfirmationSignal} />
    </div>
    </LifecycleCardSurfaceProvider>
  );
}

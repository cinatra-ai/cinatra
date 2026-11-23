"use client";

// ---------------------------------------------------------------------------
// THE PUBLISH CARD (cinatra#4150 part 7a-1b). Design 635da007, specs/app-lifecycle-cards.html: XV (the card, its
// two controls and its three settled readings) and IV.1 (pending, loading, restricted, no longer open).
//
// One card for every publishing agent: the question, the agent's display name, the rows the agent declared (label
// over value, read only), the optional note, Do not publish and Publish. The state comes from the ONE authorized read
// (publish-decision-card-core.ts): a cookie host calls the session action, a host that declares a credential (the
// site widget) reads the broker route with that credential. The read sends no decision. A read that fails keeps the
// last authorized answer, and a card with no answer draws NO DOM, so a run with no open decision draws nothing.
// The two controls send through the `decide` door a host passes; a host that passes none draws them disabled.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { reviewIslandAddressCredential } from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { Textarea } from "@/components/ui/textarea";

import {
  LIFECYCLE_PUBLISH_DECISION_PATH,
  sendAcrossRenewal,
  useLifecycleCardAuth,
  useLifecycleCardColorScheme,
  useLifecycleCardFrame,
  useLifecycleCardHost,
  type LifecycleCardAuth,
  type LifecycleColorScheme,
} from "./lifecycle-card-runtime";
import {
  PUBLISH_DECISION_CARD_NONE,
  publishRowKind,
  parsePublishDecisionCardState,
  type PublishDecisionCardArtifactsRow,
  type PublishDecisionCardListRow,
  type PublishDecisionCardRow,
  type PublishDecisionCardTextRow,
  type PublishDecisionCardState,
} from "./publish-decision-card";
import { getPublishDecisionCardStateAction } from "./publish-decision-card-actions";
import { ReviewTargetFrame, reviewTargetIslandSrc } from "./review-gate-card";
import { runStatusIsTerminal } from "./run-surface-status";

/** The re-read cadence while the host's run has not finished: the run surfaces' own tick (5 s). */
export const PUBLISH_DECISION_CARD_POLL_MS = 5000;

/** A decide door answers: the decision landed, the request was no longer open, or the send failed. */
export type PublishDecisionDecide = (input: {
  runId: string;
  answer: "approve" | "decline";
  note: string;
}) => Promise<"decided" | "not_open" | "failed">;

/** The BROKER read, for a host that proves itself with its own credential. A GET: it sends only the run id. */
async function readPublishDecisionThroughBroker(
  runId: string,
  auth: LifecycleCardAuth,
  ended: AbortSignal,
): Promise<PublishDecisionCardState | null> {
  try {
    const url = `${LIFECYCLE_PUBLISH_DECISION_PATH}?runId=${encodeURIComponent(runId)}`;
    const send = () =>
      fetch(url, { method: "GET", headers: auth.headers(), credentials: auth.credentials, signal: ended });
    const response = await sendAcrossRenewal(auth, send, ended);
    if (response === null) return null;
    // A refused credential is an answer (the hitl screen's rule): this reader may no longer see the card.
    if (response.status === 401 || response.status === 403) return PUBLISH_DECISION_CARD_NONE;
    if (!response.ok) return null;
    return parsePublishDecisionCardState((await response.json()) as unknown);
  } catch {
    return null;
  }
}

/** The run's publish card for this reader, or `null` until an authorized answer has landed. `onRead` is called when
 * each read ends, landed or failed, so a caller waiting on a read is never left waiting on a failure. `wireRef` is a
 * pure CHANGE SIGNAL from the host (the run's status, as the hitl screen card takes the gate's): nothing is read out
 * of it, and a change asks for a re-read.
 *
 * THE SIGNAL ALONE CANNOT CARRY EVERY MOVE. A run can open its decision with no change any host reading sees (it
 * resumes under the same status, and the first read during the work between two gates answered `none`). So while
 * the host says its run has NOT finished (`runStatus`, read by `runStatusIsTerminal`), the read also repeats at the
 * run surfaces' cadence. It pauses while the document is hidden and stops when the run finishes or the host unmounts.
 * A host that knows no status (`null`) does not poll.
 *
 * ONE READ OUT AT A TIME. A signal, tick, focus or reload that arrives while a read is out marks the read DIRTY, and
 * exactly one follow-up read runs when it lands: a host whose signal moves faster than the read answers never starves
 * it, and reads never pile up. A landed answer is kept unless the host unmounted or its run changed (those abort the
 * read); a mere signal change never discards it.
 *
 * A RUN THAT HAS ENDED IS PARKED AT NO GATE. When the host's status turns terminal the read runs once more, and a
 * `pending` answer for an ended run (its decision is closed only by the later expiry sweep) reads as `none`. */
export function usePublishDecisionCardState(params: {
  runId: string;
  auth: LifecycleCardAuth | null;
  reloadToken: number;
  wireRef?: string | null;
  runStatus?: string | null;
  onRead?: () => void;
}): PublishDecisionCardState | null {
  const { runId, auth, reloadToken, onRead } = params;
  const wireRef = params.wireRef ?? null;
  const runStatus = params.runStatus ?? null;
  const ended = runStatus !== null && runStatusIsTerminal(runStatus);
  const [resolved, setResolved] = useState<{ runId: string; state: PublishDecisionCardState } | null>(null);
  const latest = useRef({ runId, auth, onRead });
  const flight = useRef<{ runId: string; abort: AbortController } | null>(null);
  const dirty = useRef(false);
  // Declared first, so every effect below reads this render's run, credential and callback.
  useEffect(() => {
    latest.current = { runId, auth, onRead };
  }, [runId, auth, onRead]);
  // Built once: it reads only refs, so every caller (the identity, the signals, the tick, a landed read) asks the same
  // single-flight door.
  const [request] = useState(() => {
    const ask = (): void => {
      const { runId: id, auth: credential } = latest.current;
      if (!id) return;
      if (flight.current) {
        dirty.current = true;
        return;
      }
      dirty.current = false;
      const mine = { runId: id, abort: new AbortController() };
      flight.current = mine;
      void (async () => {
        const state = credential
          ? await readPublishDecisionThroughBroker(id, credential, mine.abort.signal)
          : await getPublishDecisionCardStateAction({ runId: id }).then(parsePublishDecisionCardState, () => null);
        // Aborted: the host unmounted or its run changed. Nothing lands, and the new run's own read is already out.
        if (flight.current !== mine) return;
        flight.current = null;
        // A read that could not be completed is a FAILURE, not a state: the last authorized answer stands.
        if (state !== null) setResolved({ runId: id, state });
        if (dirty.current) ask();
        else latest.current.onRead?.();
      })();
    };
    return ask;
  });
  // THE RUN'S IDENTITY: a new run (or a mount) aborts any read still out and reads at once.
  useEffect(() => {
    request();
    return () => {
      flight.current?.abort.abort();
      flight.current = null;
      dirty.current = false;
    };
  }, [runId, request]);
  // THE SIGNALS: each change asks for a read, coalesced with one already out. The mount's read is the identity's.
  const [focusToken, setFocusToken] = useState(0);
  useEffect(() => {
    const onFocus = () => setFocusToken((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const signals = useRef<unknown[] | null>(null);
  useEffect(() => {
    const now = [runId, auth, reloadToken, focusToken, wireRef, ended];
    const before = signals.current;
    signals.current = now;
    if (before === null || before[0] !== runId) return;
    if (now.some((value, i) => value !== before[i])) request();
  }, [runId, auth, reloadToken, focusToken, wireRef, ended, request]);
  // THE TICK, while the run has not finished.
  const polling = runId !== "" && runStatus !== null && !ended;
  useEffect(() => {
    if (!polling) return;
    const tick = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      request();
    }, PUBLISH_DECISION_CARD_POLL_MS);
    return () => window.clearInterval(tick);
  }, [polling, request]);
  if (!resolved || resolved.runId !== runId) return null;
  return ended && resolved.state.state === "pending" ? PUBLISH_DECISION_CARD_NONE : resolved.state;
}

/** One resolved read of a run's publish card: the state, whether a re-read the reader asked for is running, and the
 * re-read itself. A host that also decides something else from the same state (the run panel's approval banner, the
 * conversation turn's panel) reads ONCE and hands this to the card, so the two decisions cannot disagree. */
export type PublishDecisionCardRead = {
  state: PublishDecisionCardState | null;
  refreshing: boolean;
  reload: (showLoading?: boolean) => void;
};

/** The ONE read behind a publish card: `usePublishDecisionCardState` with its reload and its loading reading. An empty
 * `runId` reads nothing. `runStatus` is the host's run status: while it is not terminal the read also repeats on the
 * run surfaces' cadence (see `usePublishDecisionCardState`), so every host gets the same re-read from this one hook. */
export function usePublishDecisionCardRead(params: {
  runId: string;
  auth: LifecycleCardAuth | null;
  wireRef?: string | null;
  runStatus?: string | null;
}): PublishDecisionCardRead {
  const [reloadToken, setReloadToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Loading ends when the re-read ENDS, landed or failed: a failed re-read keeps the last answer on screen (IV.1).
  const state = usePublishDecisionCardState({
    runId: params.runId,
    auth: params.auth,
    reloadToken,
    wireRef: params.wireRef,
    runStatus: params.runStatus,
    onRead: () => setRefreshing(false),
  });
  const reload = useCallback((showLoading = false) => {
    if (showLoading) setRefreshing(true);
    setReloadToken((n) => n + 1);
  }, []);
  return { state, refreshing, reload };
}

/** The publish gate is OPEN for this read only when the read positively answered `pending` for a run that has not
 * ended. A read that has not landed or failed with no earlier answer is not a publish gate, so a host keeps its own
 * approval surface. A run that has ended is parked at no gate (the read's own terminal rule); a host that knows its
 * run's status passes it, so a `pending` answer it still holds from before the run ended is not open either.
 *
 * THE READ IS THE TRUTH FOR "PARKED AT ITS PUBLISH GATE". The decision is written before the run's status moves, and a
 * host's own status is refreshed apart from this read, so a host never also requires its status to read
 * `pending_approval`: a `pending` read beside a `running` status is the same pause, seen first by the read.
 *
 * ONE HELD-RUN CARD. While it is open the run is parked at its publish gate and nowhere else, so every host (the run
 * panel, the stepper, the conversation turn) draws the publish card as the run's only held-run card and withholds any
 * hitl screen, gate card, review surface or working surface it still holds for the same run: that reading is stale. */
export function publishGateIsOpen(read: PublishDecisionCardRead, runStatus?: string | null): boolean {
  if (runStatus != null && runStatusIsTerminal(runStatus)) return false;
  return read.state?.state === "pending";
}

/** The read holds a SETTLED decision (allowed, declined, expired): a record, not a held card. It is drawn above
 * whatever the run draws next. Never `pending` (that is the open gate above), never `none`, a read not landed or a
 * failed read with no earlier answer. */
export function publishDecisionIsSettled(read: PublishDecisionCardRead): boolean {
  const state = read.state?.state;
  return state === "approved" || state === "declined" || state === "expired";
}

const FRAME = "w-full min-w-0 overflow-hidden rounded-card border border-line bg-surface-strong";
const KICK = "font-mono text-badge-2xs uppercase tracking-kicker text-muted-foreground";
const MARKERS = {
  approved: ["publish-card-approved", "approved", "Allowed"],
  declined: ["publish-card-declined", "idle", "Not allowed"],
  expired: ["publish-card-expired", "idle", "Expired"],
} as const;

/** One read-only row (cinatra#4150 W4): its label over its value, as the design draws it (XV.1). Each kind carries its own
 * conformance anchor on the row (publish-row-text, publish-row-list, publish-row-items; an artifacts row that could not be
 * shown carries publish-row-items-refused), so a capture can count what the page drew. The value is a text row's value, a
 * list row's compact table with a line that says how many records it does not draw (every cell is plain text), or an
 * artifacts row's review-target island (C1b). */
function PublishRow({ row, onRetry }: { row: PublishDecisionCardRow; onRetry: () => void }): ReactElement | null {
  // Dispatch on the row's OWN kind, every value named: the parse admits only text, list and artifacts, and any other kind draws
  // nothing here (never the text drawing). A kind added to publishRowKind fails the typecheck below until it is drawn.
  const kind = publishRowKind(row);
  switch (kind) {
    case "text":
      return (
        <div data-conformance-id="publish-row-text">
          <dt className={KICK}>{row.label}</dt>
          <dd className="text-reading text-foreground">{(row as PublishDecisionCardTextRow).value}</dd>
        </div>
      );
    case "list":
      return (
        <div data-conformance-id="publish-row-list">
          <dt className={KICK}>{row.label}</dt>
          {listRowValue(row as PublishDecisionCardListRow)}
        </div>
      );
    case "artifacts":
      return <ArtifactsRow row={row as PublishDecisionCardArtifactsRow} onRetry={onRetry} />;
    case null:
      return null;
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

function listRowValue(row: PublishDecisionCardListRow): ReactElement {
  const more = row.total - row.items.length;
  return (
    <dd className="min-w-0" data-publish-row-kind="list">
      <div className="mt-1 overflow-x-auto rounded-card border border-line">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-line">
              {row.columns.map((column, c) => (
                <th key={`${c}-${column}`} scope="col" className={`px-2.5 py-1.5 font-normal ${KICK}`}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row.items.map((cells, r) => (
              <tr key={r} className="border-b border-line last:border-b-0">
                {cells.map((cell, c) => (
                  <td key={c} className="px-2.5 py-1.5 align-top text-foreground">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 ? <p className="mt-1 text-xs text-muted-foreground" data-publish-row-more="">{more} more</p> : null}
    </dd>
  );
}

type HeldArtifactsAddress = {
  /** The row identity the address was taken for: the ref names the run, the decision and the input, and is minted
   * deterministically, so the same row of the same decision reads the same ref on every poll. */
  ref: string | null;
  scheme: LifecycleColorScheme | null;
  islandSrc: string | null;
  /** The reader asked for a retry: the next unframed credential replaces the held one. */
  fresh: boolean;
  /** The palette a fresh address was last asked for, so a repaint asks once. */
  askedFor: LifecycleColorScheme | null;
};

/**
 * THE ADDRESS THE ROW'S FRAME IS HELD AT (cinatra#4738). The card re-reads its state on the run surfaces' tick, and the
 * frame is keyed on its address: an address that moves on a read reloads the preview, so a slow one never finishes and
 * a loaded one keeps restarting.
 *
 *   - A COOKIE HOST's address is the ref alone, and the ref is deterministic, so it does not move on a poll. With no
 *     credential to spend, a new ref or palette is adopted at once.
 *   - A WIDGET read brings a FRESH single-use credential each time. The row holds the credentialed address it first
 *     framed for as long as the row is the same row (the same ref), and adopts a newer credential only when the reader
 *     asked for a retry (the held one may be spent or expired) or the palette changed (a repaint of a spent address
 *     would draw the refusal; the row asks for a fresh read once per palette and keeps the frame until it lands).
 *   - A NEW REF (a new decision, or another row in this place) adopts the live answer at once.
 */
function useHeldArtifactsAddress(
  row: PublishDecisionCardArtifactsRow,
  colorScheme: LifecycleColorScheme | null,
  reread: () => void,
): { islandSrc: string | null; scheme: LifecycleColorScheme | null; askFresh: () => void } {
  const live: HeldArtifactsAddress = { ref: row.ref, scheme: colorScheme, islandSrc: row.islandSrc, fresh: false, askedFor: null };
  const [held, setHeld] = useState<HeldArtifactsAddress>(live);
  const credentialed = (src: string | null) => row.ref !== null && reviewIslandAddressCredential(src, row.ref) !== null;
  let current = held;
  let adopt = false;
  if (held.ref !== row.ref) {
    adopt = true;
  } else if (!credentialed(held.islandSrc)) {
    // Nothing to spend: a newer address or a repaint lands at once.
    adopt = held.islandSrc !== row.islandSrc || held.scheme !== colorScheme;
  } else if (held.fresh || held.scheme !== colorScheme) {
    adopt = row.islandSrc !== held.islandSrc && credentialed(row.islandSrc);
  }
  if (adopt) {
    current = live;
    setHeld(live);
  }
  const repaintWaits = !adopt && credentialed(current.islandSrc) && current.scheme !== colorScheme;
  useEffect(() => {
    if (!repaintWaits || held.askedFor === colorScheme) return;
    setHeld((h) => ({ ...h, askedFor: colorScheme }));
    reread();
  }, [repaintWaits, held.askedFor, colorScheme, reread]);
  const askFresh = useCallback(() => setHeld((h) => ({ ...h, fresh: true })), []);
  return { islandSrc: current.islandSrc, scheme: current.scheme, askFresh };
}

/**
 * An artifacts row (cinatra#4150 W4 C1b): the surfaced revisions drawn by the SAME review-target island a review gate
 * frames, through the review card's own frame (its loading, timeout and retry states and the height the island
 * reports), read only. The island is addressed by the row's ref and loads the targets itself; a host that proves itself
 * with its own credential frames the server-minted address its read carried, and only when that address names this
 * row's ref. A row with no ref, or an address that cannot be composed, says the items could not be shown: the row
 * never vanishes, so no one decides on content they were not shown. The retry re-reads the card for a fresh address.
 */
function ArtifactsRow({ row, onRetry }: { row: PublishDecisionCardArtifactsRow; onRetry: () => void }): ReactElement {
  const frame = useLifecycleCardFrame();
  const colorScheme = useLifecycleCardColorScheme();
  const held = useHeldArtifactsAddress(row, colorScheme, onRetry);
  const src = row.ref === null ? null : reviewTargetIslandSrc(row.ref, frame, held.islandSrc, held.scheme);
  const { askFresh } = held;
  const retry = useCallback(() => {
    askFresh();
    onRetry();
  }, [askFresh, onRetry]);
  if (row.ref === null || src === null) {
    return (
      <div data-conformance-id="publish-row-items-refused">
        <dt className={KICK}>{row.label}</dt>
        <dd className="text-xs text-muted-foreground" data-publish-row-kind="artifacts" data-publish-row-unavailable="">
          These items could not be shown.
        </dd>
      </div>
    );
  }
  return (
    <div data-conformance-id="publish-row-items">
      <dt className={KICK}>{row.label}</dt>
      <dd className="mt-1 min-w-0" data-publish-row-kind="artifacts">
        <ReviewTargetFrame
          headers={null}
          islandSrc={src}
          islandCredentialed={reviewIslandAddressCredential(held.islandSrc, row.ref) !== null}
          onRetryResolve={retry}
        />
      </dd>
    </div>
  );
}

/** The marker below a settled card: the only thing that differs between the three readings (XV). */
function settledMarker(state: PublishDecisionCardState): ReactElement | null {
  if (state.state !== "approved" && state.state !== "declined" && state.state !== "expired") return null;
  const [id, pill, label] = MARKERS[state.state];
  const by = (verb: string, name: string | null) => (name ? `${verb} by ${name}.` : `${verb}.`);
  const ended = "The run ended, and nothing outside Cinatra changed.";
  const line =
    state.state === "approved"
      ? `${by("Approved", state.deciderName)} The run goes on to the agent's own step that makes the change.`
      : state.state === "declined"
        ? `${by("Declined", state.deciderName)} ${ended}${state.reason ? ` Reason: \u201c${state.reason}\u201d` : ""}`
        : `No one decided before this request expired. ${ended}`;
  return (
    <div data-conformance-id={id} className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface px-3 py-2">
      <StatusPill status={pill} glyph="dot">{label}</StatusPill>
      <span className="text-xs text-muted-foreground">{line}</span>
    </div>
  );
}

export function PublishDecisionCard({
  runId,
  decide,
  wireRef,
  read,
}: {
  runId: string;
  decide?: PublishDecisionDecide;
  /** The host's change signal for this run (its status): a change re-reads the card. See the hook above. */
  wireRef?: string | null;
  /** A read the HOST already resolved (`usePublishDecisionCardRead`). Given, the card reads nothing itself and draws
   * exactly that state, so the host's other decisions and this card stand on one answer. */
  read?: PublishDecisionCardRead;
}): ReactElement | null {
  const host = useLifecycleCardHost();
  const auth = useLifecycleCardAuth();
  const [noLongerOpen, setNoLongerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");
  const own = usePublishDecisionCardRead({ runId: host === null || read ? "" : runId, auth, wireRef });
  const { state, refreshing, reload } = read ?? own;

  // No host declaration, no authorized answer yet, or no open decision: NO DOM at all.
  if (host === null || state === null || state.state === "none") return null;

  const send = async (answer: "approve" | "decline") => {
    if (!decide || sending) return;
    setSending(true);
    const sentNote = answer === "decline" ? note : "";
    const outcome = await decide({ runId: state.runId, answer, note: sentNote }).catch(() => "failed" as const);
    setSending(false);
    // A late answer is never sent again: the request is no longer open, and the reader is told so.
    if (outcome === "not_open") setNoLongerOpen(true);
    if (outcome === "decided") reload();
  };
  const pending = state.state === "pending";
  const restricted = pending && !state.mayDecide;
  const disabled = restricted || !decide || sending;
  const cardState = refreshing ? "loading" : noLongerOpen ? "no_longer_open" : restricted ? "restricted" : state.state;

  let body: ReactElement;
  if (refreshing) {
    // IV.1 loading: the frame and placeholder lines, no control. Each IV.1 state the card draws carries its spec anchor.
    body = (
      <div className={`${FRAME} grid gap-2 p-3.5`} aria-busy="true" data-conformance-id="publish-state-loading">
        <div className="h-2 w-2/5 rounded-sm bg-surface-muted" />
        <div className="h-1.5 w-[30%] rounded-sm bg-surface-muted" />
        <div className="h-1.5 w-3/5 rounded-sm bg-surface-muted" />
      </div>
    );
  } else if (noLongerOpen) {
    const refresh = () => {
      setNoLongerOpen(false);
      reload(true);
    };
    body = (
      <div className={`${FRAME} px-4 py-4 text-center`} data-conformance-id="publish-state-no-longer-open">
        <p className="text-row-title font-semibold text-foreground">This request is no longer open</p>
        <p className="mt-1 text-xs text-muted-foreground">
          It was already answered, it expired, or the run moved on.{" "}
          <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={refresh}>
            Refresh
          </Button>
        </p>
      </div>
    );
  } else {
    // The whole card: the question, the rows and the controls. The rows anchor (XV.1) is on the frame only when rows are drawn.
    const card = (
      <>
        <div className="border-b border-line px-3.5 py-2.5">
          <span className="text-row-title font-bold text-foreground">Allow this change outside Cinatra?</span>
          <p className="mt-1 font-mono text-fact-line text-muted-foreground">
            {state.agentName}
            {pending ? " \u00b7 nothing outside Cinatra has changed yet" : null}
          </p>
        </div>
        {state.rows.length > 0 ? (
          <dl className="grid gap-2 px-3.5 py-3">
            {state.rows.map((row, i) => (
              <PublishRow key={`${i}-${row.label}`} row={row} onRetry={reload} />
            ))}
          </dl>
        ) : null}
        {pending ? (
          <div className="px-3.5 pb-3">
            {restricted ? null : (
              <label className="block">
                <span className={`mb-1.5 block ${KICK}`}>
                  Note <span className="normal-case tracking-normal">(optional &middot; recorded with Do not allow)</span>
                </span>
                <Textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={"Say why, if you do not allow this\u2026"}
                  disabled={disabled}
                />
              </label>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="outline" size="sm" data-action="decline-publish -> declined"
                disabled={disabled} onClick={() => void send("decline")}>
                Do not allow
              </Button>
              <Button type="button" size="sm" data-action="approve-publish -> released"
                disabled={disabled} onClick={() => void send("approve")}>
                Allow
              </Button>
            </div>
            {restricted ? (
              <p className="mt-2.5 text-xs text-muted-foreground">
                Deciding whether this change is made needs approve access on the run, so Do not allow and Allow stay disabled with the reason shown.
              </p>
            ) : null}
          </div>
        ) : null}
      </>
    );
    body = (
      <>
        {/* One anchor per element: the restricted frame keeps its IV.1 anchor and holds the XV.1 rows anchor inside it. */}
        <div
          className={FRAME}
          data-conformance-id={restricted ? "publish-state-restricted" : state.rows.length > 0 ? "publish-card-rows" : undefined}
        >
          {restricted && state.rows.length > 0 ? <div data-conformance-id="publish-card-rows">{card}</div> : card}
        </div>
        {settledMarker(state)}
      </>
    );
  }

  return (
    <div
      className="my-3 flex w-full min-w-0 flex-col gap-2.5"
      data-lifecycle-card="publish_decision"
      data-lifecycle-card-host={host}
      data-lifecycle-card-state={cardState}
      data-conformance-id="publish-card"
    >
      {body}
    </div>
  );
}

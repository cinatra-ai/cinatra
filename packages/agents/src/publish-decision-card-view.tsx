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
// The two controls send through the `decide` door a host passes (cinatra#4758): `usePublishDecisionDecide` gives a
// client host its door for its transport (the session action, or the broker answer with the host's credential), and a
// server host passes the session action itself. A card given no door draws them disabled.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { Textarea } from "@/components/ui/textarea";

import {
  LIFECYCLE_PUBLISH_DECISION_DECIDE_PATH,
  LIFECYCLE_PUBLISH_DECISION_PATH,
  sendAcrossRenewal,
  useLifecycleCardAuth,
  useLifecycleCardHost,
  type LifecycleCardAuth,
} from "./lifecycle-card-runtime";
import {
  PUBLISH_DECISION_CARD_NONE,
  PUBLISH_DECISION_MAX_NOTE_LENGTH,
  parsePublishDecisionCardState,
  parsePublishDecisionDecideOutcome,
  type PublishDecisionCardAnswer,
  type PublishDecisionCardState,
  type PublishDecisionDecideOutcome,
} from "./publish-decision-card";
import { decidePublishDecisionCardAction, getPublishDecisionCardStateAction } from "./publish-decision-card-actions";
import { runStatusIsTerminal } from "./run-surface-status";

/** The re-read cadence while the host's run has not finished: the run surfaces' own tick (5 s). */
export const PUBLISH_DECISION_CARD_POLL_MS = 5000;

/** A decide door answers: the decision landed, the request was no longer open, or the send failed. */
export type PublishDecisionDecide = (input: {
  runId: string;
  /** The decision the card shows: the answer lands on that decision only. */
  decisionId: string;
  answer: PublishDecisionCardAnswer;
  note: string;
}) => Promise<PublishDecisionDecideOutcome>;

/** The BROKER ANSWER (cinatra#4758), for a host that proves itself with its own credential: a POST of the run, the
 * answer and the note, never a cookie of whoever else is signed in. Anything but a readable answer is "failed". */
async function decidePublishDecisionThroughBroker(
  input: Parameters<PublishDecisionDecide>[0],
  auth: LifecycleCardAuth,
): Promise<PublishDecisionDecideOutcome> {
  try {
    const send = () =>
      fetch(LIFECYCLE_PUBLISH_DECISION_DECIDE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth.headers() },
        body: JSON.stringify({ runId: input.runId, decisionId: input.decisionId, answer: input.answer, note: input.note }),
        credentials: auth.credentials,
      });
    const response = await sendAcrossRenewal(auth, send);
    if (response === null || !response.ok) return "failed";
    return parsePublishDecisionDecideOutcome((await response.json()) as unknown);
  } catch {
    return "failed";
  }
}

/** The host's DECIDE DOOR for its transport (cinatra#4758), the same choice the read makes: with a host credential the
 * broker answer, else the cookie host's session action. Stable for one credential. */
export function usePublishDecisionDecide(auth: LifecycleCardAuth | null): PublishDecisionDecide {
  return useMemo<PublishDecisionDecide>(
    () => (auth ? (input) => decidePublishDecisionThroughBroker(input, auth) : (input) => decidePublishDecisionCardAction(input)),
    [auth],
  );
}

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
  // The decision an answer did not land on: its card says so until the next answer (never on another decision's card).
  const [failedOn, setFailedOn] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const own = usePublishDecisionCardRead({ runId: host === null || read ? "" : runId, auth, wireRef });
  const { state, refreshing, reload } = read ?? own;

  // No host declaration, no authorized answer yet, or no open decision: NO DOM at all.
  if (host === null || state === null || state.state === "none") return null;

  const send = async (answer: "approve" | "decline") => {
    if (!decide || sending || state.state !== "pending") return;
    setSending(true);
    setFailedOn(null);
    const sentNote = answer === "decline" ? note : "";
    const outcome = await decide({ runId: state.runId, decisionId: state.decisionId, answer, note: sentNote }).catch(() => "failed" as const);
    setSending(false);
    // A late answer is never sent again: the request is no longer open, and the reader is told so.
    if (outcome === "not_open") setNoLongerOpen(true);
    if (outcome === "decided") reload();
    // An answer that did not land is told too: the request stays open, and the reader may answer again.
    if (outcome === "failed") setFailedOn(state.decisionId);
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
    body = (
      <>
        <div className={FRAME} data-conformance-id={restricted ? "publish-state-restricted" : undefined}>
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
                <div key={`${i}-${row.label}`}>
                  <dt className={KICK}>{row.label}</dt>
                  <dd className="text-reading text-foreground">{row.value}</dd>
                </div>
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
                    maxLength={PUBLISH_DECISION_MAX_NOTE_LENGTH}
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
              {pending && !restricted && failedOn === state.decisionId ? (
                <p role="status" className="mt-2.5 text-xs text-destructive">
                  The decision could not be sent.
                </p>
              ) : null}
              {restricted ? (
                <p className="mt-2.5 text-xs text-muted-foreground">
                  Deciding whether this change is made needs approve access on the run, so Do not allow and Allow stay disabled with the reason shown.
                </p>
              ) : null}
            </div>
          ) : null}
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

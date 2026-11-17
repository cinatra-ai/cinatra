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

import { useEffect, useRef, useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { Textarea } from "@/components/ui/textarea";

import {
  LIFECYCLE_PUBLISH_DECISION_PATH,
  sendAcrossRenewal,
  useLifecycleCardAuth,
  useLifecycleCardHost,
  type LifecycleCardAuth,
} from "./lifecycle-card-runtime";
import {
  PUBLISH_DECISION_CARD_NONE,
  isListCardRow,
  parsePublishDecisionCardState,
  type PublishDecisionCardRow,
  type PublishDecisionCardState,
} from "./publish-decision-card";
import { getPublishDecisionCardStateAction } from "./publish-decision-card-actions";

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
    const send = () => fetch(url, { method: "GET", headers: auth.headers(), credentials: auth.credentials });
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
 * each read ends, landed or failed, so a caller waiting on a read is never left waiting on a failure. */
export function usePublishDecisionCardState(params: {
  runId: string;
  auth: LifecycleCardAuth | null;
  reloadToken: number;
  onRead?: () => void;
}): PublishDecisionCardState | null {
  const { runId, auth, reloadToken, onRead } = params;
  const [resolved, setResolved] = useState<{ runId: string; state: PublishDecisionCardState } | null>(null);
  const onReadRef = useRef(onRead);
  useEffect(() => {
    onReadRef.current = onRead;
  }, [onRead]);
  const [focusToken, setFocusToken] = useState(0);
  useEffect(() => {
    const onFocus = () => setFocusToken((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    if (!runId) return;
    let live = true;
    const ended = new AbortController();
    void (async () => {
      const state = auth
        ? await readPublishDecisionThroughBroker(runId, auth, ended.signal)
        : await getPublishDecisionCardStateAction({ runId }).then(parsePublishDecisionCardState, () => null);
      // A read that could not be completed is a FAILURE, not a state: the last authorized answer stands.
      if (live && state !== null) setResolved({ runId, state });
      if (live) onReadRef.current?.();
    })();
    return () => {
      live = false;
      ended.abort();
    };
  }, [runId, auth, reloadToken, focusToken]);
  return resolved && resolved.runId === runId ? resolved.state : null;
}

const FRAME = "w-full min-w-0 overflow-hidden rounded-card border border-line bg-surface-strong";
const KICK = "font-mono text-badge-2xs uppercase tracking-kicker text-muted-foreground";
const MARKERS = {
  approved: ["publish-card-approved", "approved", "Publish approved"],
  declined: ["publish-card-declined", "idle", "Not published"],
  expired: ["publish-card-expired", "idle", "Expired"],
} as const;

/** One read-only row's value (cinatra#4150 W4): a text row's value, or a list row's compact table, with a line that
 * says how many records it does not draw. Every cell is plain text. */
function rowValue(row: PublishDecisionCardRow): ReactElement {
  if (!isListCardRow(row)) return <dd className="text-reading text-foreground">{row.value}</dd>;
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

/** The marker below a settled card: the only thing that differs between the three readings (XV). */
function settledMarker(state: PublishDecisionCardState): ReactElement | null {
  if (state.state !== "approved" && state.state !== "declined" && state.state !== "expired") return null;
  const [id, pill, label] = MARKERS[state.state];
  const by = (verb: string, name: string | null) => (name ? `${verb} by ${name}.` : `${verb}.`);
  const ended = "The run ended, and nothing was published.";
  const line =
    state.state === "approved"
      ? `${by("Approved", state.deciderName)} The run goes on to the agent's own publishing step.`
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

export function PublishDecisionCard({ runId, decide }: { runId: string; decide?: PublishDecisionDecide }): ReactElement | null {
  const host = useLifecycleCardHost();
  const auth = useLifecycleCardAuth();
  const [reloadToken, setReloadToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [noLongerOpen, setNoLongerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");
  // Loading ends when the re-read ENDS, landed or failed: a failed re-read keeps the last answer on screen (IV.1).
  const state = usePublishDecisionCardState({
    runId: host === null ? "" : runId,
    auth,
    reloadToken,
    onRead: () => setRefreshing(false),
  });

  // No host declaration, no authorized answer yet, or no open decision: NO DOM at all.
  if (host === null || state === null || state.state === "none") return null;

  const reload = () => setReloadToken((n) => n + 1);
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
    // IV.1 loading: the frame and placeholder lines, no control.
    body = (
      <div className={`${FRAME} grid gap-2 p-3.5`} aria-busy="true">
        <div className="h-2 w-2/5 rounded-sm bg-surface-muted" />
        <div className="h-1.5 w-[30%] rounded-sm bg-surface-muted" />
        <div className="h-1.5 w-3/5 rounded-sm bg-surface-muted" />
      </div>
    );
  } else if (noLongerOpen) {
    const refresh = () => {
      setNoLongerOpen(false);
      setRefreshing(true);
      reload();
    };
    body = (
      <div className={`${FRAME} px-4 py-4 text-center`}>
        <p className="text-row-title font-semibold text-foreground">This publish request is no longer open</p>
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
        <div className={FRAME}>
          <div className="border-b border-line px-3.5 py-2.5">
            <span className="text-row-title font-bold text-foreground">Publish this?</span>
            <p className="mt-1 font-mono text-fact-line text-muted-foreground">
              {state.agentName}
              {pending ? " \u00b7 nothing has been published" : null}
            </p>
          </div>
          {state.rows.length > 0 ? (
            <dl className="grid gap-2 px-3.5 py-3">
              {state.rows.map((row, i) => (
                <div key={`${i}-${row.label}`}>
                  <dt className={KICK}>{row.label}</dt>
                  {rowValue(row)}
                </div>
              ))}
            </dl>
          ) : null}
          {pending ? (
            <div className="px-3.5 pb-3">
              {restricted ? null : (
                <label className="block">
                  <span className={`mb-1.5 block ${KICK}`}>
                    Note <span className="normal-case tracking-normal">(optional &middot; recorded with Do not publish)</span>
                  </span>
                  <Textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={"Say why, if you do not publish\u2026"}
                    disabled={disabled}
                  />
                </label>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                <Button type="button" variant="outline" size="sm" data-action="decline-publish -> declined"
                  disabled={disabled} onClick={() => void send("decline")}>
                  Do not publish
                </Button>
                <Button type="button" size="sm" data-action="approve-publish -> released"
                  disabled={disabled} onClick={() => void send("approve")}>
                  Publish
                </Button>
              </div>
              {restricted ? (
                <p className="mt-2.5 text-xs text-muted-foreground">
                  Deciding whether this goes out needs approve access on the run.
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

"use client";

/**
 * Inline AgenticRunPanel wrapper for the chat thread.
 *
 * When the chat dispatches an agent via the hard pre-router
 * (src/app/api/chat/explicit-dispatch-server.ts), the synthetic `tool_result`
 * event carries the runId. ChatPage tracks active run ids in a map and renders
 * <InlineAgentRunCard runId={...}> beneath the assistant message — surfacing
 * the SAME AgenticRunPanel that the /agents/<v>/<s>/<runId> detail page uses.
 *
 * Why this wrapper exists rather than rendering AgenticRunPanel directly:
 *
 *   AgenticRunPanel's props include `initialStatus`, `initialMessages`,
 *   `inputParams`, `templateId`, `agentPackageName`, `agUiEnabled`, `taskId`,
 *   `traceId` — all SSR-loaded directly from the DB on the run-detail page.
 *   The chat thread doesn't have those at render time; it only knows the
 *   runId from the tool_result event. This component performs the one-shot
 *   GET /api/agents/runs/<runId> needed to seed those props, then mounts
 *   AgenticRunPanel with the loaded values. AgenticRunPanel itself owns all
 *   subsequent polling + SSE + HITL drive logic (Continue button, fieldName
 *   wrapping, stale-gate suppression, grouped setup handling).
 *
 * The chat thread renders AgenticRunPanel directly so its inline HITL behavior
 * matches the run-detail page, including fieldName-wrapping, the Continue
 * button, stale-gate suppression, and grouped setup handling.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AgenticRunPanel,
  type SerializedAgentRunMessage,
  type ChatGateDescriptor,
  type HitlGateContext,
} from "@cinatra-ai/agents/client-entry";
import type { RunPollResponse } from "@cinatra-ai/agents/client-entry";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  brokerRequestInit,
  useConversationCredential,
  type ConversationCredential,
} from "./conversation-credential";
import { useAgentCreationProgress } from "./use-agent-creation-progress";

// THE RUN-PAGE LINK IS GONE (cinatra#2997), AND SO IS THE BUILDER IT NEEDED.
//
// The maintainer's words: "Also, the 'Open the run page' link in the top right
// below the 'Agentic Run Progress' card should be removed." The whole run
// lifecycle plays out in this card now — the placeholder while the agent works,
// the review screen when the work opens one — so a link out of the conversation
// is an invitation to leave the surface that already holds everything.
//
// What used to live here was a four-line verbatim copy of the host's
// `src/lib/agent-url.ts:buildAgentInstancePath`, duplicated for a reachable
// module budget, with a unit test pinning the copy against the original. Both
// are deleted with the link: a copy kept for a caller that no longer exists is
// a drift risk with no benefit, and the two other copies in the tree
// (`packages/notifications/src/agent-run-href.ts`, `execution.ts`) still carry
// their own pins for their own callers.

/**
 * Append-only creation-progress timeline.
 * Rendered ABOVE <AgenticRunPanel>. Empty list → chrome NOT rendered.
 */
function CreationProgressTimeline({ runId }: { runId: string }) {
  const rows = useAgentCreationProgress(runId);
  if (rows.length === 0) return null;
  return (
    <Card className="border-line bg-surface backdrop-blur-none mb-2">
      <CardHeader>
        <CardTitle className="text-sm text-foreground">
          Creation progress
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="soft-panel rounded-panel flex flex-col gap-1 p-3">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-baseline gap-2 text-sm text-foreground"
            >
              <span className="font-medium">{row.title}</span>
              {row.body ? (
                <span className="text-muted-foreground">{row.body}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

type SeedData = {
  status: string;
  error: string | null;
  inputParams: Record<string, unknown>;
  templateId: string;
  agentPackageName: string | null;
  agUiEnabled: boolean | null;
  taskId: string | null;
  traceId: string | null;
  messages: SerializedAgentRunMessage[];
  /**
   * The run's OPEN gate, as the run API already derives it. The seed used to
   * drop this field on the floor and let the panel re-discover the gate on its
   * own poll, which is why a chat card could sit on the formless "awaiting
   * approval" banner while the actionable form was one already-answered request
   * away. It is read off the same response as every other seed value.
   */
  hitlContext?: HitlGateContext | null;
  /**
   * THE RUN'S REVIEW SLOT (cinatra#2997) — the server-minted ticket for this
   * run's own review gate, and whether a produced output's review question is
   * still open. Read off the same response as every other seed value, so the
   * card's first paint already knows whether it is the placeholder or the
   * review screen.
   */
  reviewGate?: {
    ref: string | null;
    awaiting: boolean;
    /** Whether the gate the ref names is still open (cinatra#3051). */
    pending?: boolean;
  } | null;
};

type LoadFailureReason = "not-found" | "forbidden" | "transient" | "unaddressable";

function classifyStatus(status: number): LoadFailureReason {
  if (status === 404) return "not-found";
  if (status === 401 || status === 403) return "forbidden";
  return "transient";
}

/** The seed's address. One definition, so the two branches cannot drift apart. */
const SEED_ROUTE = "/api/agents/runs";

/**
 * THE REQUEST THE SEED IS MADE WITH (cinatra#2902).
 *
 * The panel's first act is to read the run it must draw, and until this slice it
 * could only ask one way: with whatever cookie the browser happened to hold. On
 * the embedded widget — a frame same-origin to the Cinatra app on a page served
 * by another site — that request carried no cookie at all (a `Lax` session cookie
 * does not travel cross-site), so the guard answered it before the handler ran
 * and the panel drew its failure line for ever.
 *
 * It now asks with whichever credential the host declared, and this is the ONE
 * place that reads it. The three answers are the column's own three:
 *
 *   · COOKIE — a first-party host. The request is UNCHANGED, to the byte: the
 *     same URL, the same `Accept`, the same `cache: "no-store"`, and no
 *     `credentials` field, so the ambient session rides it exactly as it always
 *     has. A preservation control pins this.
 *   · BROKER — the widget. The broker headers travel on the request and
 *     `credentials` is `"omit"`, both supplied by the one shared builder so a
 *     caller cannot forget the mode and send a cookie it must not send.
 *   · REFUSED — a host that cannot say who is asking. It asks NOTHING. A run is
 *     somebody's work, and an unclear surface must not learn about one by
 *     issuing the request that would answer as whoever else is signed in.
 */
function seedRequest(
  credential: ConversationCredential,
  runId: string,
): { url: string; init: RequestInit } | null {
  if (credential.kind === "refused") return null;
  const url = `${SEED_ROUTE}/${encodeURIComponent(runId)}`;
  const base: RequestInit = {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  };
  if (credential.kind === "cookie") return { url, init: base };
  return { url, init: brokerRequestInit(credential.auth, base) };
}

/**
 * THE SLOT READER THIS SURFACE ASKS WITH (cinatra#2997).
 *
 * The panel re-reads the run's review slot after the run finishes, so the
 * placeholder can become the review screen without anybody asking. That read is
 * the SAME route the seed above uses, and it must therefore travel on the SAME
 * credential — built by the one shared builder, so a widget frame keeps
 * `credentials: "omit"` and never sends an ambient cookie, and a host that
 * cannot say who is asking reads nothing at all.
 */
function reviewSlotReader(
  credential: ConversationCredential,
  runId: string,
):
  | ((
      signal: AbortSignal,
    ) => Promise<{
      ref: string | null;
      awaiting: boolean;
      pending: boolean;
    } | null>)
  | undefined {
  const request = seedRequest(credential, runId);
  if (!request) return undefined;
  return async (signal) => {
    const res = await fetch(request.url, { ...request.init, signal });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      reviewGate?: {
        ref?: string | null;
        awaiting?: boolean;
        pending?: boolean;
      } | null;
    };
    if (!data?.reviewGate) return null;
    return {
      ref: typeof data.reviewGate.ref === "string" && data.reviewGate.ref.length > 0
        ? data.reviewGate.ref
        : null,
      awaiting: Boolean(data.reviewGate.awaiting),
      // The widget's own re-read carries the SAME facts the seed does — a
      // surface that drops one of them cannot draw the reading the other two
      // hosts draw (cinatra#3051).
      pending: Boolean(data.reviewGate.pending),
    };
  };
}

/**
 * THE RUN'S OWN RE-READ (cinatra#3051).
 *
 * The panel keeps the run current on its own tick — that is how a run which
 * parks for review while the page is open reaches its review with nobody
 * re-opening the page. Until this change the panel could not use that tick on
 * the widget: its live status came from the app's cookie-session run stream,
 * which cannot carry a broker credential, and the tick's status write stood
 * aside for it. The tick is authoritative on this host now, so the read it makes
 * has to travel on the SAME credential the seed and the slot do — built by the
 * one shared builder, so a widget frame keeps `credentials: "omit"` and never
 * sends an ambient cookie, and a host that cannot say who is asking reads
 * nothing at all.
 */
function runSnapshotReader(
  credential: ConversationCredential,
  runId: string,
): (() => Promise<RunPollResponse | null>) | undefined {
  const request = seedRequest(credential, runId);
  if (!request) return undefined;
  return async () => {
    const res = await fetch(request.url, request.init);
    if (!res.ok) return null;
    return (await res.json()) as RunPollResponse;
  };
}

export function InlineAgentRunCard({
  runId,
  onActiveGateChange,
  recommendationDecided,
}: {
  runId: string;
  /**
   * THIS RUN'S SKILLS WERE DECIDED ON THE RECOMMENDATION CARD
   * (cinatra#2790, epic #2784 S9f).
   *
   * Resolved ONCE by the conversation's own recommendation card and passed
   * down, because inside a transcript the conversation owns that card and the
   * panel mounts none of its own — so the panel has nothing to read it from.
   * The plan's ruling is what it carries: "The agentic run progress card
   * appears once the skills are decided; no skill inside it can be selected."
   * The panel draws no skill picker when this is true. Absent/false is the
   * unchanged reading, for a run that never had a recommendation.
   */
  recommendationDecided?: boolean;
  /**
   * Forwarded to AgenticRunPanel so the chat thread can drive an open HITL gate
   * via the prompt window. Fires with a stable descriptor on gate identity
   * change, or null (same runId) when the gate closes.
   */
  onActiveGateChange?: (
    runId: string,
    gate: ChatGateDescriptor | null,
    instanceId: string,
  ) => void;
}) {
  const [seed, setSeed] = useState<SeedData | null>(null);
  const [loadError, setLoadError] = useState<LoadFailureReason | null>(null);
  // THE CREDENTIAL THIS SURFACE ASKS WITH (cinatra#2902). Memoized on the two
  // context values it derives from, which is load-bearing rather than tidy: it
  // is an effect dependency below, and a fresh object every render would make
  // the seed re-fire on every render — a polling loop, not a mount load.
  const credential = useConversationCredential();
  // Memoized on the same two values the seed's credential is, for the same
  // reason: it is a hook input below, and a fresh function every render would
  // restart the panel's slot reader on every render.
  const slotReader = useMemo(
    () => reviewSlotReader(credential, runId),
    [credential, runId],
  );
  // Memoized on the same two values, and for the same reason: it is a hook
  // input inside the panel, and a fresh function every render would restart the
  // panel's tick on every render.
  const runSnapshot = useMemo(
    () => runSnapshotReader(credential, runId),
    [credential, runId],
  );

  useEffect(() => {
    let cancelled = false;
    // Reset state when runId changes — defensive hygiene even though chat
    // typically mounts a fresh component per runId.
    setSeed(null);
    setLoadError(null);

    // The hard pre-router awaits `invokePrimitive("agent_run", ...)` before
    // emitting the synthetic SSE tool_result, so the run row is already in
    // the DB by the time this component mounts. Retry only on the off chance
    // of a transient read race: 2 attempts with 250ms/750ms backoff.
    const RETRY_DELAYS_MS = [250, 750];
    let attempt = 0;

    const request = seedRequest(credential, runId);
    if (!request) {
      // A host that declared no usable credential asks nothing at all, and says
      // so rather than sitting on the loading line for ever.
      setLoadError("unaddressable");
      return () => {
        cancelled = true;
      };
    }

    const load = async (): Promise<void> => {
      try {
        const res = await fetch(request.url, request.init);
        if (cancelled) return;
        if (!res.ok) {
          const reason = classifyStatus(res.status);
          if (reason !== "forbidden" && attempt < RETRY_DELAYS_MS.length) {
            const delay = RETRY_DELAYS_MS[attempt];
            attempt += 1;
            setTimeout(() => {
              if (!cancelled) void load();
            }, delay);
            return;
          }
          setLoadError(reason);
          return;
        }
        const body = (await res.json()) as SeedData;
        if (cancelled) return;
        setSeed(body);
      } catch {
        if (cancelled) return;
        if (attempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[attempt];
          attempt += 1;
          setTimeout(() => {
            if (!cancelled) void load();
          }, delay);
          return;
        }
        setLoadError("transient");
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [runId, credential]);

  if (loadError) {
    const message =
      loadError === "not-found"
        ? `Agent run ${runId.slice(0, 8)} is not available yet.`
        : loadError === "forbidden"
          ? "You do not have access to this agent run."
          : loadError === "unaddressable"
            ? `Agent run ${runId.slice(0, 8)} cannot be shown here.`
            : `Could not load agent run ${runId.slice(0, 8)} — please try again.`;
    return (
      <div className="soft-panel rounded-panel p-3 my-2 text-sm text-muted-foreground">
        {message}
      </div>
    );
  }

  if (!seed) {
    return (
      <div className="soft-panel rounded-panel p-3 my-2 text-sm text-muted-foreground">
        Loading agent run…
      </div>
    );
  }

  return (
    // `data-inline-run-card` names the run this panel was mounted for. Passive —
    // it draws nothing and drives nothing — and it exists because the panel's
    // PRESENCE is now a ruled property of the turn: it is withheld while the
    // recommended skills can still be chosen, so a proof of that state has to be
    // able to count it and find none. The same name the transcript suites' own
    // stand-in for this panel has always declared.
    <div className="my-2" data-inline-run-card={runId}>
      <CreationProgressTimeline runId={runId} />
      <AgenticRunPanel
        runId={runId}
        taskId={seed.taskId ?? undefined}
        initialStatus={seed.status}
        initialError={seed.error}
        initialMessages={seed.messages}
        agUiEnabled={seed.agUiEnabled ?? undefined}
        agentPackageName={seed.agentPackageName ?? undefined}
        traceId={seed.traceId ?? undefined}
        inputParams={seed.inputParams}
        templateId={seed.templateId}
        initialHitlContext={seed.hitlContext ?? null}
        onActiveGateChange={onActiveGateChange}
        recommendationDecided={recommendationDecided}
        surface="chat"
        initialReviewGate={seed.reviewGate ?? null}
        readReviewSlot={slotReader}
        readRunSnapshot={runSnapshot}
      />
    </div>
  );
}

"use client";

// ---------------------------------------------------------------------------
// S5 (cinatra#1221) Lane B §2/§8/§9 — the embed page CLIENT component.
//
// The SOLE AG-UI session owner (the CMS widget holds no chat client — only the
// launcher/panel chrome + the bridge peer). It:
//   1. installs the iframe-side bridge and posts READY, transferring one
//      MessageChannel endpoint to the expected parent origin (§3a/§12b);
//   2. accepts the ONE inbound BOOTSTRAP — over the retained port (the hardened
//      transport) or, during the negotiated transition, the legacy window path
//      (origin + source-window + schema + nonce + assistant/instance agreement,
//      all in `embed-bridge.client` / §4-6/§12b). `requirePort` is intentionally
//      left at its default (false) here so the embed still interoperates with an
//      as-yet-unmigrated widget; it flips to true once both widgets have migrated;
//   3. negotiates the stream contract CLIENT-SIDE (§8) — mounts the wire ONLY on
//      `ok`, else renders the honest GATED state (Lane-A interlock);
//   4. mounts the SHARED conversation column, which drives the turn against
//      `/api/assistants/chat` with the §9.1 broker seams (`assistant`,
//      `authHeaders`, `credentials: "omit"`);
//   5. mirrors the renderer's apply-intent gesture (§6e) back to the parent over
//      the bridge as a signal-only uplink (§6f — the parent does the CMS check).
//
// WHAT S8f (cinatra#2683) CHANGED HERE, AND WHY IT IS A DELETION. This file used
// to mount `ConversationTurn` — a renderer whose state is ONE reduced assistant
// message — plus a bespoke single-line composer, a bespoke `renderMarkdown` call
// and an empty widget detector. The 2026-08-12 inventory measured what followed
// from that: no history, no user echo, no identity row, no per-message actions,
// no response actions, no attachments / prompt options / @-mentions, no code
// highlighting, no mermaid, no charts, no extension chat widgets. All of it was
// present in `/chat` the whole time, in modules this file did not mount.
//
// So this file no longer renders conversation UI at all. It renders the FRAME
// and hands the shared `ConversationColumn` its host adapters: the broker
// transport, the lifecycle host declaration, the extension catalogs the server
// component resolved, and the apply-intent uplink. Everything a reader sees
// inside the column is now the SAME component `/chat` renders — which is the
// epic's rule, and the reason a future conversation affordance cannot land on
// one surface and miss the other.
//
// TOKEN NON-DISCLOSURE (§6i): the `cit_`/`cwu_` tokens live ONLY in a ref closure
// — never in React state (no render/serialization exposure), never logged, never
// in the URL, never in an uplink. A neutral "waiting"/"gated"/"error" card is the
// ONLY thing shown before a valid, negotiated bootstrap — no oracle to the parent.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ThemeName } from "@cinatra-ai/chat/renderer";
import type {
  ApplyIntentRef,
  ChatViewComponents,
  ConversationTransport,
  ConversationTurnStatus,
  LifecycleSurfaceDeclaration,
  UiMessage,
  WidgetDefinition,
  WidgetManifest,
} from "@cinatra-ai/chat/conversation-column";
import {
  ConversationColumn,
  useConversationColumnTurns,
} from "@cinatra-ai/chat/conversation-column";
import {
  installEmbedBridge,
  type EmbedBridge,
} from "@/lib/embed/embed-bridge.client";
import type { EmbedBootstrap } from "@/lib/embed/bridge-protocol";
import { negotiateEmbedChatContract } from "./embed-chat-negotiate";
// cinatra#2577 (epic #2564 S8d) — the host declaration that turns lifecycle
// cards on for this surface. Until then the embed declared nothing and a card
// rendered no DOM whatever the transcript carried. It draws the SAME lifecycle
// cards as first-party chat — review, verification, recommendation and schedule
// proposal — because a signed-in widget reader is the same person with the same
// rights as inside Cinatra. Only this frame differs. S8f passes the declaration
// DOWN to the shared column instead of wrapping a provider here, so the one
// column carries its host with it and a second mount cannot pick a different one.
import type { LifecycleCardAuth } from "@cinatra-ai/agents/lifecycle-card-runtime";

type Phase =
  | { kind: "waiting" } // pre-bootstrap: neutral "waiting for host"
  | { kind: "gated"; reason: string } // handshake fail-closed (Lane-A interlock)
  | { kind: "error" } // bootstrap rejected / turn transport failure
  | { kind: "active" }; // negotiated + mounted

/** The non-secret session context the mounted column needs. Deliberately NOT
 *  the bootstrap: the tokens stay in the ref closure and never enter state. */
type MountedSession = { threadId: string; assistant: string };

export type EmbedAssistantClientProps = {
  /** Server-resolved expected parent origin (§7). Empty when unresolvable — then
   *  the bridge posts nothing and the shell shows the neutral error card. */
  expectedParentOrigin: string;
  assistant: string;
  instanceId: string;
  /** github-light | github-dark — the content-render theme handed to the shared
   *  column (shiki code theme). Prod default is github-light; the render-parity
   *  seam pins each theme so the compare exercises both goldens. */
  theme?: ThemeName;
  /** Extension-provided chat WIDGETS, resolved server-side from the generated
   *  extension manifest by the page shell — the SAME catalog `/chat` resolves,
   *  through the same resolver. Absent ⇒ the shared column builds its own empty
   *  runtime from the same factory (a real detector with nothing registered, not
   *  a bespoke "no widgets" stub). */
  widgets?: WidgetDefinition[];
  widgetManifests?: WidgetManifest[];
  /** Extension-provided renderable-view components (viewType → component), the
   *  SAME server-resolved map `/chat` receives. Absent ⇒ the never-blank
   *  fallback for `chart`, exactly as on `/chat` with no view extension live. */
  chatViews?: ChatViewComponents;
  /** cinatra#1998 (b) — the TEST-ONLY deterministic corpus-render seam. Non-null
   *  ONLY when the server-side `EMBED_PARITY_SEAM` gate is on (resolved in
   *  page.tsx from a non-public server env, never a client/URL value), so prod is
   *  INERT. When set, the embed — AFTER reaching `active` via the REAL mount path
   *  (parent bootstrap + broker negotiation + column mount) — renders a seeded
   *  thread's assistant message deterministically IN PLACE OF a live LLM turn. It
   *  CANNOT bypass auth (reaching `active` still requires the real handshake) and
   *  is not user-controllable in prod (the server gate is off → this is null). */
  paritySeam?: { threadId: string } | null;
};

export function EmbedAssistantClient(props: EmbedAssistantClientProps) {
  // An unresolvable expected parent origin (§7 'none') is an initial ERROR — a
  // render-time derivation, NOT a setState-in-effect (the origin is server-fixed
  // and never changes for the mounted page).
  const [phase, setPhase] = useState<Phase>(() =>
    props.expectedParentOrigin ? { kind: "waiting" } : { kind: "error" },
  );
  const [session, setSession] = useState<MountedSession | null>(null);
  const [turnStatus, setTurnStatus] = useState<ConversationTurnStatus>("idle");
  const [seededMessages, setSeededMessages] = useState<UiMessage[] | undefined>(undefined);

  // Tokens + session context held ONLY here (never state / log / URL / uplink).
  const bootstrapRef = useRef<EmbedBootstrap | null>(null);
  const bridgeRef = useRef<EmbedBridge | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // §9.1 broker headers derived from the closure-held tokens.
  const authHeaders = useCallback((): Record<string, string> => {
    const b = bootstrapRef.current;
    if (!b) return {};
    return {
      Authorization: `Bearer ${b.auth.citToken}`,
      "X-Cinatra-Widget-User-Token": b.auth.cwuToken,
      // The bound assistant handle. The TURN carries it in its body, so this
      // header used to belong only to the capability negotiation; the lifecycle
      // refetch (cinatra#2577) has no body field for it and needs it here, and
      // sending it on every broker call keeps ONE seam rather than three
      // slightly different ones. It is a SELECTOR, never an authority: the
      // server re-checks `agent_slug` inside both token consumes, so a forged
      // value fails closed.
      "X-Cinatra-Widget-Assistant": b.session.assistant,
      // The turn POST is SAME-ORIGIN to the Cinatra app, so the browser `Origin`
      // is the Cinatra origin — NOT the CMS site origin the cit_/cwu_ tokens are
      // bound to (and JS cannot set the forbidden `Origin`). Forward the
      // server-resolved parent (CMS) origin so the broker validates the token
      // binding against the right origin — the SAME forwarded seam the capability
      // negotiation already uses (embed-chat-negotiate.ts). A forged value fails
      // the consume closed; the tokens, never this header, are the authority.
      "X-Cinatra-Widget-Origin": props.expectedParentOrigin,
    };
  }, [props.expectedParentOrigin]);

  // The conversation column's TRANSPORT. One declaration now serves the turn on
  // this surface, built at call time from the closure-held tokens — never held
  // in state or a prop. `credentialsMode: "omit"` is load-bearing: the embed is
  // same-origin to the Cinatra app, so an ambient cookie from another Cinatra
  // user of this browser would otherwise answer as THEM.
  // Read the selector out FIRST: the memo then depends on the string, not on
  // the session object, so it does not re-create on an unrelated session field.
  const producerSelector = session?.assistant;
  const transport = useMemo(
    () => ({
      authHeaders,
      credentialsMode: "omit" as const,
      ...(producerSelector ? { assistant: producerSelector } : {}),
    }),
    [authHeaders, producerSelector],
  );

  // The lifecycle card's credential (cinatra#2577) — the same proof, declared in
  // the shape the card runtime reads. The runtime REFUSES to declare a host when
  // the credential is wrong for it, so a dropped field here means no card DOM and
  // no request, never a cookie-borne resolve.
  const lifecycleCardAuth = useMemo<LifecycleCardAuth>(
    () => ({ headers: authHeaders, credentials: "omit" }),
    [authHeaders],
  );

  // The lifecycle card's EMBEDDING CONTEXT (cinatra#2577). The review card's
  // §III island is a nested first-party document, so inside this widget it has
  // two ancestors — this frame and the registered site framing it — and a
  // `frame-ancestors 'self'` wall refuses to render it (the island was blank on
  // the widget for exactly that reason). These are the page's OWN server-read
  // query disambiguators, passed on so the island's guard can re-derive the one
  // registered origin from the same closed binding the embed's own wall uses.
  // Not a credential and not an origin: they select a row, they do not assert
  // anything.
  //
  // The whole declaration now travels to the shared column as ONE object, which
  // is also the seam the column's link policy and its cookie-bound affordances
  // key off — one statement of "who this surface is", read by everything.
  const lifecycleSurface = useMemo(
    () => ({
      host: "site_widget" as const,
      auth: lifecycleCardAuth,
      frame: { assistant: props.assistant, instanceId: props.instanceId },
    }),
    [lifecycleCardAuth, props.assistant, props.instanceId],
  );

  // cinatra#1998 (b) TEST-ONLY seam: load a seeded thread's assistant message and
  // render it deterministically through the mounted column (no live LLM turn).
  // Gated OFF in prod (`paritySeam` is null unless the server env is set), so
  // this fetch never runs for a real user. It cannot bypass auth — it runs only
  // AFTER the real bootstrap + broker negotiation reached `active`.
  const loadParitySeed = useCallback(async (threadId: string) => {
    try {
      const res = await fetch(`/api/assistants/threads/${encodeURIComponent(threadId)}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const payload = (await res.json()) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const assistantMsg = payload.messages?.find((m) => m.role === "assistant");
      setSeededMessages([
        { id: "parity-seed", role: "assistant", content: assistantMsg?.content ?? "" },
      ]);
      setTurnStatus("finished");
    } catch {
      /* best-effort + test-only: a failure leaves the mounted-but-empty active
         state, which the harness surfaces as a missing content block (loud). */
    }
  }, []);

  const onBootstrap = useCallback(
    (bootstrap: EmbedBootstrap) => {
      bootstrapRef.current = bootstrap;
      // §8 client-side handshake — mount ONLY on ok, else the honest gated state.
      // The negotiator is itself fail-closed, but a defensive catch guarantees an
      // unexpected rejection can NEVER leave a permanent "waiting" (fail-closed to
      // gated, never fail-open to a mounted wire).
      void (async () => {
        try {
          const negotiation = await negotiateEmbedChatContract(authHeaders, {
            assistant: bootstrap.session.assistant, // "wordpress" | "drupal"
            parentOrigin: props.expectedParentOrigin, // the CMS-origin the tokens bind
          });
          if (!negotiation.ok) {
            setPhase({ kind: "gated", reason: negotiation.reason });
            return;
          }
          setSession({
            threadId: bootstrap.session.threadId,
            assistant: bootstrap.session.assistant,
          });
          setPhase({ kind: "active" });
          // TEST-ONLY seam (gated OFF in prod): render the seeded corpus here in
          // place of a live turn, through the same mounted column.
          if (props.paritySeam) {
            void loadParitySeed(props.paritySeam.threadId);
          }
        } catch {
          setPhase({ kind: "gated", reason: "handshake_failed" });
        }
      })();
    },
    [authHeaders, props.expectedParentOrigin, props.paritySeam, loadParitySeed],
  );

  // Install the bridge + post READY once. The expected parent origin gates the
  // whole handshake; with none resolvable, render the error card and post
  // nothing (§3/§7).
  useEffect(() => {
    if (!props.expectedParentOrigin) return; // initial phase is already "error"
    const bridge = installEmbedBridge({
      expectedParentOrigin: props.expectedParentOrigin,
      expectedAssistant: props.assistant,
      expectedInstanceId: props.instanceId,
      onBootstrap,
      onReject: () => setPhase({ kind: "error" }),
    });
    bridgeRef.current = bridge;
    bridge.postReady();
    return () => {
      bridge.dispose();
    };
  }, [props.expectedParentOrigin, props.assistant, props.instanceId, onBootstrap]);

  // §5 resize uplink: mirror the content height to the parent so it can size the
  // panel (the parent additionally CLAMPS to its cap). Observed, not polled — a
  // ResizeObserver on the container covers every growth the column produces (a
  // streamed token, an expanded thought group, a mounted card), so this no
  // longer needs the conversation state as a dependency.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || phase.kind !== "active") return;
    const post = () => bridgeRef.current?.sendResize(Math.ceil(el.scrollHeight));
    post();
    const ro = new ResizeObserver(post);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase.kind]);

  // §6e apply-intent gesture → signal-only uplink (§6f: the PARENT does the CMS
  // permission check + in-place draft refresh; the iframe asserts nothing).
  const onApplyIntent = useCallback((ref: ApplyIntentRef) => {
    bridgeRef.current?.sendApplyIntent(ref);
  }, []);

  return (
    // `data-turn-status` mirrors the conversation turn status (idle → running →
    // finished/error) so an out-of-process observer (the wp-drupal-uat E2E) can
    // fence deterministically on a CLIENT-CONSUMED `RUN_FINISHED` (status ===
    // "finished") rather than a mid-stream signal like a completed tool chip. It
    // is a passive test-observability attribute only — it drives no behaviour and
    // is not part of the render-parity content contract (cinatra#1998 (c)).
    <div
      ref={containerRef}
      data-embed-assistant
      data-phase={phase.kind}
      data-turn-status={turnStatus}
      className="flex h-full min-h-0 flex-col"
    >
      {phase.kind === "waiting" && (
        <div className="p-4 text-sm text-muted-foreground" data-embed-state="waiting">
          Waiting for the host…
        </div>
      )}
      {phase.kind === "gated" && (
        <div className="p-4 text-sm text-muted-foreground" data-embed-state="gated">
          This assistant is not available on this site yet.
        </div>
      )}
      {phase.kind === "error" && (
        <div className="p-4 text-sm text-muted-foreground" data-embed-state="error">
          This assistant could not be loaded here.
        </div>
      )}
      {phase.kind === "active" && session && (
        // The column owns an internal scroll exactly as it does on `/chat`, so
        // the frame gives it a definite height instead of growing with the
        // transcript. The resize uplink still reports that height and the parent
        // still clamps it — what changes is that a long conversation scrolls
        // inside the panel rather than stretching it, which is the behaviour a
        // reader already knows from `/chat`.
        <div className="flex min-h-0 flex-1 flex-col" data-embed-state="active">
          <EmbedConversation
            key={seededMessages ? "parity-seed" : "live"}
            session={session}
            transport={transport}
            theme={props.theme ?? "github-light"}
            lifecycleSurface={lifecycleSurface}
            widgets={props.widgets}
            widgetManifests={props.widgetManifests}
            chatViews={props.chatViews}
            seededMessages={seededMessages}
            onApplyIntent={onApplyIntent}
            onTurnStatusChange={setTurnStatus}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The mounted column, with the widget's host adapters.
 *
 * A separate component ONLY because the shared turn engine is a hook and the
 * frame above renders four phases, three of which mount no conversation at all.
 * It adds no conversation UI of its own — it calls the shared engine and mounts
 * the shared column, and a structural test fails the build if it ever does more
 * (`one-conversation-column.test.ts`).
 */
function EmbedConversation({
  session,
  transport,
  theme,
  lifecycleSurface,
  widgets,
  widgetManifests,
  chatViews,
  seededMessages,
  onApplyIntent,
  onTurnStatusChange,
}: {
  session: MountedSession;
  transport: ConversationTransport;
  theme: ThemeName;
  lifecycleSurface: LifecycleSurfaceDeclaration;
  widgets?: WidgetDefinition[];
  widgetManifests?: WidgetManifest[];
  chatViews?: ChatViewComponents;
  seededMessages?: UiMessage[];
  onApplyIntent: (ref: ApplyIntentRef) => void;
  onTurnStatusChange: (status: ConversationTurnStatus) => void;
}) {
  const turns = useConversationColumnTurns({
    threadId: session.threadId,
    transport,
    ...(widgets ? { widgets } : {}),
    ...(widgetManifests ? { widgetManifests } : {}),
    ...(seededMessages ? { initialMessages: seededMessages } : {}),
    onTurnStatusChange,
  });
  const host = useMemo(
    () => ({ lifecycleSurface, onApplyIntent }),
    [lifecycleSurface, onApplyIntent],
  );
  return (
    <ConversationColumn
      {...turns}
      host={host}
      theme={theme}
      chatViews={chatViews ?? {}}
      onActivateResource={NOOP_ACTIVATE_RESOURCE}
      onActiveGateChange={NOOP_ACTIVE_GATE_CHANGE}
      mentionables={NO_MENTIONABLES}
      placeholder="Type a message..."
      promptStorageKey={`cinatra_embed_prompt_${session.threadId}`}
      submitAriaLabel="Send message"
    />
  );
}

/** The widget has no second conversation participant to @-mention, so the shared
 *  composer draws no mention flyout — its own seam, not a per-surface reduction:
 *  supply mentionables and the same composer draws the same flyout here. */
const NO_MENTIONABLES: never[] = [];
/** `/chat`'s in-app resource activation opens a first-party route the widget
 *  frame cannot become; the affordance itself is a `/chat` thread-panel gesture
 *  that no card in this column emits. */
const NOOP_ACTIVATE_RESOURCE = () => {};
/** Prompt-window HITL gate tracking is `/chat` page state (it drives the
 *  page-level gate registry, which the widget frame does not mount). */
const NOOP_ACTIVE_GATE_CHANGE = () => {};

"use client";

// ---------------------------------------------------------------------------
// S5 (cinatra#1221) Lane B §2/§8/§9 — the embed page CLIENT component.
//
// The SOLE AG-UI session owner (the CMS widget holds no chat client — only the
// launcher/panel chrome + the bridge peer). It:
//   1. installs the iframe-side bridge and posts READY, transferring one
//      MessageChannel endpoint to the expected parent origin (§3a/§12b);
//   2. accepts the ONE inbound CONTEXT message — PUBLIC SELECTORS ONLY since
//      cinatra#2674 (protocol 2) — over the retained port (the hardened
//      transport) or the window path (origin + source-window + schema + nonce +
//      assistant/instance agreement, all in `embed-bridge.client` / §4-6/§12b);
//   2b. RUNS ITS OWN SIGN-IN (cinatra#2674, epic #2564 S8e). The credential is
//      acquired by THIS document, on the Cinatra origin, through
//      `runFrameSignIn` — a frame-held PKCE verifier, a top-level Cinatra popup,
//      and an authorization code delivered by `postMessage` to this origin
//      alone. The parent page and the CMS backend are not parties to it and
//      receive nothing;
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
// TOKEN NON-DISCLOSURE (§6i): the credential pair lives ONLY in a ref closure —
// never in React state (no render/serialization exposure), never logged, never
// in the URL, never in an uplink, and never in a message to the parent. What
// changed at S8e is WHERE IT CAME FROM: it is minted for this frame rather than
// handed in, so there is no longer any party outside this document that ever
// held it. A neutral "waiting"/"sign-in"/"gated"/"error" card is the ONLY thing
// shown before a negotiated session — no oracle to the parent.
//
// THE TWO HALVES MEET HERE, AND NEITHER IS A SEPARATE SURFACE. S8f's rule is
// that `/embed/assistant` renders the SAME `ConversationColumn` `/chat` renders;
// S8e's rule is that the credential is the frame's own. They compose exactly
// once, in this file: the sign-in produces the credential, the credential
// produces the broker transport, and the transport is what the ONE shared column
// is handed. There is no widget-shaped conversation component and no
// sign-in-shaped conversation component — the phases above the column decide
// WHETHER it mounts, never WHAT it renders.
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
// cinatra#2683 (epic #2564 S8f, second half) — the conversation column's own
// data paths, with the BROKER transport. These are the SAME functions `/chat`
// calls; the only difference is that this surface hands them a transport, and
// the routes behind them have a widget auth branch that resolves the reader's
// live standing from the `cwu_` instead of from an ambient cookie.
import {
  buildThreadWrite,
  fetchThreadMessages,
  saveThreadTranscript,
  type ConversationServiceTransport,
} from "@cinatra-ai/chat/conversation-services";
import { useBrokeredComposerInputs } from "@cinatra-ai/chat/brokered-composer-inputs";
import {
  installEmbedBridge,
  type EmbedBridge,
} from "@/lib/embed/embed-bridge.client";
import type { EmbedContext } from "@/lib/embed/bridge-protocol";
// cinatra#2674 (epic #2564 S8e) — the frame's OWN sign-in. The only place in the
// widget where a credential is ever created, and it is created HERE, inside the
// Cinatra-served document, from a PKCE verifier no other party sees.
import {
  runFrameSignIn,
  type FrameWidgetCredential,
} from "@/lib/embed/frame-widget-session.client";
import { Button } from "@/components/ui/button";
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
  | { kind: "waiting" } // pre-context: neutral "waiting for host"
  | { kind: "signin" } // context in hand, no credential yet — the person signs in
  | { kind: "authorizing" } // the hosted sign-in is open
  | { kind: "gated"; reason: string } // handshake fail-closed (Lane-A interlock)
  | { kind: "error" } // context rejected / turn transport failure
  | { kind: "active" }; // negotiated + mounted

/** The non-secret session context the mounted column needs. Deliberately NOT
 *  the credential: the tokens stay in the ref closure and never enter state. */
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
   *  (parent context + frame sign-in + broker negotiation + column mount) — renders a seeded
   *  thread's assistant message deterministically IN PLACE OF a live LLM turn. It
   *  CANNOT bypass auth (reaching `active` still requires the real handshake) and
   *  is not user-controllable in prod (the server gate is off → this is null). */
  paritySeam?: { threadId: string } | null;
  /**
   * The "Remote chat" jump-out row of the prompt-options flyout (cinatra#2683
   * item 3), resolved SERVER-SIDE by the page shell from the SAME first-party
   * builder `/chat` uses, for this widget's own registered site.
   *
   * It is NOT a first-party app link and never was: on both surfaces it points
   * at the connected CMS site, and the shared composer already opens it in a new
   * tab on both. So the widget carries the identical row with the identical
   * target — there is no reduction here to invent or to justify.
   */
  remoteChat?: { label: string; href: string };
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
  // The RESTORED transcript (cinatra#2683 item 1). A widget panel that reloads —
  // a navigation on the host page, a closed and reopened panel — used to come
  // back empty, because the only way to read a thread was a cookie-bound request
  // this surface must never make. It now reads the SAME route `/chat` reads,
  // through the broker branch, authorized as the widget principal by the same
  // per-row ownership matrix. `undefined` means "not asked yet"; an empty array
  // is a real answer (a thread with nothing in it).
  const [restoredMessages, setRestoredMessages] = useState<UiMessage[] | undefined>(undefined);
  // Has the restore SETTLED? (codex round 1, finding 2 on the client.)
  //
  // The turn engine seeds its list at first render, so a transcript that arrives
  // after the mount could only be applied by remounting — and a remount throws
  // away whatever the reader did in between. Mounting an empty column and then
  // replacing it is therefore not "eventually consistent", it is a lost message.
  // So the conversation waits: the frame keeps its neutral waiting card for the
  // one round trip, and the column is mounted ONCE, already seeded. `false` only
  // between reaching `active` and the read answering (or failing) — both of
  // which settle it.
  const [historySettled, setHistorySettled] = useState(false);

  // Session context (PUBLIC SELECTORS) and the CREDENTIAL, held ONLY here —
  // never state, never a log, never a URL, never an uplink to the parent. They
  // are two refs rather than one because they now have two different origins:
  // the context comes from the parent and carries nothing secret; the credential
  // comes from this frame's own sign-in and never leaves it.
  const contextRef = useRef<EmbedContext | null>(null);
  const credentialRef = useRef<FrameWidgetCredential | null>(null);
  const bridgeRef = useRef<EmbedBridge | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // §9.1 broker headers derived from the closure-held credential.
  const authHeaders = useCallback((): Record<string, string> => {
    const credential = credentialRef.current;
    const ctx = contextRef.current;
    if (!credential || !ctx) return {};
    return {
      Authorization: `Bearer ${credential.transportToken}`,
      "X-Cinatra-Widget-User-Token": credential.userToken,
      // The bound assistant handle. The TURN carries it in its body, so this
      // header used to belong only to the capability negotiation; the lifecycle
      // refetch (cinatra#2577) has no body field for it and needs it here, and
      // sending it on every broker call keeps ONE seam rather than three
      // slightly different ones. It is a SELECTOR, never an authority: the
      // server re-checks `agent_slug` inside both token consumes, so a forged
      // value fails closed.
      "X-Cinatra-Widget-Assistant": ctx.session.assistant,
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
  // AFTER the real handshake + frame sign-in + broker negotiation reached
  // `active`.
  const loadParitySeed = useCallback(
    async (threadId: string) => {
      // THROUGH THE BROKER, like everything else this surface asks (codex round
      // 1, finding 1 on the client). This used to be the file's one
      // `credentials: "include"` fetch — inert in production behind the server
      // env gate, but still a cookie-bearing request written inside a frame that
      // is same-origin to the app, which is the one shape this surface must not
      // contain. It now reads the SAME route through the SAME shared function
      // with the SAME transport, so "every widget request omits credentials" is
      // a property of the file rather than a property of a gate.
      const messages = await fetchThreadMessages(threadId, {
        authHeaders,
        credentialsMode: "omit",
      });
      const assistantMsg = messages?.find((m) => m.role === "assistant");
      setSeededMessages([
        { id: "parity-seed", role: "assistant", content: assistantMsg?.content ?? "" },
      ]);
      setTurnStatus("finished");
    },
    [authHeaders],
  );

  // The broker-authenticated transcript read (cinatra#2683 item 1). Built from
  // the closure-held tokens at call time, exactly like every other request this
  // surface makes — the tokens never enter state, a prop, a log or the DOM.
  const restoreThread = useCallback(
    async (threadId: string) => {
      const messages = await fetchThreadMessages(threadId, {
        authHeaders,
        credentialsMode: "omit",
      });
      if (messages && messages.length > 0) setRestoredMessages(messages);
      // A new thread, a denied read and a transport failure all SETTLE — the
      // column must open for every one of them, with whatever there was.
      setHistorySettled(true);
    },
    [authHeaders],
  );

  // §8 client-side handshake, then the COLUMN mount — only on `ok`, else the
  // honest gated state. The negotiator is itself fail-closed, but a defensive
  // catch guarantees an unexpected rejection can NEVER leave a permanent
  // "waiting" (fail-closed to gated, never fail-open to a mounted wire).
  //
  // Everything below the negotiation is S8f's, unchanged: the same session, the
  // same restore, the same one-round-trip settle before the ONE shared column
  // mounts. The sign-in changed WHERE the credential comes from, and nothing
  // about what a reader then sees.
  const negotiateAndMount = useCallback(
    async (session: MountedSession) => {
      try {
        const negotiation = await negotiateEmbedChatContract(authHeaders, {
          assistant: session.assistant, // "wordpress" | "drupal"
          parentOrigin: props.expectedParentOrigin, // the CMS origin the pair binds
        });
        if (!negotiation.ok) {
          setPhase({ kind: "gated", reason: negotiation.reason });
          return;
        }
        setSession(session);
        setPhase({ kind: "active" });
        // TEST-ONLY seam (gated OFF in prod): render the seeded corpus here in
        // place of a live turn, through the same mounted column.
        if (props.paritySeam) {
          // The seam supplies the transcript, so it settles the history too.
          void loadParitySeed(props.paritySeam.threadId).finally(() =>
            setHistorySettled(true),
          );
        } else {
          // The REAL restore. Best-effort by design: a new thread, a denied
          // read and a transport failure are all "nothing to restore", and all
          // three leave the reader in the empty conversation they would have
          // had anyway. Nothing is reported to the page — a restore that told
          // the host whether a thread exists would be an oracle.
          void restoreThread(session.threadId);
        }
      } catch {
        setPhase({ kind: "gated", reason: "handshake_failed" });
      }
    },
    [
      authHeaders,
      props.expectedParentOrigin,
      props.paritySeam,
      loadParitySeed,
      restoreThread,
    ],
  );

  // THE SIGN-IN THIS FRAME OWNS (cinatra#2674). Started by an explicit gesture,
  // because opening the hosted window is a navigation a person must have asked
  // for — a popup opened without a click is blocked by every browser, and a
  // sign-in nobody asked for is not a sign-in. The credential lands in the ref
  // and nowhere else; a failure returns to the same neutral card.
  const startSignIn = useCallback(() => {
    const ctx = contextRef.current;
    if (!ctx) return;
    setPhase({ kind: "authorizing" });
    void (async () => {
      const result = await runFrameSignIn({
        // The HANDLE, not an agent slug. The server maps it to the agent through
        // its own closed table, so the frame cannot name one (codex round 0,
        // finding 1 — and `?assistant` was never a slug to begin with).
        assistant: ctx.session.assistant,
        instanceId: props.instanceId,
        siteId: ctx.site?.siteId ?? null,
      });
      if (!result.ok) {
        // Neutral: the person may try again. No reason is surfaced and none is
        // sent anywhere — a failed sign-in must not become an oracle about which
        // site, org or agent exists.
        setPhase({ kind: "signin" });
        return;
      }
      credentialRef.current = result.credential;
      await negotiateAndMount({
        threadId: ctx.session.threadId,
        assistant: ctx.session.assistant,
      });
    })();
  }, [props.instanceId, negotiateAndMount]);

  const onContext = useCallback((context: EmbedContext) => {
    // Selectors only — this cannot mount a wire on its own. The frame now needs
    // a credential, and it goes and gets one itself.
    contextRef.current = context;
    setPhase({ kind: "signin" });
  }, []);

  // Install the bridge + post READY once. The expected parent origin gates the
  // whole handshake; with none resolvable, render the error card and post
  // nothing (§3/§7).
  useEffect(() => {
    if (!props.expectedParentOrigin) return; // initial phase is already "error"
    const bridge = installEmbedBridge({
      expectedParentOrigin: props.expectedParentOrigin,
      expectedAssistant: props.assistant,
      expectedInstanceId: props.instanceId,
      onContext,
      onReject: () => setPhase({ kind: "error" }),
    });
    bridgeRef.current = bridge;
    bridge.postReady();
    return () => {
      bridge.dispose();
    };
  }, [props.expectedParentOrigin, props.assistant, props.instanceId, onContext]);

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
      {phase.kind === "signin" && (
        <div className="p-4" data-embed-state="signin">
          <p className="text-sm text-muted-foreground">
            Sign in to Cinatra to use the assistant here.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            data-embed-signin
            onClick={startSignIn}
          >
            Sign in
          </Button>
        </div>
      )}
      {phase.kind === "authorizing" && (
        <div className="p-4 text-sm text-muted-foreground" data-embed-state="authorizing">
          Waiting for the Cinatra sign-in window…
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
      {phase.kind === "active" && session && !historySettled && (
        // The one round trip the restore costs. The SAME neutral card the
        // pre-bootstrap state shows, so nothing about the wait tells the parent
        // page whether a conversation exists to restore.
        <div className="p-4 text-sm text-muted-foreground" data-embed-state="waiting">
          Waiting for the host…
        </div>
      )}
      {phase.kind === "active" && session && historySettled && (
        // The column owns an internal scroll exactly as it does on `/chat`, so
        // the frame gives it a definite height instead of growing with the
        // transcript. The resize uplink still reports that height and the parent
        // still clamps it — what changes is that a long conversation scrolls
        // inside the panel rather than stretching it, which is the behaviour a
        // reader already knows from `/chat`.
        <div className="flex min-h-0 flex-1 flex-col" data-embed-state="active">
          <EmbedConversation
            // Mounted ONCE, already seeded — the restore settled above, so there
            // is no remount to lose a turn to.
            session={session}
            transport={transport}
            theme={props.theme ?? "github-light"}
            lifecycleSurface={lifecycleSurface}
            widgets={props.widgets}
            widgetManifests={props.widgetManifests}
            chatViews={props.chatViews}
            seededMessages={seededMessages ?? restoredMessages}
            remoteChat={props.remoteChat}
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
  remoteChat,
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
  remoteChat?: { label: string; href: string };
  onApplyIntent: (ref: ApplyIntentRef) => void;
  onTurnStatusChange: (status: ConversationTurnStatus) => void;
}) {
  // The BROKER transport, in the shape the shared services take. One object, so
  // every one of this surface's requests proves itself the same way — and
  // `credentialsMode: "omit"` stays load-bearing on all of them: this frame is
  // same-origin to the Cinatra app.
  const serviceTransport = useMemo<ConversationServiceTransport>(
    () => ({ authHeaders: transport.authHeaders, credentialsMode: "omit" }),
    [transport.authHeaders],
  );

  // ITEMS 2, 3 and 4 — attachments, the Skill-autosave row and the @-mention
  // list, resolved by the SHARED brokered-inputs hook. They are not wired here
  // because a second brokered host would then wire them again, slightly
  // differently; the hook is the one composition, and the two-surface parity
  // harness mounts the same one.
  const {
    mentionables,
    onAttachmentsSelected,
    composerNotice,
    takePendingAttachments,
    autosave,
  } = useBrokeredComposerInputs({
    threadId: session.threadId,
    transport: serviceTransport,
  });

  // ITEM 1, WRITE HALF (cinatra#2683) — KEEP the conversation.
  //
  // The restore above reads the transcript back; this is what puts one there.
  // A widget turn's own durable rows carry a `run_id`, and the payload
  // reconstruction reads only the legacy-mirror rows the thread upsert writes —
  // which `/chat` writes on every turn and the widget could not, because this
  // frame is same-origin to the Cinatra app and a cookie request from it is
  // answered as whoever else is signed in on that browser. So every reload
  // opened on a blank panel, and nothing said why.
  //
  // WHEN: on the turn's SETTLE, and only on a real settle. The status is
  // mirrored locally as well as reported upward so the save can be a plain
  // effect on (status, list) — by the time React runs it both are the final
  // values, which is the whole reason it is an effect and not a callback fired
  // from inside the driver's `finally`, where the list is still the one the
  // closure captured. A transition INTO `running` never saves, and the mount's
  // own `idle` never saves, so the restored transcript is not immediately
  // written back.
  //
  // WHAT IS STATED RATHER THAN HIDDEN: an ABORTED turn settles to `idle`, and
  // that IS saved — the reader's own message is part of the conversation whether
  // or not the assistant finished answering it, and losing it to a stop button
  // would be the same blank-panel surprise one turn smaller.
  const [localTurnStatus, setLocalTurnStatus] = useState<ConversationTurnStatus>("idle");
  const reportTurnStatus = useCallback(
    (status: ConversationTurnStatus) => {
      setLocalTurnStatus(status);
      onTurnStatusChange(status);
    },
    [onTurnStatusChange],
  );

  const turns = useConversationColumnTurns({
    threadId: session.threadId,
    transport,
    ...(widgets ? { widgets } : {}),
    ...(widgetManifests ? { widgetManifests } : {}),
    ...(seededMessages ? { initialMessages: seededMessages } : {}),
    onTurnStatusChange: reportTurnStatus,
    takePendingAttachments,
  });

  // The thread's `createdAt` is decided ONCE per mount: a restored thread keeps
  // whatever it had by re-stating the moment this panel first opened on it, and
  // a new thread is created now. The server takes the value only on the row's
  // first write, so a later save cannot move a thread's birthday.
  const createdAtRef = useRef<string>("");
  if (!createdAtRef.current) createdAtRef.current = new Date().toISOString();

  const wasRunningRef = useRef(false);
  const messages = turns.messages;
  useEffect(() => {
    if (localTurnStatus === "running") {
      wasRunningRef.current = true;
      return;
    }
    // Only a turn that actually RAN produces a save. Without this the restored
    // transcript would be re-posted at mount, stamping `updatedAt` for a
    // conversation nobody added to.
    if (!wasRunningRef.current) return;
    wasRunningRef.current = false;
    if (messages.length === 0) return;
    // THE COLUMN'S OUTSTANDING TRUNCATION INTENT (cinatra#2823 S9j). An edit in
    // this column truncated the transcript, and this is the save that records
    // it: without the assertion the server's reconcile DELETE drops the removed
    // turns' mirror rows while their run-bound rows survive, and the reader's
    // edit comes undone on the next reload. It is CONFIRMED rather than drained
    // — a widget save is best-effort and silent, so an assertion dropped on a
    // save that failed would be an assertion lost for good.
    // The ids go on the wire; the SAVE TOKEN says which assertions they stand
    // for and is what the confirm is matched on. Not the array — this host
    // hands `removedMessageIds` to a payload builder, and a contract that read
    // the array's object identity would silently confirm nothing the moment it
    // did (codex round 3, finding 3).
    const { ids: removedMessageIds, saveToken } = turns.peekRemovedMessageIds();
    void saveThreadTranscript(
      buildThreadWrite({
        threadId: session.threadId,
        messages,
        createdAt: createdAtRef.current,
        activeAssistantHandle: session.assistant,
        removedMessageIds,
      }),
      // THE BROKER TRANSPORT, like every other request this surface makes. The
      // headers are built at call time from the closure-held tokens and
      // `credentials: "omit"` is load-bearing: a cookie here would write this
      // widget's turns into the conversation of whoever else is signed in on
      // this browser.
      serviceTransport,
    ).then((landed) => {
      if (landed && removedMessageIds.length > 0) turns.confirmRemovedMessageIds(saveToken);
    });
  }, [localTurnStatus, messages, serviceTransport, session.threadId, session.assistant, turns]);
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
      mentionables={mentionables}
      placeholder="Type a message..."
      promptStorageKey={`cinatra_embed_prompt_${session.threadId}`}
      submitAriaLabel="Send message"
      onAttachmentsSelected={onAttachmentsSelected}
      composerNotice={composerNotice}
      {...(autosave ? { autosave } : {})}
      {...(remoteChat ? { remoteChat } : {})}
    />
  );
}

/** `/chat`'s in-app resource activation opens a first-party route the widget
 *  frame cannot become; the affordance itself is a `/chat` thread-panel gesture
 *  that no card in this column emits. */
const NOOP_ACTIVATE_RESOURCE = () => {};
/** Prompt-window HITL gate tracking is `/chat` page state (it drives the
 *  page-level gate registry, which the widget frame does not mount). */
const NOOP_ACTIVE_GATE_CHANGE = () => {};

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
//   4. drives the turn against `/api/assistants/chat` with the §9.1 broker seams
//      (`assistant`, `authHeaders`, `credentials: "omit"`);
//   5. mirrors the renderer's apply-intent gesture (§6e) back to the parent over
//      the bridge as a signal-only uplink (§6f — the parent does the CMS check).
//
// TOKEN NON-DISCLOSURE (§6i): the `cit_`/`cwu_` tokens live ONLY in a ref closure
// — never in React state (no render/serialization exposure), never logged, never
// in the URL, never in an uplink. A neutral "waiting"/"gated"/"error" card is the
// ONLY thing shown before a valid, negotiated bootstrap — no oracle to the parent.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationTurn } from "@cinatra-ai/chat/renderer/ag-ui-interactive";
import { renderMarkdown, type ThemeName } from "@cinatra-ai/chat/renderer";
import {
  initialConversationState,
  type ConversationViewState,
} from "@cinatra-ai/chat/renderer/ag-ui-reducer";
import {
  streamAssistantTurn,
  type AssistantTurnRequestMessage,
} from "@cinatra-ai/chat/ag-ui-chat-client";
import {
  installEmbedBridge,
  type EmbedBridge,
} from "@/lib/embed/embed-bridge.client";
import type { EmbedBootstrap } from "@/lib/embed/bridge-protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { negotiateEmbedChatContract } from "./embed-chat-negotiate";

type Phase =
  | { kind: "waiting" } // pre-bootstrap: neutral "waiting for host"
  | { kind: "gated"; reason: string } // handshake fail-closed (Lane-A interlock)
  | { kind: "error" } // bootstrap rejected / turn transport failure
  | { kind: "active" }; // negotiated + mounted

export type EmbedAssistantClientProps = {
  /** Server-resolved expected parent origin (§7). Empty when unresolvable — then
   *  the bridge posts nothing and the shell shows the neutral error card. */
  expectedParentOrigin: string;
  assistant: string;
  instanceId: string;
  /** github-light | github-dark — the content-render theme passed to the S3
   *  `renderMarkdown` (shiki code theme). Prod default is github-light; the
   *  render-parity seam pins each theme so the compare exercises both goldens. */
  theme?: ThemeName;
  /** cinatra#1998 (b) — the TEST-ONLY deterministic corpus-render seam. Non-null
   *  ONLY when the server-side `EMBED_PARITY_SEAM` gate is on (resolved in
   *  page.tsx from a non-public server env, never a client/URL value), so prod is
   *  INERT. When set, the embed — AFTER reaching `active` via the REAL mount path
   *  (parent bootstrap + broker negotiation + renderer mount) — renders a seeded
   *  thread's assistant message deterministically IN PLACE OF a live LLM turn. It
   *  CANNOT bypass auth (reaching `active` still requires the real handshake) and
   *  is not user-controllable in prod (the server gate is off → this is null). */
  paritySeam?: { threadId: string } | null;
};

/** The S3 renderer's live widget detector. The render-parity corpus is
 *  widget-free by design (the reference target supplies the same empty
 *  detector), so the embed content block is byte-comparable to the reference. */
const NO_WIDGETS = (): [] => [];

/** Build a deterministic reduced conversation state whose sole assistant message
 *  IS the seeded corpus — the same content the /chat reference target seeds,
 *  rendered here through the embed's REAL mounted `ConversationTurn`. */
function seededCorpusState(content: string): ConversationViewState {
  const base = initialConversationState();
  return {
    ...base,
    message: {
      ...base.message,
      id: "parity-seed",
      content,
      parts: [{ kind: "text", content }],
    },
    status: "finished",
  };
}

export function EmbedAssistantClient(props: EmbedAssistantClientProps) {
  // An unresolvable expected parent origin (§7 'none') is an initial ERROR — a
  // render-time derivation, NOT a setState-in-effect (the origin is server-fixed
  // and never changes for the mounted page).
  const [phase, setPhase] = useState<Phase>(() =>
    props.expectedParentOrigin ? { kind: "waiting" } : { kind: "error" },
  );
  const [convo, setConvo] = useState<ConversationViewState>(() =>
    initialConversationState(),
  );

  // Tokens + session context held ONLY here (never state / log / URL / uplink).
  const bootstrapRef = useRef<EmbedBootstrap | null>(null);
  const bridgeRef = useRef<EmbedBridge | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // §9.1 broker headers derived from the closure-held tokens.
  const authHeaders = useCallback((): Record<string, string> => {
    const b = bootstrapRef.current;
    if (!b) return {};
    return {
      Authorization: `Bearer ${b.auth.citToken}`,
      "X-Cinatra-Widget-User-Token": b.auth.cwuToken,
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

  // Render assistant text through the S3 packaged renderer (`renderMarkdown`),
  // the EXACT content path `/chat` and the render-parity reference target render
  // through — so the same assistant renders IDENTICALLY here (the epic promise),
  // not as the interactive layer's plain-text safe default. `[data-embed-content]`
  // is the stable content-block hook the render-parity harness scrapes.
  const renderText = useCallback(
    (text: string) => (
      <div
        data-embed-content
        className="max-w-none leading-relaxed text-foreground"
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(text, props.theme ?? "github-light", NO_WIDGETS),
        }}
      />
    ),
    [props.theme],
  );

  // cinatra#1998 (b) TEST-ONLY seam: load a seeded thread's assistant message and
  // render it deterministically through the mounted renderer (no live LLM turn).
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
      setConvo(seededCorpusState(assistantMsg?.content ?? ""));
    } catch {
      /* best-effort + test-only: a failure leaves the mounted-but-empty active
         state, which the harness surfaces as a missing content block (loud). */
    }
  }, []);

  const runTurn = useCallback(
    async (messages: AssistantTurnRequestMessage[]) => {
      const b = bootstrapRef.current;
      if (!b) return;
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      try {
        await streamAssistantTurn({
          threadId: b.session.threadId,
          messages,
          assistant: b.session.assistant, // "wordpress" | "drupal" (§9.1)
          authHeaders, // Bearer cit_ + X-Cinatra-Widget-User-Token cwu_
          credentialsMode: "omit", // §B11 — no ambient cookie fallback
          signal: abort.signal,
          onState: (next) => setConvo(next),
        });
      } catch {
        if (!abort.signal.aborted) setPhase({ kind: "error" });
      }
    },
    [authHeaders],
  );

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
          setPhase({ kind: "active" });
          // TEST-ONLY seam (gated OFF in prod): render the seeded corpus here in
          // place of a live turn, through the same mounted renderer.
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
      abortRef.current?.abort();
      bridge.dispose();
    };
  }, [props.expectedParentOrigin, props.assistant, props.instanceId, onBootstrap]);

  // §5 resize uplink: mirror the content height to the parent so it can size the
  // panel (the parent additionally CLAMPS to its cap). Observed, not polled.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || phase.kind !== "active") return;
    const post = () => bridgeRef.current?.sendResize(Math.ceil(el.scrollHeight));
    post();
    const ro = new ResizeObserver(post);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase.kind, convo]);

  // §6e apply-intent gesture → signal-only uplink (§6f: the PARENT does the CMS
  // permission check + in-place draft refresh; the iframe asserts nothing).
  const onApplyIntent = useCallback(
    (ref:
      | { proposalId: string; viewType: "content_change_proposal" }
      | { changeSetId: string; viewType: "content_change_proposal" }) => {
      bridgeRef.current?.sendApplyIntent(ref);
    },
    [],
  );

  return (
    // `data-turn-status` mirrors the reduced conversation status (idle → running
    // → finished/error) so an out-of-process observer (the wp-drupal-uat E2E) can
    // fence deterministically on a CLIENT-CONSUMED `RUN_FINISHED` (status ===
    // "finished") rather than a mid-stream signal like a completed tool chip. It
    // is a passive test-observability attribute only — it drives no behaviour and
    // is not part of the render-parity content contract (cinatra#1998 (c)).
    <div ref={containerRef} data-embed-assistant data-phase={phase.kind} data-turn-status={convo.status}>
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
      {phase.kind === "active" && (
        <div className="p-4" data-embed-state="active">
          <ConversationTurn state={convo} renderers={{ onApplyIntent, renderText }} />
          <EmbedComposer onSend={(text) => void runTurn([{ role: "user", content: text }])} />
        </div>
      )}
    </div>
  );
}

/** Minimal composer — the embed's own input (the CMS widget holds no chat UI).
 *
 * SANDBOX CONSTRAINT (why NOT a <form> submit): this embed renders INSIDE the CMS
 * widget's `sandbox="allow-scripts allow-same-origin"` iframe (wordpress-plugin /
 * drupal-module #1221), which deliberately grants NO `allow-forms`. Under that
 * sandbox a native form submission — pressing Enter in the field OR clicking a
 * `type="submit"` button — is BLOCKED by the browser and its `submit` event never
 * fires ("Blocked form submission … the 'allow-forms' permission is not set"), so
 * a `<form onSubmit>` composer could type but never start a turn. Drive the send
 * purely from JS instead: an explicit `type="button"` onClick plus an Enter
 * keydown, inside a plain <div> so nothing depends on form submission being
 * permitted. Behaves identically outside the sandbox. */
function EmbedComposer({ onSend }: { onSend: (text: string) => void }) {
  const [value, setValue] = useState("");
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    setValue("");
    onSend(text);
  };
  return (
    <div className="mt-3 flex gap-2">
      <Input
        className="flex-1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is reserved (a no-op on this single-line
          // input). Ignore the Enter that COMMITS an IME candidate: most engines
          // set `isComposing`, but WebKit fires that Enter with isComposing=false
          // and keyCode 229 (WebKit bug 165004), so guard on BOTH signals.
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            e.nativeEvent.keyCode !== 229
          ) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Ask the assistant…"
        aria-label="Message"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-embed-composer-submit
        onClick={submit}
      >
        Send
      </Button>
    </div>
  );
}

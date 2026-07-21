"use client";

// ---------------------------------------------------------------------------
// S5 (cinatra#1221) Lane B §2/§8/§9 — the embed page CLIENT component.
//
// The SOLE AG-UI session owner (the CMS widget holds no chat client — only the
// launcher/panel chrome + the bridge peer). It:
//   1. installs the iframe-side bridge and posts READY (§3a);
//   2. accepts the ONE inbound BOOTSTRAP (origin + source-window + schema + nonce
//      + assistant/instance agreement, all in `embed-bridge.client` / §4-6);
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
};

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
    };
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
          const negotiation = await negotiateEmbedChatContract(authHeaders);
          if (!negotiation.ok) {
            setPhase({ kind: "gated", reason: negotiation.reason });
            return;
          }
          setPhase({ kind: "active" });
        } catch {
          setPhase({ kind: "gated", reason: "handshake_failed" });
        }
      })();
    },
    [authHeaders],
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
    <div ref={containerRef} data-embed-assistant data-phase={phase.kind}>
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
          <ConversationTurn state={convo} renderers={{ onApplyIntent }} />
          <EmbedComposer onSend={(text) => void runTurn([{ role: "user", content: text }])} />
        </div>
      )}
    </div>
  );
}

/** Minimal composer — the embed's own input (the CMS widget holds no chat UI). */
function EmbedComposer({ onSend }: { onSend: (text: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="mt-3 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const text = value.trim();
        if (!text) return;
        setValue("");
        onSend(text);
      }}
    >
      <Input
        className="flex-1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Ask the assistant…"
        aria-label="Message"
      />
      <Button type="submit" variant="outline" size="sm">
        Send
      </Button>
    </form>
  );
}

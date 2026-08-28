"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PromptField, type PromptFieldHandle } from "@cinatra-ai/sdk-ui";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";

import type { RunWindowSurface } from "./run-window-conversation-store";
import { renderRunWindowMarkdown } from "./run-window-markdown";

/**
 * ONE WINDOW, FIVE READINGS — the sentence in the empty field, per surface
 * (design `458fb7ffce6c`, `app-artifact-review.html` §X).
 *
 * §X, in its own words: "These are five readings of one window, never five
 * windows … One thing is read per surface — the sentence in the empty field,
 * which names what the window does where it stands. Nothing else about the
 * window changes from one reading to the next."
 *
 * WHY THE MAP AND NOT A PROP EACH MOUNT FILLS IN. The five sentences are the
 * drawing's, character for character, and they belong together where they can
 * be read against it. A mount declares WHICH READING it is — the surface it
 * already declares to the one controller — and never a wording of its own, so
 * no window can drift from the drawing on its own, and a sixth surface cannot
 * compile without a sentence for it.
 */
export const RUN_WINDOW_PLACEHOLDERS: Record<RunWindowSurface, string> = {
  /** The run page — a step waiting for its fields. */
  "run-page": "Ask Cinatra to fill the fields above, or ask about this step…",
  /** The step-by-step screen — one step of a multi-step run. */
  "step-by-step": "Ask Cinatra to fill this step's fields, or ask about the run…",
  /** The schedule screen — the scheduler form, in both of its states. */
  schedule: "Ask Cinatra to set the schedule above, or ask about it…",
  /** The armed-trigger tab — the run's schedule as it stands. */
  "armed-trigger": "Ask Cinatra to change this schedule, or ask about it…",
  /** The review page — under the decision bar. */
  review: "Ask Cinatra about this review, or ask for changes to the work…",
};

/**
 * WHERE THE WINDOW STANDS, per surface (design `458fb7ffce6c`,
 * `app-artifact-review.html` §VI and §IX).
 *
 * §VI, in its own words: "BENEATH THE DECISION BAR the run detail carries a
 * conversational prompt window" — the drawing shows the card with its decision
 * bar and the window as two separately stacked examples, one after the other.
 * A window that floats over the bar is therefore not a second reading of the
 * drawing; it is a different drawing. On the review page the window sits in the
 * document flow, after the card, and nothing overlaps.
 *
 * The four windows that sit UNDER A FORM the person is filling keep the floating
 * reading they were drawn with: there the window follows the person down a long
 * form so the field they are typing into and the box they are typing in stay on
 * screen together (§IX, "the decision bar and prompt window stay reachable at
 * the foot of the run detail at every width"). The review page has no form to
 * follow — it has a decision bar the window may not cover.
 *
 * IT IS A MAP FOR THE SAME REASON THE SENTENCES ARE. A mount declares WHICH
 * READING it is and never a placement of its own, so no window can drift from
 * the drawing on its own and a sixth surface cannot compile without a placement.
 */
export const RUN_WINDOW_PLACEMENTS: Record<RunWindowSurface, "floating" | "in-flow"> = {
  "run-page": "floating",
  "step-by-step": "floating",
  schedule: "floating",
  "armed-trigger": "floating",
  /** §VI — beneath the decision bar, in the flow, never over it. */
  review: "in-flow",
};

/**
 * The send control's ACCESSIBLE NAME, per surface.
 *
 * It carries the window's own sentence rather than a name borrowed from another
 * surface: a reader on a screen reader hears what this window does where it
 * stands, which is the same thing the empty field says to everyone else. It is
 * DERIVED from that sentence, so the two cannot drift and a sixth surface gets
 * a name the moment it gets a sentence.
 */
export function runWindowSendLabel(surface: RunWindowSurface): string {
  const sentence = RUN_WINDOW_PLACEHOLDERS[surface].replace(/…$/u, "");
  return `Send — ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

export type HitlConversationEntry = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

export type HitlConversationPanelProps = {
  /** Stable element to portal into (parent computes via document.querySelector("main")). */
  portalTarget: HTMLElement | null;
  /** Visibility gate set by the parent. */
  visible: boolean;
  /** Conversation entries owned by parent. */
  conversation: HitlConversationEntry[];
  /** True while the LLM request is in flight; renders the Thinking dot. */
  promptPending: boolean;
  /** Storage key for PromptField persistence (template + xRenderer scoped). */
  storageKey: string;
  /**
   * WHICH READING OF THE ONE WINDOW THIS IS (design `458fb7ffce6c`,
   * `app-artifact-review.html` §X).
   *
   * The window takes its sentence from the surface it is mounted on. The mount
   * names the surface — the same one it opens the run's conversation with —
   * and the panel reads the drawing's sentence for it out of
   * {@link RUN_WINDOW_PLACEHOLDERS}. Nothing else about the window changes
   * from one reading to the next.
   */
  surface: RunWindowSurface;
  /** Async submit callback — parent drives the fetch + conversation
   *  update. The optional second argument carries pending paperclip
   *  attachments uploaded inside the panel; back-compat-by-default
   *  (existing callers that omit the parameter keep their byte-identical
   *  behavior, and pendingAttachments is only populated when
   *  `enableAttachments` is true). */
  onSubmit: (
    prompt: string,
    attachments?: LlmAttachmentRef[],
  ) => Promise<void>;
  /** Opt-in: show the paperclip in this panel and run the
   *  chat-page-equivalent upload pipeline
   *  (POST /api/artifacts/upload + enriched filename/title/size). When
   *  undefined / false the paperclip is hidden and onSubmit is called
   *  with a single arg — byte-identical legacy behavior for callers
   *  that have not yet opted into HITL attachments. */
  enableAttachments?: boolean;
  /**
   * When this signal value changes (parent passes `currentXRenderer`), the panel
   * resets `convOpen` to false (closes the conversation overlay). Pass undefined
   * if the consumer does not need the reset.
   */
  resetSignal?: unknown;
};

/**
 * The panel owns interactions (open/close, scroll, focus, portal mount);
 * the parent retains the conversation array, promptPending flag, and fetch
 * logic.
 */
export function HitlConversationPanel({
  portalTarget,
  visible,
  conversation,
  promptPending,
  storageKey,
  surface,
  onSubmit,
  resetSignal,
  enableAttachments,
}: HitlConversationPanelProps) {
  // §X's one difference between the five readings, resolved here rather than at
  // any mount: the sentence in the empty field.
  const placeholder = RUN_WINDOW_PLACEHOLDERS[surface];
  // §VI's own placement for this reading, resolved here rather than at any
  // mount, exactly as the sentence is.
  const placement = RUN_WINDOW_PLACEMENTS[surface];
  const inFlow = placement === "in-flow";
  // The window's own sentence, as the send control's accessible name.
  const submitLabel = runWindowSendLabel(surface);
  const [convOpen, setConvOpen] = useState(false);
  const convContainerRef = useRef<HTMLDivElement>(null);
  const convScrollRef = useRef<HTMLDivElement>(null);
  const promptFieldRef = useRef<PromptFieldHandle>(null);

  // Auto-open when the parent appends an entry.
  useEffect(() => {
    if (conversation.length > 0) setConvOpen(true);
  }, [conversation.length]);

  // When the parent's `resetSignal` changes (e.g. the active xRenderer
  // transitions between HITL gates), close the conversation overlay so the
  // next gate starts fresh. Skipped on initial mount because `convOpen` is
  // already false (prevResetSignalRef is seeded with the initial signal value).
  const prevResetSignalRef = useRef<unknown>(resetSignal);
  useEffect(() => {
    if (prevResetSignalRef.current !== resetSignal) {
      prevResetSignalRef.current = resetSignal;
      setConvOpen(false);
    }
  }, [resetSignal]);

  // Close conversation panel when clicking outside the prompt+conv container.
  useEffect(() => {
    if (!convOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        convContainerRef.current &&
        !convContainerRef.current.contains(e.target as Node)
      ) {
        setConvOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [convOpen]);

  // Auto-scroll to bottom on new entry / pending toggle.
  useEffect(() => {
    if (convScrollRef.current) {
      convScrollRef.current.scrollTop = convScrollRef.current.scrollHeight;
    }
  }, [conversation, promptPending]);

  const handleFocus = useCallback(() => {
    if (conversation.length > 0) setConvOpen(true);
  }, [conversation.length]);

  // Paperclip-uploaded attachments pending inclusion on the NEXT submit;
  // cleared after the parent accepts them (mirrors chat-page behavior).
  const [pendingAttachments, setPendingAttachments] = useState<
    LlmAttachmentRef[]
  >([]);
  const handleAttachmentsSelected = useCallback(async (files: File[]) => {
    const refs: LlmAttachmentRef[] = [];
    for (const file of files) {
      try {
        const r = await fetch("/api/artifacts/upload", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Artifact-Filename": file.name,
            "X-Artifact-Title": file.name,
          },
          body: file,
        });
        const j = (await r.json().catch(() => null)) as
          | { ok?: boolean; ref?: LlmAttachmentRef }
          | null;
        if (r.ok && j?.ok && j.ref) {
          // Enrich the bare ArtifactRef ({artifactId,
          // representationRevisionId, digest, mime, originKind}) with
          // the original File metadata so the downstream provider
          // upload can pass a real filename to OpenAI/Anthropic/Gemini
          // Files-API (otherwise it falls back to artifactId UUID and
          // loses the file extension). Same enrichment chat-page does
          // at packages/chat/src/chat-page.tsx:1789-1794.
          refs.push({
            ...j.ref,
            filename: file.name,
            title: file.name,
            size: file.size,
          });
        }
      } catch {
        // Network/parse failures are swallowed; the user can retry the
        // file (the chat-page pattern is identical here).
      }
    }
    if (refs.length > 0) {
      setPendingAttachments((prev) => [...prev, ...refs]);
    }
  }, []);

  const handleSubmit = useCallback(
    async (prompt: string) => {
      promptFieldRef.current?.clear();
      setConvOpen(true);
      // Consume + clear pending attachments atomically around the parent call
      // so a re-render between consume and clear cannot double-submit or lose
      // the refs (the same "snapshot then clear" sequencing chat-page uses).
      const attachmentsForThisSubmit = pendingAttachments;
      if (attachmentsForThisSubmit.length > 0) {
        setPendingAttachments([]);
      }
      // True byte-identical legacy when there are no pending
       // attachments: invoke onSubmit with EXACTLY one argument
      // (matters for callers/tests that use `arguments.length` /
      // strict toHaveBeenCalledWith(prompt)).
      if (attachmentsForThisSubmit.length > 0) {
        await onSubmit(prompt, attachmentsForThisSubmit);
      } else {
        await onSubmit(prompt);
      }
    },
    [onSubmit, pendingAttachments],
  );

  if (!visible || !portalTarget) return null;

  return createPortal(
    <div
      data-conv-open={convOpen}
      data-run-window-placement={placement}
      // IN FLOW IS PLAIN STATIC FLOW — no `sticky`, no `bottom`, no stacking
      // context. An element that is not taken out of flow and comes after the
      // card in document order cannot draw over it at any width, which is the
      // whole of §VI's "beneath the decision bar".
      className={
        inFlow ? "px-5 pb-4 pt-6" : "sticky bottom-0 z-30 px-5 pb-4 pt-6"
      }
      // The fade exists so a FLOATING window has content passing under it. A
      // window standing in the flow has nothing behind it to fade.
      style={
        inFlow
          ? undefined
          : {
              background:
                "linear-gradient(to bottom, transparent 0%, color-mix(in srgb, var(--background) 85%, transparent) 30%, var(--background) 55%)",
            }
      }
    >
      <div ref={convContainerRef} className="mx-auto max-w-3xl">
        {(conversation.length > 0 || promptPending) && convOpen && (
          <div className="mb-3 rounded-panel border border-line bg-surface p-3 shadow-sm">
            <div
              ref={convScrollRef}
              data-run-window-scroll
              className="flex max-h-52 flex-col gap-2 overflow-y-auto"
            >
              {conversation.map((entry) => (
                <div
                  key={entry.id}
                  className={`flex ${entry.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {entry.role === "user" ? (
                    /*
                     * THE PERSON'S OWN LINE STAYS THEIR OWN CHARACTERS. What
                     * they typed is not markup and is never read as any: a
                     * message that says `**not bold**` is shown with its
                     * asterisks, because the window is quoting them back.
                     */
                    <div
                      data-run-window-entry="person"
                      className="rounded-control px-3 py-2 text-sm max-w-[80%] whitespace-pre-wrap bg-primary text-primary-foreground"
                    >
                      {entry.content}
                    </div>
                  ) : (
                    /*
                     * THE ASSISTANT'S LINE IS DRAWN, NOT PRINTED (cinatra#2934).
                     * It is the same assistant /chat draws, through the same
                     * renderer — bold reads bold, a list reads as a list, a
                     * pipe table reads as a table. The markup is the shared
                     * core's, which escapes every value it writes and
                     * scheme-allowlists every URL, so untrusted model text
                     * cannot reach the DOM as live markup here either.
                     */
                    <div
                      data-run-window-entry="assistant"
                      className="rounded-control px-3 py-2 text-sm max-w-[80%] bg-surface-muted text-foreground [&>:first-child]:mt-0 [&>:last-child]:mb-0"
                      dangerouslySetInnerHTML={{
                        __html: renderRunWindowMarkdown(entry.content),
                      }}
                    />
                  )}
                </div>
              ))}
              {promptPending && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-1.5 px-1 animate-pulse text-muted-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    <span className="text-sm">Thinking…</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        <div onFocus={handleFocus} onClick={handleFocus}>
          <PromptField
            ref={promptFieldRef}
            placeholder={placeholder}
            rows={1}
            storageKey={storageKey}
            onSubmit={handleSubmit}
            submitAriaLabel={submitLabel}
            canSubmitEmpty={false}
            pending={promptPending}
            fieldClassName="border-line shadow-lg"
            // Paperclip surfaces only when the caller opts in via
            // `enableAttachments`. PromptField shows the paperclip iff
            // `onAttachmentsSelected` is defined; an undefined prop =
            // no paperclip = byte-identical legacy.
            onAttachmentsSelected={
              enableAttachments ? handleAttachmentsSelected : undefined
            }
          />
        </div>
      </div>
    </div>,
    portalTarget,
  );
}

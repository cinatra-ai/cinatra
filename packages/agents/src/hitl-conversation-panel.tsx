"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PromptField, type PromptFieldHandle } from "@cinatra-ai/sdk-ui";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";

import type { RunWindowSurface } from "./run-window-conversation-store";

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

export type HitlConversationEntry = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

export type HitlConversationPanelProps = {
  /**
   * Stable element to portal into — the mount the HOST renders where the
   * drawing puts the window, under the work it belongs to (cinatra#3188 item
   * 3). A host that hands over the page frame instead puts the window at the
   * END of the page rather than under anything in particular, which is the one
   * thing this prop must not be used for.
   */
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

  // THE WINDOW STANDS UNDER THE WORK, IT DOES NOT DOCK (cinatra#3188 item 3).
  // The ratified drawing puts it "below the scheduler, in the same column", and
  // has the gate's "decision bar and the run's prompt window ... fill the run
  // detail on the right" — a window fixed across the foot of the frame is
  // neither. So the dock goes (`sticky bottom-0 z-30`), and with it the fade
  // that existed only to soften the page passing UNDER a floating window;
  // nothing passes under it now. The inset it keeps is the window's own
  // breathing room inside the column it stands in.
  return createPortal(
    <div data-conv-open={convOpen} className="px-5 pb-4 pt-6">
      <div ref={convContainerRef} className="mx-auto max-w-3xl">
        {(conversation.length > 0 || promptPending) && convOpen && (
          <div className="mb-3 rounded-panel border border-line bg-surface p-3 shadow-sm">
            <div ref={convScrollRef} className="flex max-h-52 flex-col gap-2 overflow-y-auto">
              {conversation.map((entry) => (
                <div
                  key={entry.id}
                  className={`flex ${entry.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`rounded-control px-3 py-2 text-sm max-w-[80%] whitespace-pre-wrap ${
                      entry.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-surface-muted text-foreground"
                    }`}
                  >
                    {entry.content}
                  </div>
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
            submitAriaLabel="Apply AI suggestion"
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

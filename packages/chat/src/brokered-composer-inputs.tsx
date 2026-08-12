"use client";

// ---------------------------------------------------------------------------
// THE composer inputs a BROKERED host supplies (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// The shared composer's rows are PROP-GATED: an upload row appears when a
// handler exists, the @-mention flyout when a participant list exists, the
// Skill-autosave row when a setting exists, and the prompt-options flyout when
// any of them do. That gate is the column's own and is identical on both
// surfaces — which is why the first half of S8f could not draw those rows on the
// widget. It had nothing to put in them, because every source was a cookie
// request the embed frame must never make.
//
// This hook is those sources, resolved with a BROKER transport. It lives in the
// shared package rather than in the embed route for the reason the column itself
// does: a second brokered host would otherwise re-derive them, and the two would
// drift. The embed calls it; the two-surface parity harness calls it; there is
// one composition to be right or wrong about.
//
// IT RESOLVES INPUTS AND NOTHING ELSE. It renders no conversation UI, mounts no
// list and no composer, and decides nothing: every answer comes from a route
// whose widget branch authorizes the reader's live standing and runs the same
// per-row check the first-party branch runs. What the column then does with the
// inputs is the column's, identically on both surfaces.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Mentionable, PromptFieldAutosave } from "@cinatra-ai/sdk-ui/prompt-field";
import type { UiMessage } from "./types";
import { useChatAttachments } from "./use-chat-attachments";
import {
  fetchChatCaptureConfig,
  fetchMentionables,
  patchChatCaptureConfig,
  type ConversationServiceTransport,
} from "./conversation-services";

/** The list before the directory answers. Not a reduction: the shared composer
 *  draws no flyout for an empty list on either surface. */
const NO_MENTIONABLES: Mentionable[] = [];

export type BrokeredComposerInputs = {
  /** Item 4 — the reader's own directory, tenant-scoped by the server. */
  mentionables: Mentionable[];
  /** Item 2 — the upload handler whose PRESENCE draws the upload row. */
  onAttachmentsSelected: (files: File[]) => void | Promise<void>;
  /** Item 2 — the per-file refusal notice, rendered above the composer. */
  composerNotice: ReactNode;
  /** Item 2 — the uploaded-but-unsent files, taken by the turn engine at submit. */
  takePendingAttachments: () => UiMessage["attachments"];
  /** Item 3 — the Skill-autosave row, or undefined while the server says the
   *  reader may neither see nor change it. */
  autosave: PromptFieldAutosave | undefined;
};

export function useBrokeredComposerInputs(input: {
  /** The thread an upload is captured against (classifier context only). */
  threadId: string;
  /** How this surface proves who is asking. */
  transport: ConversationServiceTransport;
}): BrokeredComposerInputs {
  const { threadId, transport } = input;

  // ITEM 2 — attachments. The SAME hook `/chat` runs, with the transport: the
  // same upload, the same per-file refusal notice, the same pending buffer that
  // rides the next turn.
  //
  // The thread handle is passed as a `{current}` BOX rather than a React ref
  // (`useRef` + assignment during render is a render side effect the lint rule
  // correctly refuses). `useChatAttachments` only ever READS `.current`, at
  // upload time — which is what the box is for: the handler has a stable
  // identity and still sees the thread this render is for.
  const threadIdBox = useMemo<{ current: string | null }>(
    () => ({ current: threadId }),
    [threadId],
  );
  const {
    pendingAttachments,
    clearPendingAttachments,
    handleAttachmentsSelected,
    refusalNotice,
  } = useChatAttachments(threadIdBox, transport);
  // Read the buffer at SUBMIT and clear it in the same breath, so a file rides
  // exactly one turn. The mirror is written in an EFFECT, so nothing is mutated
  // during render; the only reader is a user gesture, which cannot run before
  // the commit that filled it.
  const pendingRef = useRef(pendingAttachments);
  useEffect(() => {
    pendingRef.current = pendingAttachments;
  }, [pendingAttachments]);
  const takePendingAttachments = useCallback(() => {
    const taken = pendingRef.current;
    if (taken.length > 0) clearPendingAttachments();
    return taken;
  }, [clearPendingAttachments]);

  // ITEM 4 — the @-mention list, from the SAME directory reader `/chat` uses.
  const [mentionables, setMentionables] = useState<Mentionable[]>(NO_MENTIONABLES);
  useEffect(() => {
    let cancelled = false;
    void fetchMentionables(transport).then((list) => {
      if (!cancelled) setMentionables(list);
    });
    return () => {
      cancelled = true;
    };
  }, [transport]);

  // ITEM 3 — the Skill-autosave row. The SAME account setting, read and written
  // through the SAME handler and the SAME authorization check, so a reader may
  // change here exactly what they may change in the app — and is refused here
  // exactly where they are refused there.
  const [autosaveEnabled, setAutosaveEnabled] = useState(false);
  const [autosaveVisible, setAutosaveVisible] = useState(false);
  const [autosaveCanToggle, setAutosaveCanToggle] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetchChatCaptureConfig(transport).then((config) => {
      if (cancelled || !config) return;
      setAutosaveEnabled(config.enabled);
      setAutosaveCanToggle(config.userCanConfigure);
      setAutosaveVisible(config.userCanSeeIndicator || config.userCanConfigure);
    });
    return () => {
      cancelled = true;
    };
  }, [transport]);
  const autosave = useMemo<PromptFieldAutosave | undefined>(
    () =>
      autosaveVisible
        ? {
            enabled: autosaveEnabled,
            canToggle: autosaveCanToggle,
            onToggle: (enabled: boolean) => {
              setAutosaveEnabled(enabled);
              void patchChatCaptureConfig(enabled, transport);
            },
          }
        : undefined,
    [autosaveVisible, autosaveEnabled, autosaveCanToggle, transport],
  );

  return {
    mentionables,
    onAttachmentsSelected: handleAttachmentsSelected,
    composerNotice: refusalNotice,
    takePendingAttachments,
    autosave,
  };
}

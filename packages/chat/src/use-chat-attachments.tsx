import { useCallback, useState, type RefObject } from "react";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";
import { uploadChatAttachments, type ChatAttachmentRefusal } from "./ag-ui-chat-client";
import { ChatAttachmentRefusalNotice } from "./chat-attachment-refusal-notice";
import type { ConversationServiceTransport } from "./conversation-services";

// Owns the paperclip upload concern (cinatra#1218) plus the cinatra#1890
// visible-refusal surface, keeping ChatPage under its file-size ratchet. The
// active thread id is read from a ref at upload time (state would be stale in a
// []-dep handler) so the server can capture chat context into the upload's
// classifier signals, and refused uploads are surfaced instead of swallowed.
//
// cinatra#2683 (epic #2564 S8f) gave it the TRANSPORT seam, and that is the only
// change: the widget's composer draws the same upload row and refuses files the
// same way, because it runs this hook with broker headers instead of a cookie.
// One upload path, one refusal surface, one place to change either.
export function useChatAttachments(
  activeThreadIdRef: RefObject<string | null>,
  /** Absent ⇒ the first-party cookie upload, byte-identical to before. */
  transport?: ConversationServiceTransport,
) {
  const [pendingAttachments, setPendingAttachments] = useState<LlmAttachmentRef[]>([]);
  const [attachmentRefusals, setAttachmentRefusals] = useState<ChatAttachmentRefusal[]>([]);
  const handleAttachmentsSelected = useCallback(
    async (files: File[]) => {
      const threadId = activeThreadIdRef.current ?? undefined;
      const { refs, refusals } = await uploadChatAttachments(files, {
        threadId,
        ...(transport
          ? {
              authHeaders: transport.authHeaders,
              credentialsMode: transport.credentialsMode,
            }
          : {}),
      });
      if (refs.length > 0) setPendingAttachments((prev) => [...prev, ...refs]);
      if (refusals.length > 0) setAttachmentRefusals((prev) => [...prev, ...refusals]);
    },
    [activeThreadIdRef, transport],
  );
  const clearPendingAttachments = useCallback(() => setPendingAttachments([]), []);
  const refusalNotice = (
    <ChatAttachmentRefusalNotice
      refusals={attachmentRefusals}
      onDismiss={() => setAttachmentRefusals([])}
    />
  );
  return { pendingAttachments, clearPendingAttachments, handleAttachmentsSelected, refusalNotice };
}

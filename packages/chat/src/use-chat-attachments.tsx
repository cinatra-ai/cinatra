import { useCallback, useState, type RefObject } from "react";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";
import { uploadChatAttachments, type ChatAttachmentRefusal } from "./ag-ui-chat-client";
import { ChatAttachmentRefusalNotice } from "./chat-attachment-refusal-notice";

// Owns the /chat paperclip upload concern (cinatra#1218) plus the cinatra#1890
// visible-refusal surface, keeping ChatPage under its file-size ratchet. The
// active thread id is read from a ref at upload time (state would be stale in a
// []-dep handler) so the server can capture chat context into the upload's
// classifier signals, and refused uploads are surfaced instead of swallowed.
export function useChatAttachments(activeThreadIdRef: RefObject<string | null>) {
  const [pendingAttachments, setPendingAttachments] = useState<LlmAttachmentRef[]>([]);
  const [attachmentRefusals, setAttachmentRefusals] = useState<ChatAttachmentRefusal[]>([]);
  const handleAttachmentsSelected = useCallback(
    async (files: File[]) => {
      const threadId = activeThreadIdRef.current ?? undefined;
      const { refs, refusals } = await uploadChatAttachments(files, { threadId });
      if (refs.length > 0) setPendingAttachments((prev) => [...prev, ...refs]);
      if (refusals.length > 0) setAttachmentRefusals((prev) => [...prev, ...refusals]);
    },
    [activeThreadIdRef],
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

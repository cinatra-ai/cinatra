"use client";

import { useMemo, useRef } from "react";
import { AgenticRunPanel, ensureDefaultFieldRenderersRegistered } from "@cinatra-ai/agents/client-entry";
import { RunPageChrome } from "@cinatra-ai/agents/run-page-chrome";
import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { ReviewGateCard } from "@cinatra-ai/agents/review-gate-card";
import { ConversationColumn, CHAT_THREAD_HOST } from "@cinatra-ai/chat/conversation-column";
import { createChatWidgetRuntime } from "../../../../packages/chat/src/widget-runtime";
import type { PromptFieldHandle } from "@cinatra-ai/sdk-ui/prompt-field";
import type { WidgetSubmitHandle } from "@cinatra-ai/sdk-ui/widget";
import {
  OWNERSHIP_INPUT, OWNERSHIP_REVIEW_VIEW, OWNERSHIP_RUN_ID,
  type RunWindowOwnershipHost,
} from "./run-window-ownership-fixture-data";

// Only the existing required conformance query mounts this family. Each host
// composes the shipped components and supplies read data through the ordinary
// resolve/read ports; the test driver refuses server actions and never sends.
function ChatOwnershipFixture() {
  const runtime = useMemo(() => createChatWidgetRuntime([], []), []);
  const promptRef = useRef<PromptFieldHandle | null>(null);
  const widgetSubmitRef = useRef<WidgetSubmitHandle | null>(null);
  return <ConversationColumn
    host={CHAT_THREAD_HOST}
    messages={[{ id: "ownership-turn", role: "assistant", content: "",
      dataParts: [OWNERSHIP_REVIEW_VIEW] }]}
    isSlackMode={false} animating={false} theme="github-light"
    activeThreadId="ownership-thread" assistantHandleMap={new Map()}
    taggedAssistantUserIds={[]} mentionables={[]} pausedParticipants={[]}
    onTogglePause={() => {}} requestEditMessageId={null}
    onRequestEditMessage={() => {}} onEditStarted={() => {}}
    streamingCount={0} isStreaming={() => false} onEditAndResend={() => {}}
    onActivateResource={() => {}} widgetRuntime={runtime} widgetSubmitRef={widgetSubmitRef}
    widgetRefreshKey={0} onActiveGateChange={() => {}} pendingExternalHandle={null}
    typingIndicators={new Map()} chatViews={{}} promptRef={promptRef}
    placeholder="Type a message..." promptStorageKey="conformance-window-chat"
    onSubmit={() => { throw new Error("This ownership reading never sends a turn"); }}
    submitAriaLabel="Send message" onStop={() => {}}
  />;
}
export function RunWindowOwnershipFixture({ host }: { host: RunWindowOwnershipHost }) {
  ensureDefaultFieldRenderersRegistered();
  return <section data-run-window-ownership-host={host} className="mx-auto w-full max-w-3xl">
    {host === "chat" ? <ChatOwnershipFixture /> :
      <RunPageChrome>
        {host === "run" ? <AgenticRunPanel
          runId={OWNERSHIP_RUN_ID} initialStatus="pending_approval"
          initialError={null} initialMessages={[]} agUiEnabled={false}
          initialHitlContext={OWNERSHIP_INPUT}
          templateId="conformance-window-template" canRespondInWindow
        /> : <LifecycleCardSurfaceProvider host="page_gate_region">
          <ReviewGateCard view={OWNERSHIP_REVIEW_VIEW} runId={OWNERSHIP_RUN_ID} />
        </LifecycleCardSurfaceProvider>}
      </RunPageChrome>}
  </section>;
}

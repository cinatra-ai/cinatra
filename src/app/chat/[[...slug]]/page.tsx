import type { Metadata } from "next";
import { requireAuthSession } from "@/lib/auth-session";
import { resolveChatWidgetCatalog } from "@/lib/chat-widget-catalog.server";
// Narrow subpath import (not the @cinatra-ai/chat barrel): the barrel also
// re-exports the thread/history/side panels this page never renders, and the
// /chat route-graph ratchet counts every module the entry can reach. The
// panels stay exported from the barrel for the chat layout + other consumers.
import { ChatPage } from "@cinatra-ai/chat/chat-page";

export const metadata: Metadata = { title: "Chat" };

export default async function ChatPageMount({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The widget catalog is resolved per request from the generated extension
  // manifest + extension lifecycle — installing/archiving a widget-bearing
  // extension is reflected on the next chat page load with no host edit.
  // Component values are React client references, serialized to the client
  // ChatPage through props.
  const [{ slug }, session, rawSp, widgetCatalog] = await Promise.all([
    params,
    requireAuthSession(),
    searchParams ?? Promise.resolve({}),
    resolveChatWidgetCatalog(),
  ]);
  const sp = rawSp as Record<string, string | string[] | undefined>;
  const threadId = slug?.[0];
  const mention = typeof sp.mention === "string" ? sp.mention : undefined;
  const mode = typeof sp.mode === "string" ? sp.mode : undefined;
  // Workflow-task handoff via the /chat?wf=<id>&task=<key> deep link →
  // a concise prompt the user can complete.
  const wf = typeof sp.wf === "string" ? sp.wf : undefined;
  const task = typeof sp.task === "string" ? sp.task : undefined;
  const initialPrompt = wf
    ? `Regarding workflow ${wf}${task ? `, task "${task}"` : ""}: `
    : undefined;
  return (
    <ChatPage
      initialThreadId={threadId}
      userId={session.user.id}
      initialMention={mention}
      initialMode={
        mode === "create-agent"
          ? "create-agent"
          : mode === "create-workflow"
            ? "create-workflow"
            : undefined
      }
      initialPrompt={initialPrompt}
      widgets={widgetCatalog.widgets}
      widgetManifests={widgetCatalog.manifests}
    />
  );
}

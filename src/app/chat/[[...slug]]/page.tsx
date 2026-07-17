import type { Metadata } from "next";
import { requireAuthSession } from "@/lib/auth-session";
import { resolveChatWidgetCatalog } from "@/lib/chat-widget-catalog.server";
import { resolveChatViewCatalog } from "@/lib/chat-views-catalog.server";
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
  // The chat renderable-view catalog (viewType → extension component, e.g. the
  // migrated `chart` view) is resolved per request from the generated
  // `cinatra.views` map + extension lifecycle, exactly like the widget catalog —
  // installing/archiving a view-bearing extension is reflected on the next chat
  // page load with no host edit. Component values are React client references,
  // serialized to the client ChatPage through props.
  const [{ slug }, session, rawSp, widgetCatalog, viewCatalog] = await Promise.all([
    params,
    requireAuthSession(),
    searchParams ?? Promise.resolve({}),
    resolveChatWidgetCatalog(),
    resolveChatViewCatalog(),
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
  // The unified-stream cutover flag (cinatra#1218, epic #1216 S2). Default:
  // the AG-UI wire — this PR IS the cutover; the retained bespoke wire is the
  // kill-switch (`CHAT_STREAM_WIRE=legacy`) until the parity-gated legacy
  // deletes land in the follow-up stage. Resolved server-side so the client
  // bundle carries no env coupling.
  const streamWire: "ag-ui" | "legacy" =
    process.env.CHAT_STREAM_WIRE === "legacy" ? "legacy" : "ag-ui";
  return (
    <ChatPage
      initialThreadId={threadId}
      userId={session.user.id}
      streamWire={streamWire}
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
      chatViews={viewCatalog}
    />
  );
}

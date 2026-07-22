import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireAuthSession } from "@/lib/auth-session";
import { resolveChatWidgetCatalog } from "@/lib/chat-widget-catalog.server";
import { resolveChatViewCatalog } from "@/lib/chat-views-catalog.server";
// The /chat route guard (cinatra#1878 W3): resolves `/chat/<vendor>/<slug>…`
// through the actor's audience-filtered registry + per-instance authority, and
// turns an unknown/out-of-audience assistant, a bad instance, or a missing
// thread into a 404 (a bare /chat into a redirect).
import { resolveChatRouteForCurrentActor } from "@/lib/chat-route-resolver";
import { resolveRemoteChatForBoundRoute } from "@/lib/assistants-directory.server";
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

  // Resolve + guard the route (cinatra#1878 W3): bare /chat redirects to the
  // canonical default; an unknown/out-of-audience assistant, an unauthorized
  // instance, or a missing thread is a 404-hide.
  const resolution = await resolveChatRouteForCurrentActor(slug);
  if (resolution.kind === "redirect") redirect(resolution.to);
  if (resolution.kind !== "resolved") notFound();
  const { route, assistant, threadId } = resolution;

  // "Remote chat" flyout (AC#5): only for a remote-capable, instance-scoped
  // bound route; the href is server-sourced from the first-party remote-target
  // resolver for the authorized instance.
  let remoteChat: { label: string; href: string } | undefined;
  if (assistant.remoteCapable && route.instance) {
    const dest = await resolveRemoteChatForBoundRoute({
      targetProvider: assistant.targetProvider,
      instanceId: route.instance,
    });
    if (dest) remoteChat = { label: "Remote chat", href: dest.href };
  }

  const sp = rawSp as Record<string, string | string[] | undefined>;
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
      initialThreadId={threadId ?? undefined}
      initialAssistantPackage={assistant.packageName}
      initialInstanceId={route.instance ?? null}
      remoteChat={remoteChat}
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
      chatViews={viewCatalog}
    />
  );
}

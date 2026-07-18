// Public props contract + page-mode union for <ChatPage>, extracted verbatim
// from chat-page.tsx as a behavior-preserving vertical slice (that file is a
// file-size-ratchet bottleneck; the S9-b chart-view wiring pushed it over its
// ceiling). Type-only by design — chat-page.tsx imports it via `import type`, so
// this adds NO runtime module to the /chat route graph (#1626 S9-b chart host
// cutover). The `chatViews` empty default is a runtime value and so stays inline
// in chat-page.tsx.
import type { WidgetDefinition, WidgetManifest } from "@cinatra-ai/sdk-ui";
import type { ChatViewComponents } from "./chat-messages-view";

export type ChatPageMode = "create-agent" | "create-workflow";

export type ChatPageProps = {
  initialThreadId?: string;
  userId?: string;
  initialMention?: string;
  initialMode?: ChatPageMode;
  /** Pre-fills the prompt field on mount (e.g. a `?wf=&task=` workflow-task
   *  handoff). Ignored if `initialMention` is set. */
  initialPrompt?: string;
  /** Live chat-widget catalog, resolved server-side by the chat mount from the
   *  generated extension manifest + extension lifecycle
   *  (src/lib/chat-widget-catalog.server.ts). Component values are RSC client
   *  references. Defaults to empty — widget embeds then simply don't render
   *  (a legitimate state when no widget-bearing extension is live). */
  widgets?: WidgetDefinition[];
  widgetManifests?: WidgetManifest[];
  /** Live chat renderable-view catalog (viewType → extension component),
   *  resolved server-side by the chat mount from the generated `cinatra.views`
   *  map + extension lifecycle (src/lib/chat-views-catalog.server.ts). Component
   *  values are RSC client references. Defaults to empty — the `chart` viewType
   *  then renders the never-blank fallback. */
  chatViews?: ChatViewComponents;
};

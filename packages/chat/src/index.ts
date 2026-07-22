export { ChatPage } from "./chat-page";
// CopilotActionsProvider + ActiveRun are retired with the rest of
// the legacy /chat/copilot surface. Inline agent dispatch + HITL gating now happen via
// InlineAgentRunCard mounted directly inside the main ChatPage thread.
export { InlineAgentRunCard } from "./inline-agent-run-card";
export { ChatThreadPanel } from "./chat-thread-panel";
export { ChatHistoryDrawer } from "./chat-history-drawer";
export { ChatSideBar } from "./chat-sidebar-bar";
export { ChatPanel } from "./chat-panel";
export { ChatViewPanel } from "./chat-view-panel";
export { SkillBadgeCloud } from "./skill-badge-cloud";
export type { SkillBadge, SkillBadgeCloudProps } from "./skill-badge-cloud";
// The ONE /chat path codec (cinatra#1878 W3). Pure + zero-dep — also exported as
// the `@cinatra-ai/chat/chat-path-codec` subpath for the host server component +
// AppShell/breadcrumb host seams (which must not pull the full barrel).
export {
  CHAT_ROOT,
  DEFAULT_ASSISTANT_PACKAGE,
  DEFAULT_CHAT_PATH,
  DEFAULT_CHAT_ROUTE,
  assertChatRoute,
  buildChatPath,
  chatSegmentsFromPathname,
  disambiguateRest,
  isChatPathname,
  packageNameToVendorSlug,
  parseChatPath,
  routeIsThread,
  routePackageName,
  splitChatSegments,
  threadSlugFromPathname,
  vendorSlugToPackageName,
} from "./chat-path-codec";
export type { ChatRoute, ChatSegmentsSplit, ParseChatPathResult } from "./chat-path-codec";

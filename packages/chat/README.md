# @cinatra-ai/chat

Client-side React UI for the Cinatra conversational assistant. Renders the main
chat surface — streaming assistant messages with Markdown, syntax-highlighted
code, math (KaTeX), Mermaid diagrams, and chart embeds — plus thread and team
management, conversation history, inline agent dispatch with human-in-the-loop
gating, and skill suggestion badges.

## Public API

- `ChatPage` — Full chat screen: prompt window, message thread, and rendering.
- `ChatPanel` — Card chrome with collapsible thread and team panels.
- `ChatThreadPanel` — Conversation thread list with rename and delete.
- `ChatHistoryDrawer` — Overlay history drawer for small viewports.
- `ChatSideBar` — Compact tab nav for threads and new chat.
- `ChatViewPanel` — Event-driven overlay panel (threads or teams).
- `InlineAgentRunCard` — Inline agent run panel with HITL drive.
- `SkillBadgeCloud` — Filterable grid of skill suggestion badges.
- `SkillBadge`, `SkillBadgeCloudProps` — Types for the badge cloud.

## Usage

```tsx
import { ChatPage, SkillBadgeCloud, type SkillBadge } from "@cinatra-ai/chat";

export function AssistantScreen() {
  return <ChatPage />;
}
```

All exports are client components (`"use client"`) intended to mount inside the
Cinatra app shell.

## Docs

See https://docs.cinatra.ai

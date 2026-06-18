"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { RotateCcw, PauseCircle, PlayCircle, Copy, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { authClient } from "@/lib/auth-client";
// Direct per-icon imports — avoid Turbopack processing the full simple-icons barrel (see apis-page.tsx note)
import SiAnthropic from "@icons-pack/react-simple-icons/icons/SiAnthropic.mjs";
import SiGooglegemini from "@icons-pack/react-simple-icons/icons/SiGooglegemini.mjs";
import { cn } from "@/lib/utils";
import { Marked, type Tokens } from "marked";
import { useTheme } from "next-themes";
import { highlightCodeAsync, getHighlightedSync, type ThemeName } from "./syntax-highlight";
import { PromptField, type PromptFieldHandle, type Mentionable, type WidgetDefinition, type WidgetManifest, type WidgetSubmitHandle } from "@cinatra-ai/sdk-ui";
// The widget set is NOT imported from extension packages here. It arrives as
// props from the server chat mount, which resolves it from the generated
// extension manifest + extension lifecycle (src/lib/chat-widget-catalog.server.ts);
// this file derives all detection/wizard/refresh behavior via the pure
// widget-runtime factory. Adding/removing a widget-bearing extension requires
// no edit to this file (#34 / IOC-39, IOC-41).
import {
  createChatWidgetRuntime,
  EMPTY_WIDGETS,
  EMPTY_WIDGET_MANIFESTS,
  type DetectedWidget,
} from "./widget-runtime";
import {
  deleteChatThread,
  deleteAllChatThreads,
  resolveMessageRouting,
  setAssistantPauseState,
  extractHitlGateValuesAction,
} from "./actions";
// Chat prompt-window HITL drive.
import { classifyPromptForGate } from "./inline-hitl-classify";
import type { ChatGateDescriptor } from "@cinatra-ai/agents/client-entry";
// Chat persistence/replay must carry artifact refs alongside text. Adding to
// the Message shape lets the bridge resolve them without the chat path
// importing @/lib directly.
import type { LlmAttachmentRef } from "@cinatra-ai/llm";

// Plain fetch instead of a Next.js server action — avoids the RSC re-render
// that server actions trigger, which caused a corrective navigation (and
// visible "page reload") when the URL had been changed via pushState while
// Next.js's internal router state still pointed at the old route.
async function saveChatThreadViaFetch(thread: Record<string, unknown> & { id: string }): Promise<void> {
  await fetch("/api/chat/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(thread),
  });
}

// Plain fetch instead of a Next.js server action — avoids corrective navigation
// triggered when the URL was updated via pushState before the action resolved.
async function fetchThreadByIdViaFetch(threadId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`/api/chat/thread/${threadId}`);
  if (!res.ok) return null;
  return res.json() as Promise<Record<string, unknown> | null>;
}

async function fetchThreadListViaFetch(): Promise<ThreadSummary[]> {
  const res = await fetch("/api/chat/threads");
  if (!res.ok) return [];
  return res.json() as Promise<ThreadSummary[]>;
}

import { SkillBadgeCloud } from "./skill-badge-cloud";
import { selectChatBadges, chatEmptyStateCaption, isPinnedBadgePrefill } from "./chat-badges";
import { fingerprintMessages, isRealActivity } from "./thread-activity";
import { resolveAssistantDisplayName } from "./assistant-display-name";
import { CINATRA_LOGO } from "@/lib/cinatra-brand";
import { publishChatThreadTitle } from "@/lib/chat-shell-bus";
import { MermaidBlock } from "./mermaid-block";
import { ChartEmbed, ChartError } from "./chart-embed";
import { validateChart, type ChartSpec } from "./chart-schema";
import { preprocessMath, restoreMath } from "./math-render";
import { DancingRobot } from "./dancing-robot";

type ToolCall = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  resultLabel?: string;
  serverLabel?: string;
};

type ThoughtGroup = {
  id: string;
  thinkingSeconds?: number;
  toolCalls: ToolCall[];
};

// Ordered render trace for an assistant turn — text deltas and tool-call
// events recorded in the chronological order they arrived on the stream.
// When present, the renderer uses this to interleave narration with tool
// badges (so the user sees "I'll check existing agents... [agent_source_list]
// ✓ ... Found one... [agent_source_read] ✓ ..." in the natural progression),
// instead of clustering all badges above all text. Legacy messages without
// `parts` fall back to the flat `content` + `thoughtGroups` rendering.
//
// Pure mutation helpers (applyTextDelta/applyToolCallEvent/applyToolResultEvent)
// live in `./assistant-parts.ts` with their own unit tests; the event-handler
// loop below uses them directly to avoid behavioural drift.
import {
  applyTextDelta,
  applyToolCallEvent,
  applyToolResultEvent,
  type AssistantMessagePart,
} from "./assistant-parts";
// Inline AgenticRunPanel wrapper. Mounted beneath assistant messages whose
// `parts` include an `agent_run` tool_call with a pinned runId (set by the
// tool_result handler below from the result JSON).
import { InlineAgentRunCard } from "./inline-agent-run-card";
import { UndoActionChip } from "./chat-undo-action-chip";

type Citation = {
  index: number;
  title: string;
  url: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  // Optional artifact refs attached to THIS turn. Persisted verbatim in the
  // thread JSON; forwarded to /api/chat so the runner can resolve them via the
  // bridge ports. Older messages without this field replay byte-identically.
  attachments?: LlmAttachmentRef[];
  thoughtGroups?: ThoughtGroup[];
  // Chronological render trace — populated alongside `content` and
  // `thoughtGroups` during streaming. Renderer prefers this when present.
  // Older persisted messages without `parts` fall back to the flat layout.
  parts?: AssistantMessagePart[];
  citations?: Citation[];
  error?: string;
  errorRaw?: string;
  liveStatus?: string;
  // Mention tracking — set on user messages directed at external assistants
  mentions?: Array<{ handle: string; assistantUserId: string; offset: number; length: number }>;
  mentionState?: Record<string, "pending" | "handled">;
  // Set on assistant messages from external assistants (not Cinatra's own LLM)
  authorUserId?: string;
};

type Thread = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  activeAssistantHandle?: string;
  taggedAssistantUserIds?: string[];
  slackMode?: boolean;
  ownerUserId?: string;
};

type ThreadSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

const MAX_STORED_THREADS = 50;

// Empty-state badge + caption selection live in ./chat-badges (pure +
// unit-tested). The component imports `selectChatBadges` +
// `chatEmptyStateCaption` and feeds the result into the badge cloud / h1.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId() {
  return crypto.randomUUID();
}

const CINATRA_QUOTES = [
  "I did it my way.",
  "The best is yet to come.",
  "Fly me to the moon.",
  "That's life — you're riding high in April, shipped in May.",
  "Start spreading the news.",
  "And now, the end is near, and so I face the final deploy.",
  "I've got you under my skin — err, my API.",
  "Come fly with me, let's fly, let's fly away.",
  "Luck be a lady tonight.",
  "The best revenge is massive success.",
  "You gotta love livin', baby, 'cause dyin' is a pain in the ass.",
  "I'm not the type to be pushed around. — Cinatra",
  "Alcohol may be man's worst enemy, but the bible says love your enemy.",
  "Don't hide your scars. They make you who you are.",
  "I feel sorry for people who don't drink. When they wake up, that's as good as they're gonna feel all day.",
  "The big lesson in life is never be scared of anyone or anything. — Cinatra",
  "You only go around once, but if you play your cards right, once is enough.",
  "May you live to be 100 and may the last voice you hear be mine. — Cinatra",
  "Cock your hat — angles are attitudes.",
];

function getGreeting() {
  const hour = new Date().getHours();
  const pick = (options: string[]) => options[Math.floor(Math.random() * options.length)];

  // ~1 in 6 chance to show a Cinatra quote instead of a regular greeting.
  if (Math.random() < 1 / 6) {
    return pick(CINATRA_QUOTES);
  }

  if (hour < 5) return pick(["Burning the midnight oil?", "Late night session?", "Night owl mode."]);
  if (hour < 12) return pick(["Good morning.", "Morning. What are we building?", "Fresh start. What's the plan?"]);
  if (hour < 17) return pick(["Good afternoon.", "How can I help?", "What's next on the list?"]);
  if (hour < 21) return pick(["Good evening.", "Evening session. What do you need?", "How can I help?"]);
  return pick(["Working late?", "Late one tonight?", "Night shift. What do you need?"]);
}

function formatToolName(name: string) {
  const parts = name.split(".");
  if (parts.length < 2) {
    return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // Show "resource · action" (e.g., "Campaigns · List", "Gmail · Aliases list").
  const action = parts.pop()!;
  const resource = parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
  const label = `${resource} · ${action}`.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return label;
}

function deriveThreadTitle(firstUserMessage: string) {
  const cleaned = firstUserMessage.replace(/\n/g, " ").trim();
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

function extractAgentName(text: string): string | null {
  const match = text.match(/the agent'?s?\s+name\s+is[:\s]+([^\n.!?,]+)/i);
  const name = match?.[1]?.trim();
  return name && name.length > 0 ? name : null;
}

function extractErrorMessage(raw: string): string {
  // Try to parse JSON error responses from OpenAI or the API route.
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error?.message) return String(parsed.error.message);
    if (parsed?.message) return String(parsed.message);
    if (parsed?.error && typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON — use as-is.
  }

  const trimmed = raw.trim();
  if (!trimmed) return "Something went wrong. Please try again.";

  // If it looks like a raw HTTP error body, simplify it.
  if (trimmed.length > 300) {
    return "The request failed. Please try again in a moment.";
  }

  return trimmed;
}

function formatRelativeTime(isoString: string) {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString();
}

const DEFAULT_GREETING = "How can I help?";

// ---------------------------------------------------------------------------
// Database persistence
// ---------------------------------------------------------------------------

async function fetchThreadList(): Promise<ThreadSummary[]> {
  try {
    const list = await fetchThreadListViaFetch();
    return list.slice(0, MAX_STORED_THREADS);
  } catch {
    return [];
  }
}

async function fetchThreadById(threadId: string): Promise<Thread | null> {
  try {
    return await fetchThreadByIdViaFetch(threadId) as Thread | null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

const APP_ROUTES = "campaigns|content|sources|accounts|contacts|transcript-generators";
const APP_ROUTE_RE = new RegExp(`^\\/?(?:${APP_ROUTES})\\/`);
const LINK_CLASSES = "text-muted-foreground underline underline-offset-4 hover:text-foreground";

function createMarkedInstance(theme: ThemeName = "github-light") {
  let tableIndex = 0;
  const appLinks: { html: string; label: string }[] = [];

  function appLinkPlaceholder(href: string, label: string): string {
    const idx = appLinks.length;
    appLinks.push({
      html: `<a href="${href}" class="${LINK_CLASSES}">${label}</a>`,
      label,
    });
    return `%%APPLINK_${idx}%%`;
  }

  // Resolve applink placeholders to plain text (for CSV data attributes).
  function resolveAppLinksAsText(text: string): string {
    return text.replace(/%%APPLINK_(\d+)%%/g, (_, idx) => appLinks[parseInt(idx)]?.label ?? "");
  }

  const md = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const text = this.parser.parseInline(tokens);
        if (depth <= 2) return `<h2 class="text-lg font-semibold text-foreground mt-5 mb-2">${text}</h2>`;
        return `<h3 class="text-base font-semibold text-foreground mt-4 mb-1">${text}</h3>`;
      },
      paragraph({ tokens }: Tokens.Paragraph) {
        return `<p class="my-2 leading-relaxed text-foreground">${this.parser.parseInline(tokens)}</p>`;
      },
      strong({ tokens }: Tokens.Strong) {
        return `<strong class="font-semibold text-foreground">${this.parser.parseInline(tokens)}</strong>`;
      },
      em({ tokens }: Tokens.Em) {
        return `<em class="italic text-foreground">${this.parser.parseInline(tokens)}</em>`;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        const inner = this.parser.parse(tokens).replace(/^<p[^>]*>([\s\S]*)<\/p>$/, "$1");
        return `<blockquote class="my-3 border-l-2 border-line pl-4 text-muted-foreground italic">${inner}</blockquote>`;
      },
      del({ tokens }: Tokens.Del) {
        return `<del class="line-through text-muted-foreground">${this.parser.parseInline(tokens)}</del>`;
      },
      codespan({ text }: Tokens.Codespan) {
        return `<code class="rounded bg-surface-muted px-1.5 py-0.5 text-xs font-mono text-foreground">${text}</code>`;
      },
      code({ text, lang }: Tokens.Code) {
        // Escape HTML to prevent XSS — text from LLM is untrusted.
        const escaped = text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
        const safeLang = lang ? lang.replace(/[^a-zA-Z0-9-]/g, "") : "";

        // Copy button SVG — reused on both sync-hit and placeholder paths.
        // audit-allow: markdown-content
        const copyBtn = `<button type="button" data-action="copy-code" class="chat-code-copy absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity rounded p-1 text-muted-foreground hover:text-foreground hover:bg-surface-muted" title="Copy code"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5"><rect x="5.5" y="5.5" width="7" height="7" rx="1"/><path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5"/></svg></button>`;

        // Sync cache hit — inject highlighted HTML directly.
        const cachedHtml = getHighlightedSync(text, safeLang || "text", theme);
        if (cachedHtml) {
          return `<div class="chat-code-block relative group my-3 rounded-lg overflow-hidden border border-line">${cachedHtml}${copyBtn}</div>`;
        }

        // Cache miss — emit fallback pre+code block and mark for async hydration.
        // URL-encode the raw source as the data attribute value (UTF-safe, no btoa needed).
        const encodedCode = encodeURIComponent(text);
        return `<div class="chat-code-block relative group my-3 rounded-lg overflow-hidden border border-line" data-shiki-code="${encodedCode}" data-shiki-lang="${safeLang}" data-shiki-theme="${theme}"><pre class="overflow-x-auto whitespace-pre bg-surface-muted p-4 text-[0.8rem] leading-relaxed font-mono text-foreground"><code>${escaped}</code></pre>${copyBtn}</div>`;
      },
      link({ href, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        if (/^https?:\/\//.test(href)) {
          return `<a href="${href}" target="_blank" rel="noreferrer" class="${LINK_CLASSES}">${text}</a>`;
        }
        if (/^mailto:/.test(href)) {
          return `<a href="${href}" class="${LINK_CLASSES}">${text}</a>`;
        }
        // Internal app link.
        return `<a href="${href}" class="${LINK_CLASSES}">${text}</a>`;
      },
      hr() {
        return '<hr class="my-4 border-line" />';
      },
      list(token: Tokens.List) {
        const items = token.items.map((item, i) => {
          const content = this.parser.parse(item.tokens);
          // Strip the first <p> wrapper (loose-list items wrap content in <p class="my-2">,
          // whose top margin detaches the number/bullet from its text).
          const inner = content.replace(/^<p[^>]*>([\s\S]*?)<\/p>/, "$1");
          if (token.ordered) {
            const num = (typeof token.start === "number" ? token.start : 1) + i;
            return `<div class="flex gap-2 my-0.5"><span class="text-muted-foreground shrink-0">${num}.</span><span>${inner}</span></div>`;
          }
          return `<div class="flex gap-2 my-0.5"><span class="text-muted-foreground shrink-0">&bull;</span><span>${inner}</span></div>`;
        });
        return items.join("");
      },
      table(token: Tokens.Table) {
        const tableId = `chat-table-${tableIndex++}`;
        const headerCells = token.header.map((cell) => this.parser.parseInline(cell.tokens));
        const bodyRows = token.rows.map((row) => row.map((cell) => this.parser.parseInline(cell.tokens)));

        // audit-allow: markdown-content
        const ths = headerCells
          .map((c) => `<th class="border-b border-line bg-surface px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">${c}</th>`)
          .join("");
        const pageSize = 25;
        const pageCount = Math.ceil(bodyRows.length / pageSize);
        const shouldPaginate = bodyRows.length > pageSize;
        const trs = bodyRows
          .map((cells, rowIndex) => {
            // audit-allow: markdown-content
            const tds = cells
              .map((c) => `<td class="border-b border-line px-4 py-3 text-sm text-foreground">${c.replace(/([^\n]) • /g, "$1<br>• ")}</td>`)
              .join("");
            // audit-allow: markdown-content
            return `<tr data-chat-table-row="${rowIndex}" class="${rowIndex >= pageSize ? "hidden" : ""}">${tds}</tr>`;
          })
          .join("");

        // CSV for download — use raw text from tokens, resolve applinks to plain text.
        const csvHeaderCells = token.header.map((cell) => cell.text);
        const csvBodyRows = token.rows.map((row) => row.map((cell) => cell.text));
        const csvRows = [
          csvHeaderCells.map((c) => `"${resolveAppLinksAsText(c).replace(/"/g, '""')}"`).join(","),
          ...csvBodyRows.map((cells) => cells.map((c) => `"${resolveAppLinksAsText(c).replace(/"/g, '""')}"`).join(",")),
        ];
        const csvData = csvRows.join("\\n");

        // audit-allow: markdown-content
        return `<div class="my-3 overflow-hidden rounded-lg border border-line bg-card" data-chat-table-frame><div class="flex items-center justify-end gap-1 border-b border-line px-2 py-1"><button type="button" data-table-id="${tableId}" data-action="copy" class="chat-table-action inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground" title="Copy table"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5"><rect x="5.5" y="5.5" width="7" height="7" rx="1"/><path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5"/></svg></button><button type="button" data-table-id="${tableId}" data-action="download" data-csv="${csvData.replace(/"/g, "&quot;")}" class="chat-table-action inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground" title="Download CSV"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12h10" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div><div class="overflow-x-auto"><table id="${tableId}" class="min-w-full caption-bottom text-sm"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>${shouldPaginate ? `<div class="flex flex-col gap-2 border-t border-line bg-card px-3 py-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between" data-chat-table-pagination data-page="0" data-page-size="${pageSize}" data-row-count="${bodyRows.length}"><span data-chat-table-range-label>1-${Math.min(pageSize, bodyRows.length)} of ${bodyRows.length}</span><div class="flex items-center gap-2"><span data-chat-table-page-label>Page 1 of ${pageCount}</span><div class="flex items-center gap-1"><button type="button" class="chat-table-pagination-action inline-flex h-7 items-center justify-center rounded-md border border-line bg-background px-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:pointer-events-none disabled:opacity-50" data-action="previous" disabled>Previous</button><button type="button" class="chat-table-pagination-action inline-flex h-7 items-center justify-center rounded-md border border-line bg-background px-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:pointer-events-none disabled:opacity-50" data-action="next" ${pageCount <= 1 ? "disabled" : ""}>Next</button></div></div></div>` : ""}</div>`;
      },
      // Suppress default table sub-renderers (we handle everything in table()).
      tablerow() { return ""; },
      tablecell() { return ""; },
    },
  });

  return { md, appLinks, appLinkPlaceholder };
}

// `detectWidgets` is REQUIRED (no default): every caller must pass the live
// runtime's detector so a missing widget catalog is a compile error here, not
// a silently-dead widget surface.
function renderMarkdown(
  text: string,
  theme: ThemeName,
  detectWidgets: (content: string) => DetectedWidget[],
) {
  const { md, appLinks, appLinkPlaceholder } = createMarkedInstance(theme);

  // Strip mermaid fenced blocks so marked never sees them — they are rendered
  // separately as MermaidBlock React components beside the markdown HTML.
  // Also strip [chart:{...}] embeds and ```chart``` fenced blocks — rendered
  // separately as ChartEmbed components.
  const stripped = stripChartEmbeds(
    text
      .replace(/```mermaid\n[\s\S]*?```/g, "")
      .replace(/```chart\n[\s\S]*?```/g, ""),
  );

  // Pre-process: strip widget/confirm markers and extract app link placeholders.
  let cleaned = stripped
    .replace(/\[widget:[a-z0-9.-]+:[a-f0-9-]{36}\]/gi, "")
    .replace(/\[confirm-[a-z_-]+:[a-f0-9-]{36}\]/gi, "")
    // Strip bare URL lines only if they match a widget detector (rendered as embed).
    // Also handles lines inside blockquotes ("> /campaigns/...").
    .replace(new RegExp(`^(?:>\\s*)*[#"']*\\/?(?:${APP_ROUTES})\\/[^\\s"']*["']?$`, "gm"), (line) => {
      const trimmed = line.replace(/^[>\s#"']+|["']+$/g, "").trim();
      const hasWidget = detectWidgets(trimmed).length > 0;
      if (hasWidget) return "";
      const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
      return appLinkPlaceholder(path, path);
    })
    // Convert markdown links to app routes into placeholders.
    .replace(new RegExp(`\\[([^\\]]*)\\]\\([#/]*(?:${APP_ROUTES})\\/[^)]+\\)`, "g"), (match, label) => {
      const hrefMatch = match.match(/\(([^)]+)\)/);
      if (!hrefMatch) return match;
      const href = hrefMatch[1].replace(/^#/, "");
      return appLinkPlaceholder(href, label);
    });

  // Pre-process math: replace $$...$$ and $...$ with placeholders before marked
  // parses, so marked does not interfere with $ or \ escaping inside LaTeX.
  const { text: mathProcessed, placeholders: mathPlaceholders } = preprocessMath(cleaned);
  cleaned = mathProcessed;

  // Convert simplified pipe tables (no separator line) to standard markdown format
  // so that marked's GFM parser can handle them.
  cleaned = cleaned.replace(
    /(?:^|\n)([^\n|]+\|[^\n]+)\n((?:[^\n|]+\|[^\n]+\n?){1,})/g,
    (match, headerRow: string, bodyRows: string) => {
      const headerCells = headerRow.split("|").map((c: string) => c.trim()).filter(Boolean);
      if (headerCells.length < 2) return match;
      const bodyRowsArr = bodyRows.trim().split("\n").map((row: string) => row.split("|").map((c: string) => c.trim()).filter(Boolean));
      if (bodyRowsArr.length === 0 || bodyRowsArr.some((r: string[]) => r.length < 2)) return match;
      // Insert a separator line to make it a standard markdown table.
      const sep = "| " + headerCells.map(() => "---").join(" | ") + " |";
      const header = "| " + headerCells.join(" | ") + " |";
      const rows = bodyRowsArr.map((cells: string[]) => "| " + cells.join(" | ") + " |").join("\n");
      return `\n${header}\n${sep}\n${rows}`;
    },
  );

  // Split inline "• " separated content onto separate lines so list parsing handles each item.
  cleaned = cleaned.replace(/([^\n]) • /g, "$1\n• ");
  // Normalize "• " bullet lines to "- " for marked's list parser.
  cleaned = cleaned.replace(/^• /gm, "- ");
  // Fix standalone "•" alone on a line followed by content on the next line (no trailing space).
  cleaned = cleaned.replace(/^•\n(?=[^\n])/gm, "- ");
  // Fix numbered list marker alone on its own line: "1.\nContent" → "1. Content".
  cleaned = cleaned.replace(/^(\d+\.)\n(?=[^\n])/gm, "$1 ");

  let html = md.parse(cleaned, { async: false }) as string;

  // Restore app link placeholders.
  for (let i = 0; i < appLinks.length; i++) {
    html = html.replaceAll(`%%APPLINK_${i}%%`, appLinks[i].html);
  }

  // Restore math placeholders (KaTeX HTML) after marked processing.
  html = restoreMath(html, mathPlaceholders);

  // Remove empty paragraphs.
  html = html.replace(/<p[^>]*>\s*<\/p>/g, "");

  return html;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function IconChat({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className ?? "h-7 w-7"}>
      <path d="M20 6c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2h2l4 4 4-4h2c1.1 0 2-.9 2-2V6Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="8.5" cy="10.5" r="1" fill="currentColor" />
      <circle cx="12" cy="10.5" r="1" fill="currentColor" />
      <circle cx="15.5" cy="10.5" r="1" fill="currentColor" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
    </svg>
  );
}

function IconHistory() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="h-3.5 w-3.5">
      <path d="M2.5 4h11M5.5 4V2.5h5V4M6.5 7v4M9.5 7v4M3.5 4l.5 8.5a1 1 0 0 0 1 .92h6a1 1 0 0 0 1-.92L12.5 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
      <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" />
    </svg>
  );
}

function IconAgent() {
  return (
    <svg viewBox={CINATRA_LOGO.fullViewBox} fill="none" aria-hidden="true" style={{ height: "0.75rem", width: "auto", flexShrink: 0 }}>
      <path d={CINATRA_LOGO.brim} fill="currentColor" />
      <path d={CINATRA_LOGO.crown} fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Collapsible thought group (like ChatGPT's "Thought & used N tools")
// ---------------------------------------------------------------------------

function ThoughtGroupSection({ group, isLive }: { group: ThoughtGroup; isLive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const toolCount = group.toolCalls.length;
  const allDone = group.toolCalls.every((tc) => tc.status === "completed");
  const seconds = group.thinkingSeconds ?? 0;

  // Build the summary label.
  let summary: string;
  if (isLive && !allDone) {
    summary = toolCount > 0 ? `Thinking & using ${toolCount} tool${toolCount === 1 ? "" : "s"}` : "Thinking...";
  } else if (toolCount > 0 && seconds > 1) {
    summary = `Thought for ${seconds}s & used ${toolCount} tool${toolCount === 1 ? "" : "s"}`;
  } else if (toolCount > 0) {
    summary = `Used ${toolCount} tool${toolCount === 1 ? "" : "s"}`;
  } else if (seconds > 1) {
    summary = `Thought for ${seconds} second${seconds === 1 ? "" : "s"}`;
  } else {
    return null; // Nothing interesting to show.
  }

  return (
    <div className="mb-2">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setExpanded((v) => !v)}
        className="flex h-auto items-center gap-1.5 px-0 py-0 text-xs text-muted-foreground transition hover:bg-transparent hover:text-foreground"
      >
        {isLive && !allDone ? (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
        ) : (
          <IconAgent />
        )}
        <span className="font-medium">{summary}</span>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`h-3 w-3 transition ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
      {expanded && group.toolCalls.length > 0 && (
        <div className="ml-4 mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
          {group.toolCalls.map((tc) => (
            <div key={tc.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              {tc.status === "running" ? (
                <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-muted-foreground" />
              ) : (
                <svg viewBox="0 0 16 16" fill="currentColor" className="h-2.5 w-2.5 text-muted-foreground">
                  <circle cx="8" cy="8" r="3" />
                </svg>
              )}
              <span>{tc.resultLabel || (tc.serverLabel && tc.serverLabel !== "cinatra"
                ? `${tc.serverLabel.replace(/^external-/, "").replace(/-connector$/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} · ${tc.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`
                : formatToolName(tc.name))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ordered parts renderer (chronologically interleaved text + tool badges)
// ---------------------------------------------------------------------------

function OrderedPartsSection({
  parts,
  trimContent,
  theme,
  detectWidgets,
  onMarkdownClick,
  onActiveGateChange,
}: {
  parts: AssistantMessagePart[];
  trimContent?: (content: string) => string;
  theme: ThemeName;
  /** Live widget detector from the chat widget runtime (renderMarkdown needs
   *  it to strip URL lines already rendered as widget embeds). */
  detectWidgets: (content: string) => DetectedWidget[];
  // Delegated click handler so the same code-copy / table-action behaviour
  // that the legacy `message.content` div provides also works for text
  // parts rendered here. Bound at the parent level so the `closest`
  // selectors still match any child element inside any text part.
  onMarkdownClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  // Threaded down to the inline agent-run card so an open HITL gate can be
  // driven from the chat prompt window.
  onActiveGateChange?: (
    runId: string,
    gate: ChatGateDescriptor | null,
    instanceId: string,
  ) => void;
}) {
  if (parts.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" onClick={onMarkdownClick}>
      {parts.map((part, idx) => {
        if (part.kind === "text") {
          const raw = trimContent ? trimContent(part.content) : part.content;
          // Skip pure-whitespace text parts (they're separator artifacts).
          if (!raw.replace(/\s+/g, "").length) return null;
          return (
            <div
              key={`text-${idx}`}
              className="max-w-none text-[15px] leading-relaxed text-foreground [&_table]:my-0"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(raw, theme, detectWidgets) }}
            />
          );
        }
        // `agent_run` tool_results carry a runId pinned by the tool_result
        // handler. Mount AgenticRunPanel inline so the user can drive HITL
        // gates (URL pickers, list pickers, reviewer approvals) from within
        // the chat thread instead of navigating to /agents/<v>/<s>/<runId>.
        // The card resolves to its own panel chrome — no extra Card wrapper here.
        if (part.kind === "tool_call" && part.name === "agent_run" && part.runId) {
          return (
            <div key={`agent-run-${part.runId}`}>
              <InlineAgentRunCard
                runId={part.runId}
                onActiveGateChange={onActiveGateChange}
              />
              {/* Inline undo for a recent restorable change-set produced by
                  this run. */}
              <UndoActionChip runId={part.runId} />
            </div>
          );
        }
        // Other tool parts feed the single live status line below the
        // message and don't render inline content.
        return null;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live progress indicator (ChatGPT-style pulsating dot + short status text)
// ---------------------------------------------------------------------------

function formatToolCallLabel(tc: ToolCall) {
  if (tc.serverLabel && tc.serverLabel !== "cinatra") {
    const server = tc.serverLabel
      .replace(/^external-/, "")
      .replace(/-connector$/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const action = tc.name
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return `${server} · ${action}`;
  }

  return formatToolName(tc.name);
}

function formatToolProgressStatus(tc: ToolCall) {
  const name = tc.name.toLowerCase();
  const label = formatToolCallLabel(tc);

  if (name === "agent_source_list") return "Loading agent sources";
  if (name === "agent_source_read") return "Reading agent source";
  if (name === "agent_source_write") return "Writing agent source";
  if (name === "agent_source_write_files") return "Writing agent package files";
  if (name === "agent_source_validate") return "Validating agent source";
  if (name === "agent_source_compile") return "Compiling agent source";
  if (name === "agent_source_publish") return "Publishing agent source";
  if (name.includes("web_search")) return "Searching the web";
  if (name.includes("extensions_search")) return "Searching extensions";
  if (name.includes("agent_run_messages_list")) return "Checking agent messages";
  if (name.includes("agent_run_get")) return "Checking agent run";
  if (name.includes("agent_run")) return "Starting agent run";
  if (name.includes("search")) return `Searching ${label}`;
  if (name.includes("list") || name.includes("get") || name.includes("read") || name.includes("fetch")) {
    return `Reading ${label}`;
  }

  return `Using ${label}`;
}

function getLiveProgressStatus(message: Message) {
  if (message.liveStatus) return message.liveStatus;

  const latestPart = getLatestAssistantPart(message);
  if (latestPart?.kind === "tool_call" && latestPart.status === "running") {
    return formatToolProgressStatus(latestPart);
  }

  const group = message.thoughtGroups?.[message.thoughtGroups.length - 1];
  const runningTool = group?.toolCalls.findLast((tc) => tc.status === "running");

  if (runningTool) {
    return formatToolProgressStatus(runningTool);
  }

  if (group?.toolCalls.some((tc) => tc.status === "completed")) {
    return "Reviewing tool results";
  }

  if (hasVisibleStreamingText(message.content)) {
    return "Working on the next step";
  }

  return "Thinking";
}

function getLatestAssistantPart(message: Message) {
  const parts = message.parts;
  if (!parts || parts.length === 0) return null;

  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part.kind === "text" && !hasVisibleStreamingText(part.content)) {
      continue;
    }
    return part;
  }

  return null;
}

function hasVisibleStreamingText(content: string) {
  return trimIncompleteEmbeds(content).replace(/\s+/g, "").length > 0;
}

function shouldShowLiveProgressStatus(message: Message) {
  if (message.liveStatus) return true;

  const latestPart = getLatestAssistantPart(message);
  if (latestPart) return latestPart.kind === "tool_call";
  return !hasVisibleStreamingText(message.content);
}

function ThinkingIndicator({ className, label = "Thinking" }: { className?: string; label?: string } = {}) {
  const showProgressSuffix = label !== "Thinking";

  return (
    <div className={cn("flex animate-pulse items-center gap-2.5 text-muted-foreground", className)} role="status" aria-live="polite">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-current opacity-70" />
      </span>
      <span className="text-sm font-medium">
        {label}
        {showProgressSuffix ? " >" : null}
      </span>
    </div>
  );
}

// Waiting indicator — shown while an external assistant (@handle) is expected to reply.
function WaitingIndicator({ handle }: { handle: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-muted-foreground opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground opacity-40" />
      </span>
      <span className="text-sm text-muted-foreground">
        Waiting for @{handle}...
      </span>
    </div>
  );
}

// Per-assistant typing indicator shown in Slack mode while a Cinatra stream is buffering.
function SlackTypingIndicator({ handle }: { handle: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-muted-foreground opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground opacity-40" />
      </span>
      <span className="text-sm text-muted-foreground">
        @{handle} is thinking...
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error card
// ---------------------------------------------------------------------------

function ErrorCard({ error, errorRaw }: { error: string; errorRaw?: string }) {
  const [copied, setCopied] = useState(false);
  const verbatim = errorRaw || error;

  function handleCopy() {
    void navigator.clipboard.writeText(verbatim).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
      <div className="flex items-start gap-2.5">
        <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0 text-destructive">
          <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22Z" clipRule="evenodd" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-destructive">Something went wrong</p>
          <p className="mt-0.5 text-sm text-destructive/80">{error}</p>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end">
        <Button
          type="button"
          variant="ghost"
          onClick={handleCopy}
          className="inline-flex h-auto items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/15 hover:text-destructive"
        >
          {copied ? (
            <>
              <IconCheck />
              Copied
            </>
          ) : (
            <>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
                <path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5" />
              </svg>
              Copy error details
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget system
// ---------------------------------------------------------------------------
// The registries, detector compilation, and wizard/refresh helpers live in
// ./widget-runtime (pure factory). ChatPage builds the runtime from its
// `widgets` / `widgetManifests` props via useMemo and threads it to the render
// helpers below — no module-level widget state, no extension imports.

// ---------------------------------------------------------------------------
// Mermaid block detection
// ---------------------------------------------------------------------------

type MermaidSource = { source: string };

function detectMermaidBlocks(text: string): MermaidSource[] {
  const blocks: MermaidSource[] = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ source: m[1].trim() });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Chart embed detection
// ---------------------------------------------------------------------------

// Maximum payload size (bytes) accepted from a single [chart:...] embed.
// Prevents the UI from freezing on a maliciously large JSON blob from the LLM.
const CHART_PAYLOAD_MAX_BYTES = 20_000;

type DetectedChart = { spec: ChartSpec | null; raw: string };

/**
 * Balanced-bracket scan for [chart:{...}] embeds.
 *
 * Rationale: a simple regex like /\[chart:(.*?)\]/g would fail whenever the
 * JSON value itself contains a `]` character (e.g. arrays). Instead we walk
 * character-by-character, tracking the depth of `{` / `}` pairs so we know
 * exactly where the JSON object ends and can then expect the closing `]`.
 *
 * Security: untrusted LLM output — validateChart() is called on every result;
 * results are never passed to dangerouslySetInnerHTML.
 */
function detectCharts(text: string): DetectedChart[] {
  const results: DetectedChart[] = [];

  // Also detect ```chart\n{...}\n``` fenced code blocks emitted by LLMs.
  const codeBlockRegex = /```chart\n([\s\S]*?)\n```/g;
  let codeMatch: RegExpExecArray | null;
  while ((codeMatch = codeBlockRegex.exec(text)) !== null) {
    const raw = codeMatch[0];
    const jsonPayload = codeMatch[1].trim();
    if (jsonPayload.length > CHART_PAYLOAD_MAX_BYTES) {
      results.push({ spec: null, raw });
    } else {
      let parsed: unknown = null;
      try { parsed = JSON.parse(jsonPayload); } catch { /* invalid json */ }
      results.push({ spec: parsed !== null ? validateChart(parsed) : null, raw });
    }
  }

  const PREFIX = "[chart:";
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf(PREFIX, searchFrom);
    if (start === -1) break;

    const jsonStart = start + PREFIX.length;
    if (text[jsonStart] !== "{") {
      searchFrom = start + 1;
      continue;
    }

    // Walk forward tracking brace depth.
    let depth = 0;
    let i = jsonStart;
    let jsonEnd = -1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          jsonEnd = i;
          break;
        }
      }
      i++;
    }

    if (jsonEnd === -1) {
      searchFrom = start + 1;
      continue;
    }

    // Expect ']' immediately after the closing '}'.
    if (text[jsonEnd + 1] !== "]") {
      searchFrom = jsonEnd + 1;
      continue;
    }

    const raw = text.slice(start, jsonEnd + 2); // includes "[chart:" ... "}]"
    const jsonPayload = text.slice(jsonStart, jsonEnd + 1);

    if (jsonPayload.length > CHART_PAYLOAD_MAX_BYTES) {
      results.push({ spec: null, raw });
    } else {
      let parsed: unknown = null;
      try { parsed = JSON.parse(jsonPayload); } catch { /* invalid json */ }
      results.push({ spec: parsed !== null ? validateChart(parsed) : null, raw });
    }

    searchFrom = jsonEnd + 2;
  }

  return results;
}

/**
 * While an assistant message is streaming, the tail of the content may contain
 * an incomplete embed that hasn't been closed yet (e.g. `[chart:{"type":"bar"...`
 * with no closing `}]`). renderMarkdown would pass this raw text through to
 * the markdown renderer, causing a flash of JSON code.
 *
 * This trims any trailing incomplete embed prefix so the markdown renderer
 * never sees partial special tokens. Only used on the live streaming message.
 */
function trimIncompleteEmbeds(text: string): string {
  // Each embed starts with one of these prefixes.
  const PREFIXES = ["[chart:", "[widget:", "[confirm-", "```mermaid"];
  let result = text;
  for (const prefix of PREFIXES) {
    const idx = result.lastIndexOf(prefix);
    if (idx === -1) continue;
    // Check whether the embed has been fully closed after this prefix.
    const tail = result.slice(idx);
    const isClosed =
      prefix === "```mermaid"
        ? tail.includes("```", prefix.length)     // fenced block needs closing ```
        : prefix === "[chart:"
          ? (() => {
              // Use the same brace-depth logic as detectCharts.
              const jsonStart = prefix.length;
              if (tail[jsonStart] !== "{") return true; // not a JSON chart, let it pass
              let depth = 0;
              for (let i = jsonStart; i < tail.length; i++) {
                if (tail[i] === "{") depth++;
                else if (tail[i] === "}") {
                  depth--;
                  if (depth === 0) return tail[i + 1] === "]";
                }
              }
              return false;
            })()
          : tail.includes("]");                    // widget/confirm just need closing ]
    if (!isClosed) {
      result = result.slice(0, idx);
    }
  }
  return result;
}

/**
 * Strips all [chart:{...}] embeds from a string using the same balanced-bracket
 * walker as detectCharts(). Used inside renderMarkdown() so the raw JSON never
 * appears in the HTML output.
 */
function stripChartEmbeds(text: string): string {
  const charts = detectCharts(text);
  let result = text;
  // Replace in reverse order so indices stay valid.
  for (let i = charts.length - 1; i >= 0; i--) {
    result = result.replace(charts[i].raw, "");
  }
  return result;
}

function ChatWidget({
  widget,
  def,
  submitRef,
  isOlderWidget,
  refreshKey,
}: {
  widget: DetectedWidget;
  /** Resolved by the caller from the live widget runtime (findWidget). */
  def: WidgetDefinition | undefined;
  submitRef: React.RefObject<WidgetSubmitHandle | null>;
  isOlderWidget?: boolean;
  refreshKey?: number;
}) {
  const ownRef = useRef<WidgetSubmitHandle | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  if (!def) return null;

  const Component = def.component;
  const effectiveRef = isOlderWidget ? ownRef : submitRef;

  return (
    <div className="mt-3 w-full overflow-hidden rounded-xl border border-line bg-surface-strong shadow-lg">
      <div className="p-2">
        <Component
          key={refreshKey}
          resourceId={widget.resourceId}
          submitRef={effectiveRef}
          onSave={isOlderWidget ? () => setStatus("saved") : undefined}
        />
        {isOlderWidget && (
          <div className="flex justify-end px-2 pb-1">
            {status === "saving" ? (
              <svg className="h-4 w-4 animate-spin text-muted-foreground" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" className="opacity-25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            ) : status === "saved" ? (
              <svg className="h-4 w-4 text-success" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 0 1 0 1.414l-8 8a1 1 0 0 1-1.414 0l-4-4a1 1 0 1 1 1.414-1.414L8 12.586l7.293-7.293a1 1 0 0 1 1.414 0Z" />
              </svg>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={async () => {
                  setStatus("saving");
                  const ok = await ownRef.current?.submit();
                  setStatus(ok ? "saved" : "idle");
                }}
                className="h-auto rounded-lg px-3 py-1 text-xs font-medium text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground"
              >
                Save
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// User message bubble with copy / edit actions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mention badge renderer — converts @handle tokens in plain text to inline chips
// ---------------------------------------------------------------------------

function MentionBadge({ m }: { m: Mentionable }) {
  return (
    <span
      className="mention-chip inline-flex items-center gap-1 align-middle bg-surface-muted border border-line rounded-full pl-0.5 pr-1.5 py-0.5 text-xs leading-none select-none mx-1"
    >
      <span className="size-[1.1rem] rounded-full overflow-hidden inline-flex shrink-0 items-center justify-center bg-muted text-muted-foreground text-[8px] font-semibold">
        {m.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={m.image} alt="" className="size-full object-cover" />
        ) : (
          m.displayName.charAt(0).toUpperCase()
        )}
      </span>
      <span>{m.displayName}</span>
    </span>
  );
}

function renderWithMentions(content: string, mentionables: Mentionable[]): React.ReactNode {
  if (!mentionables.length || !content.includes("@")) return content;
  const handleMap = new Map(mentionables.map((m) => [m.handle, m]));
  const parts = content.split(/(@[a-zA-Z0-9_.\-]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      const m = handleMap.get(part.slice(1));
      if (m) return <MentionBadge key={i} m={m} />;
    }
    return part;
  });
}

// ---------------------------------------------------------------------------

function UserMessageBubble({
  message,
  onEdit,
  disabled,
  isSlackMode = false,
  editRequested = false,
  onEditStarted,
  mentionables = [],
}: {
  message: Message;
  onEdit: (messageId: string, newContent: string) => void;
  disabled?: boolean;
  isSlackMode?: boolean;
  editRequested?: boolean;
  onEditStarted?: () => void;
  mentionables?: Mentionable[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editRequested || editing) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }

      setEditing(true);
      onEditStarted?.();
    });

    return () => {
      cancelled = true;
    };
  }, [editRequested, editing, onEditStarted]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [editing]);

  if (editing) {
    return (
      <div className="mb-4 w-full rounded-control bg-surface-muted/60 px-4 py-3 shadow-sm">
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (draft.trim()) {
                setEditing(false);
                onEdit(message.id, draft);
              }
            }
            if (e.key === "Escape") {
              setEditing(false);
              setDraft(message.content);
            }
          }}
          style={{ boxShadow: "none" }}
          className="min-h-0 w-full resize-none border-0 bg-transparent px-0 py-0 text-sm text-foreground shadow-none outline-none focus-visible:ring-0"
          rows={1}
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => { setEditing(false); setDraft(message.content); }}
            className="h-auto rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-surface-muted"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (draft.trim()) {
                setEditing(false);
                onEdit(message.id, draft);
              }
            }}
            className="h-auto rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/80"
          >
            Send
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("group relative min-w-0", isSlackMode ? "max-w-[85%]" : "max-w-[75%]")}>
      <div className="whitespace-pre-wrap break-words rounded-control bg-surface-muted px-4 py-3 text-sm text-foreground">
        {renderWithMentions(message.content, mentionables)}
      </div>
      {!disabled && !isSlackMode && (
        <div className="absolute -bottom-1 right-0 flex translate-y-full gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void navigator.clipboard.writeText(message.content)}
            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground"
            title="Copy"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
              <path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5" />
            </svg>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => { setDraft(message.content); setEditing(true); }}
            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground"
            title="Edit message"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slack-mode helpers
// ---------------------------------------------------------------------------

function getParticipantInitials(handle: string | undefined): string {
  if (!handle || handle.length === 0) return "AS";
  const stripped = handle.startsWith("@") ? handle.slice(1) : handle;
  return stripped.slice(0, 2).toUpperCase();
}

// Inline OpenAI icon (removed from simple-icons)
function OpenAIChatIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v 5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.843-3.368L15.116 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.104v-5.678a.79.79 0 0 0-.407-.666zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/>
    </svg>
  );
}

function CinatraAvatarIcon() {
  return (
    <svg viewBox={CINATRA_LOGO.fullViewBox} xmlns="http://www.w3.org/2000/svg" fill="none" aria-label="Cinatra" className="h-3 w-3">
      <path d={CINATRA_LOGO.brim} fill="currentColor" />
      <path d={CINATRA_LOGO.crown} fill="currentColor" />
    </svg>
  );
}

function getAssistantProviderIcon(handle: string | undefined): React.ReactNode | null {
  if (!handle) return null;
  const h = handle.toLowerCase();
  if (h.includes("cinatra")) return <CinatraAvatarIcon />;
  if (h.includes("claude") || h.includes("anthropic")) return <SiAnthropic size={12} />;
  if (h.includes("gpt") || h.includes("openai")) return <OpenAIChatIcon size={12} />;
  if (h.includes("gemini") || h.includes("google")) return <SiGooglegemini size={12} />;
  return null;
}

// ---------------------------------------------------------------------------
// Main chat page
// ---------------------------------------------------------------------------

type ChatPageMode = "create-agent" | "create-workflow";

type ChatPageProps = {
  initialThreadId?: string;
  userId?: string;
  initialMention?: string;
  initialMode?: ChatPageMode;
  /** Pre-fills the prompt field on mount (e.g. workflow-task handoff from the
   *  Gantt "Open in chat" context action). Ignored if `initialMention` is set. */
  initialPrompt?: string;
  /** Live chat-widget catalog, resolved server-side by the chat mount from the
   *  generated extension manifest + extension lifecycle
   *  (src/lib/chat-widget-catalog.server.ts). Component values are RSC client
   *  references. Defaults to empty — widget embeds then simply don't render
   *  (a legitimate state when no widget-bearing extension is live). */
  widgets?: WidgetDefinition[];
  widgetManifests?: WidgetManifest[];
};

function updateChatTablePage(frame: Element, requestedPage: number) {
  const pagination = frame.querySelector<HTMLElement>("[data-chat-table-pagination]");
  if (!pagination) return;

  const rows = Array.from(frame.querySelectorAll<HTMLTableRowElement>("[data-chat-table-row]"));
  const pageSize = Number(pagination.dataset.pageSize ?? "25");
  const rowCount = Number(pagination.dataset.rowCount ?? rows.length);
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 25;
  const safeRowCount = Number.isFinite(rowCount) && rowCount > 0 ? rowCount : rows.length;
  const pageCount = Math.max(1, Math.ceil(safeRowCount / safePageSize));
  const page = Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const firstIndex = page * safePageSize;
  const lastIndex = Math.min(safeRowCount, firstIndex + safePageSize);

  pagination.dataset.page = String(page);
  rows.forEach((row, index) => {
    row.classList.toggle("hidden", index < firstIndex || index >= lastIndex);
  });

  const rangeLabel = pagination.querySelector<HTMLElement>("[data-chat-table-range-label]");
  if (rangeLabel) {
    rangeLabel.textContent = `${firstIndex + 1}-${lastIndex} of ${safeRowCount}`;
  }

  const pageLabel = pagination.querySelector<HTMLElement>("[data-chat-table-page-label]");
  if (pageLabel) {
    pageLabel.textContent = `Page ${page + 1} of ${pageCount}`;
  }

  pagination.querySelectorAll<HTMLButtonElement>(".chat-table-pagination-action").forEach((button) => {
    if (button.dataset.action === "previous") {
      button.disabled = page === 0;
    } else if (button.dataset.action === "next") {
      button.disabled = page >= pageCount - 1;
    }
  });
}

export function ChatPage({ initialThreadId, userId, initialMention, initialMode, initialPrompt, widgets = EMPTY_WIDGETS, widgetManifests = EMPTY_WIDGET_MANIFESTS }: ChatPageProps = {}) {
  const { resolvedTheme } = useTheme();
  const theme: ThemeName = resolvedTheme === "dark" ? "github-dark" : "github-light";
  // Manifest-driven widget runtime — registries/detectors/wizard helpers
  // derived from the props-resolved catalog (see ./widget-runtime).
  const widgetRuntime = useMemo(
    () => createChatWidgetRuntime(widgets, widgetManifests),
    [widgets, widgetManifests],
  );
  // Shared click handler for assistant markdown content: handles
  // copy-code buttons (inside fenced code blocks) and table copy/CSV
  // download actions. Both the legacy `message.content` div and the new
  // `OrderedPartsSection` text parts wear this handler so the buttons
  // work the same way regardless of which render path is active.
  const handleAssistantMarkdownClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const codeBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action='copy-code']");
    if (codeBtn) {
      const block = codeBtn.closest(".chat-code-block");
      if (block) {
        const codeEl = block.querySelector("code");
        const rawText = codeEl?.textContent ?? "";
        void navigator.clipboard.writeText(rawText);
      }
      return;
    }
    const tablePageBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".chat-table-pagination-action");
    if (tablePageBtn) {
      const frame = tablePageBtn.closest("[data-chat-table-frame]");
      const pagination = frame?.querySelector<HTMLElement>("[data-chat-table-pagination]");
      if (frame && pagination) {
        const currentPage = Number(pagination.dataset.page ?? "0");
        updateChatTablePage(
          frame,
          tablePageBtn.dataset.action === "previous" ? currentPage - 1 : currentPage + 1,
        );
      }
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".chat-table-action");
    if (!btn) return;
    const tableId = btn.dataset.tableId;
    const action = btn.dataset.action;
    if (action === "copy" && tableId) {
      const table = document.getElementById(tableId);
      if (table) {
        const rows = Array.from(table.querySelectorAll("tr"));
        const text = rows.map((row) =>
          Array.from(row.querySelectorAll("th, td")).map((cell) => cell.textContent?.trim() ?? "").join("\t"),
        ).join("\n");
        void navigator.clipboard.writeText(text);
      }
    } else if (action === "download" && btn.dataset.csv) {
      const csv = btn.dataset.csv.replace(/\\n/g, "\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "table.csv";
      a.click();
      URL.revokeObjectURL(url);
    }
  }, []);
  const isCreateAgentMode = initialMode === "create-agent";
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThreadId ?? null);
  const [messages, setMessages] = useState<Message[]>([]);
  // Streaming registry: one AbortController per in-flight streamResponse call.
  // Replaces the single boolean flag so N concurrent streams can coexist.
  const [streamingCount, setStreamingCount] = useState(0);
  const hasActiveStream = streamingCount > 0;
  // Map of assistantId → display handle for per-assistant typing indicator bubbles in Slack mode.
  const [typingIndicators, setTypingIndicators] = useState<Map<string, string>>(new Map());
  const [activeAssistantHandle, setActiveAssistantHandle] = useState<string | undefined>();
  const [pendingExternalHandle, setPendingExternalHandle] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [greeting, setGreeting] = useState(DEFAULT_GREETING);
  const [autosaveEnabled, setAutosaveEnabled] = useState(false);
  const [autosaveVisible, setAutosaveVisible] = useState(false);
  const [autosaveCanToggle, setAutosaveCanToggle] = useState(false);
  const [widgetRefreshKey, setWidgetRefreshKey] = useState(0);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Scroll lock: true when user has scrolled up intentionally. Auto-scroll is suppressed until
  // streaming ends OR user scrolls back to the bottom.
  const userScrolledUpRef = useRef(false);
  // Marks scrolls driven by scrollToBottom() so onScroll ignores them instead of clearing the lock.
  const isProgrammaticScrollRef = useRef(false);
  const promptRef = useRef<PromptFieldHandle>(null);
  const [promptValue, setPromptValue] = useState<string>("");
  const [mentionables, setMentionables] = useState<Mentionable[]>([]);
  // Pending attachments uploaded via the PromptField paperclip; consumed +
  // cleared by the next sendMessage().
  const [pendingAttachments, setPendingAttachments] = useState<LlmAttachmentRef[]>([]);
  const handleAttachmentsSelected = useCallback(async (files: File[]) => {
    const refs: LlmAttachmentRef[] = [];
    for (const file of files) {
      try {
        const r = await fetch("/api/artifacts/upload", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Artifact-Filename": file.name,
            "X-Artifact-Title": file.name,
          },
          body: file,
        });
        const j = (await r.json().catch(() => null)) as
          | { ok?: boolean; ref?: LlmAttachmentRef }
          | null;
        if (r.ok && j?.ok && j.ref) {
          // The server's ArtifactRef is the minimal {artifactId,
          // representationRevisionId, digest, mime, originKind} shape.
          // Enrich with the original File metadata so the host-side
          // providerUpload (attachment-resolver-ports.ts) can pass a
          // real filename to OpenAI/Anthropic/Gemini Files-API
          // — otherwise it falls back to ref.artifactId (a UUID),
          // and OpenAI rejects the file with "context stuffing file
          // type ... but got none" because the .pdf extension is lost.
          refs.push({
            ...j.ref,
            filename: file.name,
            title: file.name,
            size: file.size,
          });
        }
      } catch {
        // Network/parse failures are swallowed; the user can retry the file.
      }
    }
    if (refs.length > 0) {
      setPendingAttachments((prev) => [...prev, ...refs]);
    }
  }, []);
  const { data: session } = authClient.useSession();
  const [isSlackMode, setIsSlackMode] = useState(false);
  const isSlackModeRef = useRef(false);
  const [animating, setAnimating] = useState(false);
  const prevIsSlackModeRef = useRef(false);
  const [taggedAssistantUserIds, setTaggedAssistantUserIds] = useState<string[]>([]);
  const [pausedParticipants, setPausedParticipants] = useState<string[]>([]);
  const [requestEditMessageId, setRequestEditMessageId] = useState<string | null>(null);

  // Maps assistantUserId → @handle by scanning mentions in user messages.
  // Used in Slack mode to show the correct sender name/icon per assistant message.
  const assistantHandleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === "user" && msg.mentions) {
        for (const m of msg.mentions) {
          if (m.assistantUserId && m.handle) map.set(m.assistantUserId, m.handle);
        }
      }
    }
    return map;
  }, [messages]);

  // Keep isSlackModeRef in sync so streamResponse always reads the current value
  // even when called from a stale closure (e.g. the 20-second takeover timer).
  useEffect(() => { isSlackModeRef.current = isSlackMode; }, [isSlackMode]);

  useEffect(() => {
    const shouldBeSlack = taggedAssistantUserIds.length >= 2;
    if (shouldBeSlack && !prevIsSlackModeRef.current) {
      // Live transition — play animation once
      setIsSlackMode(true);
      setAnimating(true);
      prevIsSlackModeRef.current = true;
      const t = window.setTimeout(() => setAnimating(false), 700);
      return () => window.clearTimeout(t);
    }
    if (shouldBeSlack) {
      setIsSlackMode(true);
    }
  }, [taggedAssistantUserIds]);

const skipNextThreadLoadRef = useRef(false);
  // Tracks the thread whose data is currently rendered. Prevents the persist
  // effect from saving stale messages to a new activeThreadId while the async
  // load is still in flight.
  const loadedThreadIdRef = useRef<string | null>(initialThreadId ?? null);
  // Fingerprint of the message list as it was last LOADED for the active
  // thread. The persist effect compares the current fingerprint against this to
  // tell "messages changed because of real activity (user submit / LLM
  // response / edit / external message)" from "messages changed because we just
  // opened/loaded the thread". Only the former advances `updatedAt` and the
  // sidebar position (issue #283). Empty string == nothing loaded yet (a
  // brand-new thread starts empty, so its first user message reads as activity).
  const loadedFingerprintRef = useRef<string>("");
  // The active thread's immutable createdAt as read from the loaded thread
  // data. Used as the createdAt fallback when persisting so the payload's
  // createdAt does not drift to `now`/updatedAt if the local `threads` summary
  // list has not arrived yet (#283 — the typed created_at column is immutable
  // on conflict, but readChatThreadsFromDatabase reads the payload JSON).
  const loadedThreadCreatedAtRef = useRef<string | null>(null);
  // Map of assistantId → AbortController for every in-flight streamResponse call.
  const streamingAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  // Latest-value ref for messages so re-entrant senders never read a stale
  // snapshot when building the next request's context.
  const messagesRef = useRef<Message[]>([]);
  // RunId-keyed registry of OPEN inline HITL gates. Multiple InlineAgentRunCards
  // can mount (one per agent_run tool result); a ref-map keyed by runId prevents
  // an older card from clobbering a newer gate.
  const gateRegistryRef = useRef<Map<string, ChatGateDescriptor>>(new Map());
  const handleActiveGateChange = useCallback(
    (runId: string, gate: ChatGateDescriptor | null, instanceId: string) => {
      if (gate) {
        gateRegistryRef.current.set(runId, gate);
      } else {
        // Clear only if the registry still holds THIS instance. A remounted
        // card for the same runId must not be clobbered by an older instance's
        // unmount.
        const current = gateRegistryRef.current.get(runId);
        if (current && current.instanceId === instanceId) {
          gateRegistryRef.current.delete(runId);
        }
      }
    },
    [],
  );
  // Latest-value ref for the active thread id so in-flight streamResponse coroutines
  // can detect thread switches after an await and no-op their patches.
  const activeThreadIdRef = useRef<string | null>(null);
  const externalReplyTimerRef = useRef<number | null>(null);
  // Tracks whether the user has manually renamed the active thread — prevents auto-title from overriding.
  const titleUserEditedRef = useRef(false);
  const hasMessages = messages.length > 0;

  // Check if the last assistant message has an embedded widget.
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  const activeWidgets = lastAssistantMessage ? widgetRuntime.detectWidgets(lastAssistantMessage.content) : [];
  const hasActiveEmbed = activeWidgets.length > 0;
  const widgetSubmitRef = useRef<WidgetSubmitHandle | null>(null);

  // Load thread list and autosave config on mount.
  useEffect(() => {
    void fetchThreadList().then(setThreads);
    setGreeting(getGreeting());

    void fetch("/api/chat/autosave")
      .then((r) => r.json())
      .then((config: { enabled?: boolean; userCanConfigure?: boolean; userCanSeeIndicator?: boolean }) => {
        setAutosaveEnabled(Boolean(config.enabled));
        setAutosaveCanToggle(Boolean(config.userCanConfigure));
        setAutosaveVisible(Boolean(config.userCanSeeIndicator) || Boolean(config.userCanConfigure));
      })
      .catch(() => {});

    let mentionablesCancelled = false;
    void fetch("/api/assistants/list")
      .then((r) => (r.ok ? r.json() : { assistants: [] }))
      .then((data: { assistants?: { id: string; handle: string }[] }) => {
        if (!mentionablesCancelled && Array.isArray(data.assistants)) {
          setMentionables(data.assistants.map((a) => ({ ...a, displayName: a.handle })));
        }
      })
      .catch((err) => {
        console.error("[chat] failed to load assistants for @-mention flyout:", err);
      });

    function resetSlackMode() {
      setIsSlackMode(false);
      setAnimating(false);
      setTaggedAssistantUserIds([]);
      setPausedParticipants([]);
      prevIsSlackModeRef.current = false;
    }

    function handleNewChat() {
      const wasInThread = !!activeThreadIdRef.current || messagesRef.current.length > 0;
      setActiveThreadId(null);
      setMessages([]);
      resetSlackMode();
      promptRef.current?.clear();
      setEditingTitle(false);
      // Only change the greeting when leaving an active thread — avoids visible flicker
      // when clicking "New chat" while already at the empty state.
      if (wasInThread) setGreeting(getGreeting());
      void fetchThreadList().then(setThreads);
      if (window.location.pathname !== "/chat") {
        window.history.pushState(null, "", "/chat");
      }
    }

    function handlePopState() {
      promptRef.current?.clear();
      const match = window.location.pathname.match(/^\/chat\/([a-f0-9-]{36})$/);
      if (match) {
        setActiveThreadId(match[1]);
        setEditingTitle(false);
      } else {
        setActiveThreadId(null);
        setMessages([]);
        resetSlackMode();
        setEditingTitle(false);
        setGreeting(getGreeting());
      }
    }

    function handleSelectThread(e: Event) {
      const { threadId } = (e as CustomEvent<{ threadId: string }>).detail;
      promptRef.current?.clear();
      setActiveThreadId(threadId);
      setEditingTitle(false);
      window.history.pushState(null, "", `/chat/${threadId}`);
    }

    window.addEventListener("cinatra:chat:new", handleNewChat);
    window.addEventListener("cinatra:chat:select", handleSelectThread);
    window.addEventListener("popstate", handlePopState);
    return () => {
      mentionablesCancelled = true;
      window.removeEventListener("cinatra:chat:new", handleNewChat);
      window.removeEventListener("cinatra:chat:select", handleSelectThread);
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  // Keep messagesRef in sync with state so re-entrant callers read the latest value.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Keep activeThreadIdRef in sync so streamResponse can detect thread switches.
  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  // Notify ChatThreadPanel of the active thread so it can highlight without router navigation.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("cinatra:chat:active-changed", { detail: { threadId: activeThreadId } }),
    );
  }, [activeThreadId]);

  // Load thread messages when activeThreadId changes.
  useEffect(() => {
    // Defense in depth: eagerly abort every in-flight stream when the
    // active thread changes. The stillOnOriginThread guard inside
    // streamResponse also short-circuits any late setMessages chunks that arrive
    // after this point, so even if an aborted stream's final reader.read() resolves
    // mid-switch, it cannot mutate the new thread's messages list.
    if (streamingAbortControllersRef.current.size > 0) {
      for (const c of streamingAbortControllersRef.current.values()) c.abort();
      streamingAbortControllersRef.current.clear();
      setStreamingCount(0);
    }
    if (skipNextThreadLoadRef.current) {
      skipNextThreadLoadRef.current = false;
      return;
    }
    if (!activeThreadId) {
      loadedThreadIdRef.current = null;
      loadedFingerprintRef.current = "";
      loadedThreadCreatedAtRef.current = null;
      setMessages([]);
      setIsSlackMode(false);
      setAnimating(false);
      setTaggedAssistantUserIds([]);
      setPausedParticipants([]);
      prevIsSlackModeRef.current = false;
      return;
    }
    void fetchThreadById(activeThreadId).then((thread) => {
      if (thread) {
        // Backfill missing ids — threads stored before the id field was added won't have them,
        // causing key={undefined} in the messages list and React's missing-key warning.
        // Build the loaded array ONCE and reuse it for both setMessages and the
        // activity fingerprint: re-mapping a second time would mint different
        // backfilled ids and make a pure open look like real activity (#283).
        const loadedMessages = thread.messages.map((m) => ({ ...m, id: m.id || generateId() }));
        setMessages(loadedMessages);
        // Restore active assistant handle so subsequent messages route correctly.
        setActiveAssistantHandle(thread.activeAssistantHandle);
        // Synchronise Slack-mode state on cold reload. Set prevIsSlackModeRef.current
        // BEFORE setTaggedAssistantUserIds so the transition-detection useEffect does
        // not detect a false→true transition on mount (no animation on cold load).
        const slackIds = thread.taggedAssistantUserIds ?? [];
        // slackMode flag overrides the taggedAssistantUserIds heuristic — threads
        // that entered Slack mode via a @human-user mention (no assistantUserId) have
        // slackIds=[] but slackMode=true, so the mode is correctly restored on reload.
        const restoredSlack = (thread as unknown as { slackMode?: boolean }).slackMode ?? (slackIds.length > 0);
        prevIsSlackModeRef.current = restoredSlack; // skip animation on cold load
        setTaggedAssistantUserIds(slackIds);
        setIsSlackMode(restoredSlack);
        setPausedParticipants((thread as unknown as { pausedParticipants?: string[] }).pausedParticipants ?? []);
        // Snapshot the loaded messages' fingerprint so the persist effect can
        // tell this load echo apart from real activity and NOT bump updatedAt
        // (and the sidebar position) on a plain open (#283). Uses the SAME
        // loadedMessages array that was handed to setMessages.
        loadedFingerprintRef.current = fingerprintMessages(loadedMessages);
        // Remember the thread's immutable createdAt so a later persist never
        // rewrites it even if the threads-summary list has not loaded yet.
        loadedThreadCreatedAtRef.current =
          (thread as unknown as { createdAt?: string }).createdAt ?? null;
        // Mark this thread's data as fully loaded — unblocks the persist effect.
        loadedThreadIdRef.current = activeThreadId;
      }
    });
  }, [activeThreadId]);

  // Poll the active thread for externally-written messages (e.g. from the
  // chat_thread_send MCP tool). Uses window.setInterval per codebase convention.
  useEffect(() => {
    if (!activeThreadId) return;
    if (hasActiveStream) return;

    const intervalId = window.setInterval(() => {
      void fetchThreadById(activeThreadId).then((thread) => {
        if (!thread) return;
        setMessages((prev) => {
          if (thread.messages.length <= prev.length) return prev;
          // Backfill missing ids — same pattern as the thread-load effect.
          return thread.messages.map((m) => ({ ...m, id: m.id || generateId() }));
        });
        // Sync tagged assistant IDs so externally-added tags (e.g. via MCP) are reflected.
        const serverIds = thread.taggedAssistantUserIds ?? [];
        if (serverIds.length > 0) {
          setTaggedAssistantUserIds((prev) => {
            if (serverIds.length === prev.length && serverIds.every((id, i) => id === prev[i])) return prev;
            return serverIds;
          });
        }
      });
    }, 3000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeThreadId, hasActiveStream]);

  // Clear the pending-external-reply state as soon as an assistant message arrives
  // (either from the external assistant via polling, or from the @cinatra fallback).
  useEffect(() => {
    if (!pendingExternalHandle) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "assistant") {
      setPendingExternalHandle(null);
      if (externalReplyTimerRef.current) {
        clearTimeout(externalReplyTimerRef.current);
        externalReplyTimerRef.current = null;
      }
    }
  }, [messages, pendingExternalHandle]);

  // Poll the thread list so new conversations created externally (e.g. via MCP) appear in the
  // sidebar without a reload. Runs always (not gated on activeThreadId) at a slower cadence.
  useEffect(() => {
    if (hasActiveStream) return;
    const intervalId = window.setInterval(() => {
      void fetchThreadList().then((fresh) => {
        setThreads((prev) => {
          if (fresh.length !== prev.length) return fresh;
          const freshTop = fresh.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.updatedAt;
          const prevTop = prev.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.updatedAt;
          return freshTop !== prevTop ? fresh : prev;
        });
      });
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [hasActiveStream]);

  // Notify the thread panel whenever the thread list changes.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("cinatra:chat:threads-changed", { detail: threads }));
  }, [threads]);

  const scrollToBottom = useCallback(() => {
    if (messagesContainerRef.current && !userScrolledUpRef.current) {
      isProgrammaticScrollRef.current = true;
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      // Clear the flag after the scroll event fired by this assignment has been processed.
      requestAnimationFrame(() => { isProgrammaticScrollRef.current = false; });
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingCount, pendingExternalHandle, typingIndicators, scrollToBottom]);

  // Re-enable auto-scroll when streaming completes so the next response scrolls normally.
  const prevHasActiveStreamRef = useRef(false);
  useEffect(() => {
    if (prevHasActiveStreamRef.current && !hasActiveStream) {
      userScrolledUpRef.current = false;
    }
    prevHasActiveStreamRef.current = hasActiveStream;
  }, [hasActiveStream]);

  // Hydrate shiki placeholders after render — replace fallback <pre> blocks with
  // syntax-highlighted HTML loaded lazily from shiki.
  useEffect(() => {
    const placeholders = document.querySelectorAll<HTMLElement>("[data-shiki-code]");
    if (placeholders.length === 0) return;
    placeholders.forEach((el) => {
      // URL-encoded raw source (UTF-safe, set in the code() renderer).
      const code = decodeURIComponent(el.dataset.shikiCode ?? "");
      const lang = el.dataset.shikiLang ?? "text";
      const elTheme = (el.dataset.shikiTheme ?? "github-light") as ThemeName;
      void highlightCodeAsync(code, lang, elTheme).then((html) => {
        if (!html) return;
        const pre = el.querySelector("pre");
        if (!pre) return;
        const temp = document.createElement("div");
        temp.innerHTML = html;
        const shikiPre = temp.querySelector("pre");
        if (shikiPre) {
          // Preserve our layout classes on the <pre> element.
          shikiPre.classList.add("overflow-x-auto", "whitespace-pre", "p-4", "text-[0.8rem]", "leading-relaxed", "font-mono");
          pre.replaceWith(shikiPre);
        }
        el.removeAttribute("data-shiki-code");
      });
    });
  }, [messages, hasActiveStream, theme]);

  // Return focus to the prompt input after streaming completes.
  useEffect(() => {
    if (!hasActiveStream) promptRef.current?.focus();
  }, [hasActiveStream]);

  // Pre-fill prompt with ?mention=handle when navigating from a profile "Chat now" button.
  useEffect(() => {
    if (!initialMention) return;
    // Wait one tick so the prompt field has mounted and registered its ref.
    const id = setTimeout(() => {
      promptRef.current?.setValue(`@${initialMention} `);
    }, 50);
    return () => clearTimeout(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill prompt with a workflow-task handoff (?wf=&task= from the Gantt
  // "Open in chat" action). Mention wins if both are present (mention is the
  // more specific intent).
  useEffect(() => {
    if (initialMention || !initialPrompt) return;
    const id = setTimeout(() => {
      promptRef.current?.setValue(initialPrompt);
    }, 50);
    return () => clearTimeout(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist thread on real conversational activity (debounced via hasActiveStream).
  useEffect(() => {
    if (!activeThreadId || messages.length === 0) return;
    if (hasActiveStream) return; // Wait until streaming finishes.
    // Bail out if the thread load is still in flight — prevents saving stale
    // messages (from the previous thread) to the newly-selected activeThreadId.
    if (loadedThreadIdRef.current !== activeThreadId) return;
    // Bail out if the messages are identical to what was loaded for this thread
    // — i.e. this effect fired only because opening/selecting the thread set the
    // messages. A passive open must NOT advance updatedAt or reorder the sidebar
    // (#283); only real activity (user submit, LLM response, edit, externally
    // added message) changes the fingerprint and falls through here.
    if (!isRealActivity(loadedFingerprintRef.current, messages)) return;

    const existing = threads.find((t) => t.id === activeThreadId);
    const updatedAt = new Date().toISOString();
    const thread: Thread = {
      id: activeThreadId,
      title: existing?.title
        ?? deriveThreadTitle(messages.find((m) => m.role === "user")?.content ?? ""),
      messages,
      // createdAt is immutable — never derive it from updatedAt (that conflation
      // made the "created" timestamp drift on every save, #283). Prefer the
      // local summary, then the loaded thread's createdAt (covers the case where
      // the summary list has not arrived), and only fall back to updatedAt for a
      // genuinely new thread that has no createdAt anywhere.
      createdAt: existing?.createdAt ?? loadedThreadCreatedAtRef.current ?? updatedAt,
      updatedAt,
      activeAssistantHandle,
      taggedAssistantUserIds,
      slackMode: isSlackMode,
      ownerUserId: userId,
    };
    saveChatThreadViaFetch(thread).catch(() => {});
    // Real activity: advance this thread's updatedAt in-place. The sidebar's
    // default "Activity" mode sorts by updatedAt desc, so this re-positions the
    // thread to the top without an explicit array reorder here.
    setThreads((prev) =>
      prev.map((t) =>
        t.id === thread.id ? { ...t, title: thread.title, updatedAt: thread.updatedAt } : t,
      ),
    );
    // Adopt the persisted message set as the new baseline so an unrelated
    // re-render with the SAME messages does not bump updatedAt a second time.
    loadedFingerprintRef.current = fingerprintMessages(messages);
  }, [messages, hasActiveStream, activeThreadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Emit active thread title so AppShell can show it in the breadcrumb.
  useEffect(() => {
    const title = threads.find((t) => t.id === activeThreadId)?.title ?? null;
    publishChatThreadTitle(title);
  }, [activeThreadId, threads]);

  function pushChatUrl(threadId: string | null) {
    const url = threadId ? `/chat/${threadId}` : "/chat";
    window.history.pushState(null, "", url);
  }

  function startNewThread() {
    setActiveThreadId(null);
    setMessages([]);
    setActiveAssistantHandle(undefined);
    setPendingExternalHandle(null);
    if (externalReplyTimerRef.current) {
      clearTimeout(externalReplyTimerRef.current);
      externalReplyTimerRef.current = null;
    }
    promptRef.current?.clear();
    setEditingTitle(false);
    setGreeting(getGreeting());
    titleUserEditedRef.current = false;
    pushChatUrl(null);
  }

  function selectThread(id: string) {
    setPendingExternalHandle(null);
    if (externalReplyTimerRef.current) {
      clearTimeout(externalReplyTimerRef.current);
      externalReplyTimerRef.current = null;
    }
    setActiveThreadId(id);
    setEditingTitle(false);
    titleUserEditedRef.current = false;
    pushChatUrl(id);
  }

  function handleDeleteThread(id: string) {
    deleteChatThread(id).catch(() => {});
    setThreads((prev) => prev.filter((t) => t.id !== id));
    if (activeThreadId === id) {
      startNewThread();
    }
  }

  function handleDeleteAllThreads() {
    deleteAllChatThreads().catch(() => {});
    setThreads([]);
    startNewThread();
    setSidebarOpen(false);
  }

  function handleRenameThread() {
    if (!activeThreadId || !titleDraft.trim()) {
      setEditingTitle(false);
      return;
    }
    const newTitle = titleDraft.trim();
    const now = new Date().toISOString();
    const existing = threads.find((t) => t.id === activeThreadId);
    // A title-only edit is NOT conversational activity: preserve the thread's
    // existing updatedAt (and immutable createdAt) so renaming does not bump the
    // thread to the top of the activity-sorted sidebar (#283).
    const preservedUpdatedAt = existing?.updatedAt ?? now;
    // Save updated title to API — build full thread from current state.
    const thread: Thread = {
      id: activeThreadId,
      title: newTitle,
      messages,
      createdAt: existing?.createdAt ?? loadedThreadCreatedAtRef.current ?? now,
      updatedAt: preservedUpdatedAt,
      ownerUserId: userId,
    };
    saveChatThreadViaFetch(thread).catch(() => {});
    setThreads((prev) =>
      prev.map((t) => (t.id === activeThreadId ? { ...t, title: newTitle } : t)),
    );
    setEditingTitle(false);
    titleUserEditedRef.current = true;
  }

  // Register a stream in the registry and bump the count. Must only be called
  // from inside streamResponse's try block so cleanup is guaranteed in finally.
  function beginStream(assistantId: string, controller: AbortController) {
    streamingAbortControllersRef.current.set(assistantId, controller);
    setStreamingCount((n) => n + 1);
  }

  // Remove a stream from the registry and decrement the count. Idempotent —
  // safe to call even if the key was already deleted (returns without side effect).
  function endStream(assistantId: string) {
    if (streamingAbortControllersRef.current.delete(assistantId)) {
      setStreamingCount((n) => Math.max(0, n - 1));
    }
  }

  async function streamResponse(contextMessages: Message[], handle?: string, endpoint = "/api/chat", authorUserId?: string) {
    const assistantId = generateId();
    const abortController = new AbortController();
    // Capture the thread that spawned this stream. Every async patch below
    // short-circuits if the active thread has changed since we started.
    const originThreadId = activeThreadIdRef.current;
    // Per-stream paragraph-break tracker. Must be function-local so two
    // concurrent streams cannot corrupt each other's separator state.
    let nextTextNeedsRoundSeparator = false;
    // Read Slack mode from the ref so stale closures (e.g. the 20-second takeover timer)
    // always see the current value rather than the value at the time sendMessage was called.
    const isSlack = isSlackModeRef.current;

    // Helper: returns true iff the thread that spawned this stream is still
    // the active thread. Every setMessages callback inside the SSE loop calls
    // this and returns `prev` unchanged when it fires false — the stream has
    // been orphaned by a thread switch and must not mutate the new thread.
    const stillOnOriginThread = () => activeThreadIdRef.current === originThreadId;

    // Slack-mode accumulation buffers. Declared before try so they are accessible in finally.
    let textBuffer = "";
    const bufferedThoughtGroups: ThoughtGroup[] = [];
    let bufferedCitations: Citation[] = [];
    let bufferedError = "";
    // Error from catch block — declared before try so finally can read it.
    let caughtError = "";

    try {
      // Register the stream AFTER local declarations and BEFORE any await.
      // If any statement above throws (it can't — they're all synchronous
      // constant/local declarations), no registry leak is possible.
      beginStream(assistantId, abortController);

      if (isSlack) {
        // Slack mode: show a per-assistant typing indicator instead of an empty bubble.
        setTypingIndicators((prev) => {
          const m = new Map(prev);
          m.set(assistantId, handle ?? "Assistant");
          return m;
        });
      } else {
        // ChatGPT mode: append the empty assistant bubble immediately (unchanged behavior).
        setMessages((prev) => {
          if (!stillOnOriginThread()) return prev;
          return [...prev, { id: assistantId, role: "assistant", content: "", thoughtGroups: [], parts: [], liveStatus: "Thinking", ...(authorUserId ? { authorUserId } : {}) }];
        });
      }

      const apiMessages = contextMessages.map((m) => ({
        role: m.role,
        content: m.content,
        // Forward attachments only when present so every text-only message
        // remains byte-identical.
        ...(m.attachments && m.attachments.length > 0
          ? { attachments: m.attachments }
          : {}),
      }));
      const chatBody = JSON.stringify({ messages: apiMessages });

      // Retry once on network errors (TypeError: Failed to fetch). This handles
      // Turbopack's lazy compilation window: the first request to /api/chat after
      // a server restart may fail while the large module graph is being compiled.
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: chatBody,
          signal: abortController.signal,
        });
      } catch (fetchErr) {
        if (abortController.signal.aborted) throw fetchErr;
        // Network error — wait briefly and retry once
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        if (abortController.signal.aborted) throw fetchErr;
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: chatBody,
          signal: abortController.signal,
        });
      }

      // After the initial network await, verify we're still on the origin thread
      // AND not already aborted. If the user switched threads during the POST
      // handshake, exit silently — no state mutation, no error toast.
      if (abortController.signal.aborted || !stillOnOriginThread()) {
        return;
      }

      if (!response.ok) throw new Error("Chat request failed.");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response stream.");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (abortController.signal.aborted || !stillOnOriginThread()) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const m = block.match(/^event: (\w+)\ndata: ([\s\S]+)$/);
          if (!m) continue;

          const [, evt, raw] = m;
          let d: Record<string, unknown>;
          try { d = JSON.parse(raw); } catch { continue; }

          if (evt === "text") {
            const delta = String(d.content ?? "");
            // Read-and-clear the round-boundary flag HERE (event loop scope), not
            // inside the setMessages updater. React may invoke functional state
            // updaters multiple times (StrictMode dev double-invoke; automatic
            // batching can replay them) — mutating an outer-scope variable inside
            // the updater is unsafe. The first invocation flipped the flag to
            // false; the second invocation (the one whose return value React kept)
            // saw flag=false and skipped the separator. Result: "...new.I found"
            // with no whitespace between sentences. Consuming the flag here, in
            // the SSE handler (which runs exactly once per event), makes the
            // updater itself a pure function of `prev`.
            const consumeRoundSeparator = nextTextNeedsRoundSeparator;
            if (consumeRoundSeparator) {
              nextTextNeedsRoundSeparator = false;
            }
            if (!delta) {
              // Skip — no state change.
            } else if (!isSlack) {
              setMessages((prev) => {
                if (!stillOnOriginThread()) return prev;
                return prev.map((msg) => {
                  if (msg.id !== assistantId) return msg;
                  const existing = msg.content;
                  // A paragraph break is inserted when text resumes after a
                  // tool-use round (signalled by thinking_end). Never insert
                  // spaces between normal streaming chunks — providers split
                  // tokens arbitrarily and adding spaces breaks markdown
                  // formatting like **bold**.
                  const separator =
                    consumeRoundSeparator && existing.length > 0 && !/\s$/.test(existing)
                      ? "\n\n"
                      : "";
                  const deltaWithSeparator = separator + delta;
                  // Maintain the ordered `parts` trace via the pure helper so
                  // behaviour matches the tested contract (assistant-parts.ts).
                  const nextParts = applyTextDelta(msg.parts ?? [], deltaWithSeparator);
                  const latestTextPart = nextParts.findLast((part) => part.kind === "text");
                  const liveStatus = latestTextPart && hasVisibleStreamingText(latestTextPart.content)
                    ? undefined
                    : msg.liveStatus;
                  return { ...msg, content: existing + deltaWithSeparator, parts: nextParts, liveStatus };
                });
              });
            } else {
              // Slack mode: accumulate into buffer instead of updating state per-chunk.
              if (delta) {
                const separator =
                  consumeRoundSeparator && textBuffer.length > 0 && !/\s$/.test(textBuffer)
                    ? "\n\n"
                    : "";
                textBuffer += separator + delta;
              }
            }
          } else if (evt === "thinking_start") {
            if (!isSlack) {
              setMessages((prev) => {
                if (!stillOnOriginThread()) return prev;
                return prev.map((msg) => {
                  if (msg.id !== assistantId) return msg;
                  if (msg.thoughtGroups && msg.thoughtGroups.length > 0) {
                    return { ...msg, liveStatus: "Thinking" };
                  }
                  return { ...msg, thoughtGroups: [{ id: "main", toolCalls: [] }], liveStatus: "Thinking" };
                });
              });
            } else {
              if (bufferedThoughtGroups.length === 0) {
                bufferedThoughtGroups.push({ id: "main", toolCalls: [] });
              }
            }
          } else if (evt === "thinking_end") {
            const seconds = Number(d.seconds) || 0;
            if (!isSlack) {
              setMessages((prev) => {
                if (!stillOnOriginThread()) return prev;
                return prev.map((msg) => {
                  if (msg.id !== assistantId) return msg;
                  const group = msg.thoughtGroups?.[0];
                  if (!group) return msg;
                  return { ...msg, thoughtGroups: [{ ...group, thinkingSeconds: (group.thinkingSeconds ?? 0) + seconds }] };
                });
              });
            } else {
              const lastGroup = bufferedThoughtGroups[bufferedThoughtGroups.length - 1];
              if (lastGroup) {
                lastGroup.thinkingSeconds = (lastGroup.thinkingSeconds ?? 0) + seconds;
              }
            }
            nextTextNeedsRoundSeparator = true;
          } else if (evt === "tool_call") {
            const tcServerLabel = typeof d.serverLabel === "string" ? d.serverLabel : undefined;
            if (!isSlack) {
              setMessages((prev) => {
                if (!stillOnOriginThread()) return prev;
                return prev.map((msg) => {
                  if (msg.id !== assistantId) return msg;
                  const group = msg.thoughtGroups?.[0] ?? { id: "main", toolCalls: [] };
                  // Dedupe by id (defensive — server retry safety).
                  if (group.toolCalls.some((tc) => tc.id === String(d.id))) return msg;
                  // Maintain `parts` via the pure helper. Same dedupe contract
                  // is enforced inside the helper.
                  const nextParts = applyToolCallEvent(msg.parts ?? [], {
                    id: String(d.id),
                    name: String(d.name),
                    serverLabel: tcServerLabel,
                  });
                  return {
                    ...msg,
                    thoughtGroups: [{ ...group, toolCalls: [...group.toolCalls, { id: String(d.id), name: String(d.name), status: "running" as const, serverLabel: tcServerLabel }] }],
                    parts: nextParts,
                    liveStatus: formatToolProgressStatus({ id: String(d.id), name: String(d.name), status: "running", serverLabel: tcServerLabel }),
                  };
                });
              });
            } else {
              const lastGroup = bufferedThoughtGroups[bufferedThoughtGroups.length - 1] ?? { id: "main", toolCalls: [] };
              if (bufferedThoughtGroups.length === 0) bufferedThoughtGroups.push(lastGroup);
              if (!lastGroup.toolCalls.some((tc) => tc.id === String(d.id))) {
                lastGroup.toolCalls.push({ id: String(d.id), name: String(d.name), status: "running" as const, serverLabel: tcServerLabel });
              }
            }
          } else if (evt === "tool_result") {
            const toolName = String(d.name ?? "");
            if (widgetRuntime.isWidgetRefreshTool(toolName)) {
              setWidgetRefreshKey((k) => k + 1);
            }
            const trServerLabel = typeof d.serverLabel === "string" ? d.serverLabel : undefined;
            // When the resolved tool is agent_run, parse the `result` JSON
            // (the server emits JSON.stringify({runId, status})) and pin runId
            // on the matching tool_call part so the renderer can mount
            // <InlineAgentRunCard runId={...} /> inline beneath the assistant
            // message. Defensive: any parse failure is silent.
            let extractedRunId: string | undefined;
            if (toolName === "agent_run" && typeof d.result === "string") {
              try {
                const parsed = JSON.parse(d.result) as { runId?: unknown };
                if (typeof parsed.runId === "string" && parsed.runId.length > 0) {
                  extractedRunId = parsed.runId;
                }
              } catch {
                // No-op — chat dispatch will still render the regular
                // tool-call status line.
              }
            }
            if (!isSlack) {
              setMessages((prev) => {
                if (!stillOnOriginThread()) return prev;
                return prev.map((msg) => {
                  if (msg.id !== assistantId) return msg;
                  const group = msg.thoughtGroups?.[0];
                  if (!group) return msg;
                  // Apply via pure helper so behaviour matches the tested
                  // contract (preserves existing serverLabel when the event
                  // omits one; no-op when no matching tool_call exists).
                  const nextParts = msg.parts
                    ? applyToolResultEvent(msg.parts, {
                        id: String(d.id),
                        resultLabel: String(d.resultLabel ?? ""),
                        serverLabel: trServerLabel,
                        runId: extractedRunId,
                      })
                    : undefined;
                  return {
                    ...msg,
                    thoughtGroups: [{
                      ...group,
                      toolCalls: group.toolCalls.map((tc) =>
                        tc.id === String(d.id)
                          ? {
                              ...tc,
                              status: "completed" as const,
                              resultLabel: String(d.resultLabel ?? ""),
                              // Preserve serverLabel when the event doesn't
                              // supply one — matches the tested helper contract.
                              serverLabel: trServerLabel ?? tc.serverLabel,
                            }
                          : tc,
                      ),
                    }],
                    ...(nextParts ? { parts: nextParts } : {}),
                    liveStatus: "Reviewing tool results",
                  };
                });
              });
            } else {
              const lastGroup = bufferedThoughtGroups[bufferedThoughtGroups.length - 1];
              if (lastGroup) {
                const tc = lastGroup.toolCalls.find((t) => t.id === String(d.id));
                if (tc) {
                  tc.status = "completed";
                  tc.resultLabel = String(d.resultLabel ?? "");
                  // Preserve serverLabel when the event omits one — matches
                  // the tested `applyToolResultEvent` helper contract and the
                  // ChatGPT-mode branch above. Without this, external
                  // connector badges (e.g. "WordPress · …") get relabelled
                  // to generic "Tool · …" on completion in Slack mode.
                  if (trServerLabel !== undefined) tc.serverLabel = trServerLabel;
                }
              }
            }
          } else if (evt === "citations") {
            const incoming = Array.isArray(d.citations) ? (d.citations as unknown[]) : [];
            const normalized: Citation[] = incoming
              .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
              .map((c, i) => ({
                index: typeof c.index === "number" && isFinite(c.index) ? c.index : i + 1,
                title: typeof c.title === "string" ? c.title : "",
                url: typeof c.url === "string" ? c.url : "",
              }))
              .filter((c) => c.url.length > 0);
            if (normalized.length > 0) {
              if (!isSlack) {
                setMessages((prev) => {
                  if (!stillOnOriginThread()) return prev;
                  return prev.map((msg) => {
                    if (msg.id !== assistantId) return msg;
                    const merged = [...(msg.citations ?? []), ...normalized];
                    const seen = new Set<string>();
                    const unique = merged.filter((c) => {
                      if (seen.has(c.url)) return false;
                      seen.add(c.url);
                      return true;
                    });
                    return { ...msg, citations: unique };
                  });
                });
              } else {
                const merged = [...bufferedCitations, ...normalized];
                const seen = new Set<string>();
                bufferedCitations = merged.filter((c) => {
                  if (seen.has(c.url)) return false;
                  seen.add(c.url);
                  return true;
                });
              }
            }
          } else if (evt === "error") {
            const rawError = String(d.message ?? "");
            if (!isSlack) {
              setMessages((prev) => {
                if (!stillOnOriginThread()) return prev;
                return prev.map((msg) => msg.id === assistantId ? { ...msg, error: extractErrorMessage(rawError), errorRaw: rawError } : msg);
              });
            } else {
              bufferedError = extractErrorMessage(rawError);
              break;
            }
          }
        }
      }

      // Slack mode: reveal the fully buffered message in one atomic setMessages call.
      // Intentionally does NOT populate `parts` — Slack reveals atomically so it
      // doesn't have the visually-divorced-progress problem the chat UI does.
      // The renderer's fallback to `thoughtGroups + content` runs for these
      // messages. If Slack ever moves to streamed reveal, also build a parts
      // trace here (cf. ChatGPT mode's event handlers above).
      if (isSlack && stillOnOriginThread() && (textBuffer.length > 0 || bufferedThoughtGroups.length > 0 || bufferedError.length > 0)) {
        setMessages((prev) => {
          if (!stillOnOriginThread()) return prev;
          return [...prev, {
            id: assistantId,
            role: "assistant" as const,
            content: textBuffer,
            ...(authorUserId ? { authorUserId } : {}),
            ...(bufferedThoughtGroups.length > 0 ? { thoughtGroups: bufferedThoughtGroups } : {}),
            ...(bufferedCitations.length > 0 ? { citations: bufferedCitations } : {}),
            ...(bufferedError.length > 0 ? { error: bufferedError } : {}),
          }];
        });
      }
    } catch (error) {
      // Internal error boundary — streamResponse MUST NOT rethrow because
      // callers dispatch it as `void streamResponse(...)` and unhandled promise
      // rejections would leak and leave streamingCount stuck.
      if (error instanceof Error && error.name === "AbortError") {
        // User clicked stop or thread switch aborted — clean exit, no toast.
      } else {
        const rawError = error instanceof Error ? error.stack ?? error.message : "Something went wrong.";
        if (!isSlack) {
          setMessages((prev) => {
            if (!stillOnOriginThread()) return prev;
            return prev.map((msg) =>
              msg.id === assistantId
                ? { ...msg, error: error instanceof Error ? error.message : "Something went wrong.", errorRaw: rawError }
                : msg,
            );
          });
        } else {
          caughtError = error instanceof Error ? error.message : "Something went wrong.";
        }
      }
      // Do NOT rethrow. Swallow.
    } finally {
      if (isSlack) {
        // Remove this assistant's typing indicator bubble.
        setTypingIndicators((prev) => {
          const m = new Map(prev);
          m.delete(assistantId);
          return m;
        });
        // If a non-abort error occurred and we didn't already insert a content bubble, insert an error bubble.
        if (caughtError && stillOnOriginThread()) {
          setMessages((prev) => {
            if (!stillOnOriginThread()) return prev;
            const alreadyInserted = prev.some((m) => m.id === assistantId);
            if (alreadyInserted) return prev;
            return [...prev, { id: assistantId, role: "assistant" as const, content: "", error: caughtError }];
          });
        }
      }
      // Sole cleanup — guarantees Map/count stay in sync even on unexpected errors.
      endStream(assistantId);
    }
  }

  async function submitEmbed() {
    const ok = await widgetSubmitRef.current?.submit();
    if (!ok) return;

    // Determine which widget was just saved.
    const currentWidget = activeWidgets[0];
    const currentWidgetId = currentWidget?.widgetId ?? "";
    const resourceId = currentWidget?.resourceId ?? "";
    const label = widgetRuntime.wizardStepLabel(currentWidgetId) ?? "Configuration saved.";
    const nextWidgetId = widgetRuntime.getNextWizardStep(currentWidgetId);

    if (nextWidgetId && resourceId) {
      // Advance to next wizard step — embed the next widget directly, no API call.
      const embedTag = `[widget:${nextWidgetId}:${resourceId}]`;
      const confirmMsg: Message = { id: generateId(), role: "assistant", content: `${label}\n\n${embedTag}` };
      setMessages((prev) => [...prev, confirmMsg]);
    } else if (resourceId && widgetRuntime.isWizardStep(currentWidgetId)) {
      // Last wizard step — show confirmation prompt using manifest config.
      const manifest = widgetRuntime.getWizardManifest(currentWidgetId);
      const confirmType = manifest?.wizard?.confirmation.resourceType ?? "resource";
      const confirmTag = `[confirm-${confirmType}:${resourceId}]`;
      const confirmMsg: Message = { id: generateId(), role: "assistant", content: `${label}\n\n${confirmTag}` };
      setMessages((prev) => [...prev, confirmMsg]);
    } else {
      // Non-wizard widget — confirm and let the model continue.
      const confirmMsg: Message = { id: generateId(), role: "assistant", content: label };
      const updatedMessages = [...messages, confirmMsg];
      setMessages(updatedMessages);
      await streamResponse(updatedMessages);
    }
  }

  async function activateResource(resourceType: string, resourceId: string) {
    const manifest = widgetRuntime.findManifestByConfirmationResourceType(resourceType);
    if (!manifest?.wizard) return;

    const endpoint = manifest.wizard.confirmation.activateEndpoint.replace("{resourceId}", resourceId);
    const response = await fetch(endpoint, { method: "POST" });
    if (!response.ok) {
      const errorMsg: Message = { id: generateId(), role: "assistant", content: "Failed to create. Please try again." };
      setMessages((prev) => [...prev, errorMsg]);
      return;
    }

    const result = await response.json().catch(() => ({})) as { resourceId?: string };
    const realId = result.resourceId ?? resourceId;
    const successMessage = `${manifest.wizard.confirmation.successMessage} The ${resourceType} ID is ${realId}. Continue with the next steps.`;
    const confirmMsg: Message = { id: generateId(), role: "assistant", content: successMessage };
    const updatedMessages = [...messages, confirmMsg];
    setMessages(updatedMessages);
    await streamResponse(updatedMessages);
  }

  async function editAndResend(messageId: string, newContent: string) {
    if (!newContent.trim()) return;
    // In ChatGPT mode, keep the existing single-stream block; in Slack mode concurrent streams are allowed.
    if (!isSlackMode && hasActiveStream) return;

    // Truncate conversation at the edited message and replace it.
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const prior = messages.slice(0, idx);
    // Preserve attachments from the original turn so editing the text doesn't
    // silently drop the file refs from the persisted thread + the re-dispatched
    // user message.
    const original = messages[idx];
    const editedMessage: Message = {
      id: generateId(),
      role: "user",
      content: newContent.trim(),
      ...(original?.attachments && original.attachments.length > 0
        ? { attachments: original.attachments }
        : {}),
    };
    const truncated = [...prior, editedMessage];
    setMessages(truncated);

    // Resolve threadId — edits always happen in an existing thread.
    const threadId = activeThreadId ?? activeThreadIdRef.current;

    // Persist the truncated history before routing (same as sendMessage).
    if (threadId) {
      const now = new Date().toISOString();
      const title = threads.find((t) => t.id === threadId)?.title ?? deriveThreadTitle(editedMessage.content);
      // createdAt is immutable: prefer the summary, then the loaded thread's
      // createdAt (covers the body loading before the summary list), then now
      // for a genuinely new thread (#283).
      const createdAt = threads.find((t) => t.id === threadId)?.createdAt ?? loadedThreadCreatedAtRef.current ?? now;
      saveChatThreadViaFetch({ id: threadId, title, messages: truncated, createdAt, updatedAt: now, activeAssistantHandle, taggedAssistantUserIds, slackMode: isSlackMode, ownerUserId: userId } as Record<string, unknown> & { id: string })
        .catch((err) => console.error("[chat] saveChatThread failed (edit):", err));
    }

    // ChatGPT (normal) mode — preserve byte-identical behavior.
    if (!isSlackMode) {
      await streamResponse(truncated);
      return;
    }

    // Slack mode — always regenerate. Use routing to pick the right endpoint; fall back to /api/chat.
    let editEndpoint = "/api/chat";
    let editHandle: string | undefined = activeAssistantHandle;
    let editAuthorId: string | undefined;

    try {
      const routing = await resolveMessageRouting(
        editedMessage.content,
        threadId,
        activeAssistantHandle,
        {
          taggedAssistantUserIds,
          pausedParticipants,
          handleMap: Object.fromEntries(assistantHandleMap),
        },
      );
      if (routing.chatEndpoint) editEndpoint = routing.chatEndpoint;
      const nextHandle = routing.activeHandle !== undefined ? (routing.activeHandle || undefined) : activeAssistantHandle;
      if (routing.activeHandle !== undefined) setActiveAssistantHandle(nextHandle);
      editHandle = nextHandle ?? activeAssistantHandle;
      editAuthorId = routing.builtInMention?.assistantUserId;
    } catch {
      // Routing failed — proceed with current assistant context
    }

    // Always fire the stream so the user always gets a regenerated response on edit.
    void streamResponse(truncated, editHandle, editEndpoint, editAuthorId);
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();

    // If empty submit and an embed is active, submit the embedded form instead.
    if (!trimmed && hasActiveEmbed) {
      void submitEmbed();
      return;
    }

    if (!trimmed) return;
    // In Slack mode, re-entry is allowed — users can keep posting while assistants stream.
    // In ChatGPT mode, the existing single-stream block is preserved.
    if (!isSlackMode && hasActiveStream) return;

    // Create thread if needed.
    let threadId = activeThreadId;
    if (!threadId) {
      threadId = generateId();
      const title = extractAgentName(trimmed) ?? deriveThreadTitle(trimmed);
      const now = new Date().toISOString();
      // Don't save the empty thread here — the save with the user message below
      // will create it. Saving empty first then saving with messages creates a
      // race condition where the empty write can arrive at the server second.
      skipNextThreadLoadRef.current = true;
      loadedThreadIdRef.current = threadId;
      // New thread — reset pause state so stale participants from previous thread don't bleed in.
      setPausedParticipants([]);
      setActiveThreadId(threadId);
      setThreads((prev) => [{ id: threadId!, title, createdAt: now, updatedAt: now }, ...prev]);
      pushChatUrl(threadId);
    }

    // Snapshot + clear pending attachments so this message owns the refs and
    // the next prompt starts empty.
    const attachmentsForThisMessage = pendingAttachments;
    if (attachmentsForThisMessage.length > 0) setPendingAttachments([]);
    const userMessage: Message = {
      id: generateId(),
      role: "user",
      content: trimmed,
      ...(attachmentsForThisMessage.length > 0
        ? { attachments: attachmentsForThisMessage }
        : {}),
    };
    // Read from messagesRef to avoid stale-closure races: a previous Slack submit may
    // have appended an assistant bubble after this handler's closure was captured.
    const baseMessages = messagesRef.current;
    const currentMessages = [...baseMessages, userMessage];
    // For any @mention, switch to Slack mode NOW — in the same synchronous batch as
    // setMessages — so the message is never rendered in normal (right-aligned) mode.
    // resolveMessageRouting is async; a cheap regex check is sufficient here.
    // Applies to all messages (not just the first) to handle human-user tags and
    // built-in assistant tags (@chatgpt) that produce no externalMentions.
    const newMentionCount = (trimmed.match(/@[a-z0-9_-]+/gi) ?? []).length;
    if (!isSlackMode && ((taggedAssistantUserIds.length >= 1 && newMentionCount >= 1) || newMentionCount >= 2)) {
      // Suppress the enter-animation only on the very first message of a new thread.
      if (baseMessages.length === 0) prevIsSlackModeRef.current = true;
      setIsSlackMode(true);
    }
    setMessages(currentMessages);
    promptRef.current?.clear();

    // Auto-update thread title from "The agent's name is: <name>" in existing threads.
    const agentName = extractAgentName(trimmed);
    if (agentName && threadId && !titleUserEditedRef.current) {
      const now = new Date().toISOString();
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId ? { ...t, title: agentName, updatedAt: now } : t,
        ),
      );
    }

    // Always persist the user message immediately — before routing, before LLM call.
    // This ensures the message is saved even if routing returns early (external assistant)
    // or if streamResponse fails partway through.
    {
      const now = new Date().toISOString();
      const title = threads.find((t) => t.id === threadId)?.title ?? deriveThreadTitle(trimmed);
      // createdAt is immutable: prefer the summary, then the loaded thread's
      // createdAt, then now for a genuinely new thread (#283).
      const createdAt = threads.find((t) => t.id === threadId)?.createdAt ?? loadedThreadCreatedAtRef.current ?? now;
      saveChatThreadViaFetch({ id: threadId, title, messages: currentMessages, createdAt, updatedAt: now, activeAssistantHandle, taggedAssistantUserIds, slackMode: isSlackMode, ownerUserId: userId } as Record<string, unknown> & { id: string }).catch((err) => console.error("[chat] saveChatThread failed:", err));
    }

    // -----------------------------------------------------------------------
    // Chat prompt-window HITL drive. If an inline HITL gate is
    // open, classify this message: a gate response is submitted via the SAME
    // approval path the embedded form uses (AgenticRunPanel single source of
    // truth) and does NOT trigger an LLM turn; a non-response falls through
    // to normal chat routing below.
    // -----------------------------------------------------------------------
    {
      const openGates = Array.from(gateRegistryRef.current.values());
      // Drive the most-recently-registered open gate (typical case: one).
      const gate = openGates[openGates.length - 1];
      if (gate) {
        const verdict = classifyPromptForGate(trimmed, {
          fields: gate.fields,
          fieldName: gate.fieldName,
        });
        // Append an assistant ack AND persist it, mirroring the immediate
        // user-message save above. Without the explicit save the gate path's
        // early returns leave the ack reliant on the generic no-stream
        // persistence effect; persisting here removes the timing inconsistency
        // so the ack survives an immediate reload.
        const persistAck = (content: string): void => {
          const ackMsg: Message = {
            id: generateId(),
            role: "assistant",
            content,
          };
          const messagesWithAck = [...currentMessages, ackMsg];
          setMessages((prev) => [...prev, ackMsg]);
          const now = new Date().toISOString();
          const title =
            threads.find((t) => t.id === threadId)?.title ??
            deriveThreadTitle(trimmed);
          // createdAt is immutable: prefer the summary, then the loaded
          // thread's createdAt, then now for a genuinely new thread (#283).
          const createdAt =
            threads.find((t) => t.id === threadId)?.createdAt ?? loadedThreadCreatedAtRef.current ?? now;
          saveChatThreadViaFetch({
            id: threadId,
            title,
            messages: messagesWithAck,
            createdAt,
            updatedAt: now,
            activeAssistantHandle,
            taggedAssistantUserIds,
            slackMode: isSlackMode,
            ownerUserId: userId,
          } as Record<string, unknown> & { id: string }).catch((err) =>
            console.error("[chat] saveChatThread (gate ack) failed:", err),
          );
        };
        const finishGateSubmit = async (
          value: Record<string, unknown> | string | number | boolean,
        ): Promise<void> => {
          try {
            await gate.submit(value);
            persistAck(
              `Submitted to the agent's \`${gate.xRenderer}\` step.`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown";
            persistAck(`Could not submit to the agent gate: ${msg}`);
          }
        };
        if (verdict.kind === "submit") {
          await finishGateSubmit(verdict.value);
          return;
        }
        if (verdict.kind === "llm") {
          let extracted: Record<string, unknown> = {};
          try {
            const raw = await extractHitlGateValuesAction(trimmed, gate.fields);
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              extracted = parsed as Record<string, unknown>;
            }
          } catch {
            extracted = {};
          }
          const requiredNames = gate.fields
            .filter((f) => f.required)
            .map((f) => f.name);
          const hasAllRequired =
            requiredNames.length > 0 &&
            requiredNames.every(
              (n) => extracted[n] !== undefined && extracted[n] !== null,
            );
          const hasAny = Object.keys(extracted).length > 0;
          if (hasAllRequired || (requiredNames.length === 0 && hasAny)) {
            await finishGateSubmit(extracted);
            return;
          }
          if (hasAny) {
            // Partial — keep the gate open, tell the user what's missing,
            // do NOT route to the LLM (the message was a gate attempt).
            const missing = requiredNames.filter(
              (n) => extracted[n] === undefined || extracted[n] === null,
            );
            persistAck(
              `Got ${Object.keys(extracted).join(", ")}. Still need: ${missing.join(", ")}. Fill the form or reply with the remaining value(s).`,
            );
            return;
          }
          // Nothing extracted → fall through to normal chat routing.
        }
        // verdict.kind === "chat" → fall through to normal chat routing.
      }
    }

    // Check routing: broadcast to all non-paused participants when no @mention.
    const { shouldCallLlm, activeHandle, externalMentions, isBroadcast, chatEndpoint, builtInMention } = await resolveMessageRouting(
      trimmed,
      threadId,
      activeAssistantHandle,
      {
        taggedAssistantUserIds,
        pausedParticipants,
        handleMap: Object.fromEntries(assistantHandleMap),
      },
    );
    // Optimistically append newly-tagged assistantUserIds to component state BEFORE
    // saveChatThread — this triggers the Slack-mode transition the moment the user sends.
    const newlyTaggedIds = (externalMentions ?? [])
      .map((m) => m.assistantUserId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (newlyTaggedIds.length > 0) {
      // First message with @mention — conversation opens directly in Slack mode,
      // no "switching" animation needed. Mirror the cold-load suppression pattern.
      if (baseMessages.length === 0) prevIsSlackModeRef.current = true;
      setTaggedAssistantUserIds((prev) => {
        const merged = new Set([...prev, ...newlyTaggedIds]);
        return Array.from(merged);
      });
    }
    // Persist the active assistant handle in component state.
    const nextActiveHandle = activeHandle !== undefined ? (activeHandle || undefined) : activeAssistantHandle;
    if (activeHandle !== undefined) setActiveAssistantHandle(nextActiveHandle);

    // Always attach mentionState to the user message so external assistants get polled.
    if (externalMentions && externalMentions.length > 0) {
      const mentionState: Record<string, "pending" | "handled"> = {};
      for (const m of externalMentions) mentionState[m.assistantUserId] = "pending";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === userMessage.id ? { ...m, mentions: externalMentions, mentionState } : m,
        ),
      );
    }

    // Attach mention for built-in assistants so assistantHandleMap resolves their handle → name.
    if (builtInMention) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === userMessage.id ? { ...m, mentions: [builtInMention] } : m,
        ),
      );
    }

    if (isBroadcast && !shouldCallLlm) {
      // Broadcast fired to external assistants but Cinatra is paused — nothing more to do locally.
      return;
    }

    if (!shouldCallLlm && !isBroadcast) {
      // Only external assistants are active — show waiting indicator.
      const handle = nextActiveHandle ?? activeHandle ?? "the assistant";
      setPendingExternalHandle(handle);
      if (externalReplyTimerRef.current) clearTimeout(externalReplyTimerRef.current);
      externalReplyTimerRef.current = window.setTimeout(() => {
        externalReplyTimerRef.current = null;
        // Cinatra takeover — launch the stream FIRST so beginStream() registers the
        // abort controller / typing indicator in the same render batch where
        // pendingExternalHandle is cleared. This removes the visible gap between
        // "Waiting for @handle…" and the cinatra thinking indicator.
        void streamResponse(currentMessages, "cinatra");
        setPendingExternalHandle(null);
      }, 20_000);
      return;
    }

    if (shouldCallLlm) {
      const endpoint = chatEndpoint ?? "/api/chat";
      const builtInAuthorId = builtInMention?.assistantUserId;

      if (isSlackMode) {
        // Slack mode: fire-and-forget so sendMessage returns immediately and the
        // composer unblocks. streamResponse is guaranteed non-throwing by its
        // internal try/catch, which writes errors into the assistant message, so
        // void dispatch cannot leak an unhandled rejection.
        const displayHandle = nextActiveHandle ?? activeAssistantHandle ?? "Assistant";
        void streamResponse(currentMessages, displayHandle, endpoint, builtInAuthorId);
      } else {
        // ChatGPT mode: preserve the existing synchronous, blocking behavior.
        await streamResponse(currentMessages, undefined, endpoint, builtInAuthorId);
      }
    }
  }

  const activeTitle = threads.find((t) => t.id === activeThreadId)?.title;

  // ----- Empty state -----
  // Only show the start screen when no thread is selected. When activeThreadId is
  // set (thread clicked) but messages haven't loaded from the API yet, fall through
  // to the thread view so users don't see a flash of the start screen during load.
  if (!hasMessages && !activeThreadId) {
    return (
      <div className="flex h-full">
          <main className="flex flex-1 flex-col items-center justify-center px-5 pb-[80px]">
            <div className="flex w-full max-w-2xl flex-col items-center gap-8 -mt-[30px]">
              <div className="-translate-y-[30px]"><DancingRobot /></div>
              <div className="flex w-full flex-col items-center gap-8 -mt-[120px]">
              <div className="flex flex-col items-center gap-3">
                <h1 className="text-center font-display italic font-extrabold leading-[1.05] tracking-[-0.018em] text-balance text-[38px] text-foreground">
                  {chatEmptyStateCaption(initialMode, greeting)}
                </h1>
              </div>

              <div className="w-full">
                <PromptField
                  ref={promptRef}
                  editorTestId="chat-prompt-input"
                  placeholder={
                    isCreateAgentMode
                      ? "Describe what it should do"
                      : "Ask anything..."
                  }
                  storageKey="cinatra_chat_prompt"
                  shouldDiscardStoredValue={isPinnedBadgePrefill}
                  rows={1}
                  canSubmitEmpty={false}
                  onSubmit={(value) => void sendMessage(value)}
                  onChange={(value) => setPromptValue(value)}
                  submitAriaLabel="Send message"
                  pending={isSlackMode ? false : (hasActiveStream || !!pendingExternalHandle)}
                  showStatusMessage={false}
                  mentionables={mentionables}
                  onAttachmentsSelected={handleAttachmentsSelected}
                  autosave={autosaveVisible ? {
                    enabled: autosaveEnabled,
                    canToggle: autosaveCanToggle,
                    onToggle: (enabled) => {
                      setAutosaveEnabled(enabled);
                      void fetch("/api/chat/autosave", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ enabled }),
                      });
                    },
                  } : undefined}
                />
                <SkillBadgeCloud
                  badges={selectChatBadges(initialMode)}
                  promptValue={promptValue}
                  onSelect={(prefillText) => {
                    promptRef.current?.setValue(prefillText);
                    promptRef.current?.focus?.();
                  }}
                />
              </div>
              </div>
            </div>
          </main>
        </div>
    );
  }

  // ----- Conversation state -----
  return (
    <div className="flex h-full">
      <div className="relative flex min-h-0 flex-1 flex-col">

        <div
          ref={messagesContainerRef}
          className="min-h-0 flex-1 overflow-y-auto pb-24 pt-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onScroll={() => {
            // Ignore scroll events caused by scrollToBottom() itself — only react to user input.
            if (isProgrammaticScrollRef.current) return;
            const el = messagesContainerRef.current;
            if (!el) return;
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            // 5px threshold: engage lock on any meaningful upward scroll, release when back at bottom.
            userScrolledUpRef.current = distanceFromBottom > 5;
          }}
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4">
            {messages.map((message) => {
              const isUser = message.role === "user";
              if (isSlackMode) {
                const userInitials = session?.user?.name
                  ? session.user.name.split(" ").map((n: string) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2)
                  : "Me";
                // Resolve per-message handle: authorUserId → handle map, fallback to "cinatra"
                const messageHandle = !isUser
                  ? (message.authorUserId
                      ? (assistantHandleMap.get(message.authorUserId) ?? activeAssistantHandle ?? "cinatra")
                      : "cinatra")
                  : null;
                const initials = isUser ? userInitials : getParticipantInitials(messageHandle ?? undefined);
                const displayName = isUser
                  ? (session?.user?.name ?? "You")
                  : resolveAssistantDisplayName(messageHandle);
                const assistantIcon = !isUser ? getAssistantProviderIcon(messageHandle ?? undefined) : null;
                const participantId = !isUser ? (message.authorUserId ?? "cinatra") : null;
                const isParticipantPaused = participantId ? pausedParticipants.includes(participantId) : false;
                return (
                  <div
                    key={message.id}
                    className={cn(
                      "group flex flex-col gap-1",
                      animating && "animate-slack-slide-left",
                    )}
                  >
                    {/* Header row: Avatar + name aligned in the middle */}
                    <div className="flex items-center gap-2">
                      {/* Resolve sender user ID — covers human, external assistant, and built-in cinatra */}
                      {(() => {
                        const senderUserId = isUser
                          ? userId
                          : (message.authorUserId ?? mentionables.find((m) => m.handle === (messageHandle ?? "cinatra"))?.id);
                        const profileHref = senderUserId ? `/users/${senderUserId}` : null;
                        const avatarEl = (
                          <Avatar size="sm">
                            {isUser && session?.user?.image && <AvatarImage src={session.user.image} />}
                            <AvatarFallback>{assistantIcon ?? initials}</AvatarFallback>
                          </Avatar>
                        );
                        return (
                          <>
                            {profileHref ? (
                              <Link href={profileHref} className={cn("shrink-0", animating && "animate-slack-avatar-fade-in")}>{avatarEl}</Link>
                            ) : (
                              <span className={cn("shrink-0", animating && "animate-slack-avatar-fade-in")}>{avatarEl}</span>
                            )}
                            <div className={cn("group/name flex items-center gap-1", animating && "animate-slack-name-fade-in")}>
                              {profileHref ? (
                                <Link href={profileHref} className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">{displayName}</Link>
                              ) : (
                                <span className="text-xs font-medium text-muted-foreground">{displayName}</span>
                              )}
                        {!isUser && activeThreadId && (() => {
                          // Resolve participant ID: authorUserId for external, "cinatra" for built-in
                          const participantId = message.authorUserId ?? "cinatra";
                          const isPaused = pausedParticipants.includes(participantId);
                          return (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              title={isPaused ? `Resume ${displayName}` : `Pause ${displayName}`}
                              onClick={() => {
                                const next = !isPaused;
                                setPausedParticipants((prev) =>
                                  next ? [...prev, participantId] : prev.filter((id) => id !== participantId),
                                );
                                void setAssistantPauseState(activeThreadId, participantId, next);
                              }}
                              className="h-auto w-auto transition-opacity text-muted-foreground hover:text-foreground hover:bg-transparent"
                            >
                              {isPaused
                                ? <PlayCircle className="h-3.5 w-3.5" />
                                : <PauseCircle className="h-3.5 w-3.5" />}
                            </Button>
                          );
                        })()}
                            </div>
                          </>
                        );
                      })()}
                      <div className="flex-1" />
                      <div className="flex items-center gap-0.5">
                        {isUser && !hasActiveStream && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            title="Edit message"
                            onClick={() => setRequestEditMessageId(message.id)}
                            className="h-auto w-auto rounded p-1 text-muted-foreground hover:text-foreground hover:bg-surface-muted transition-colors"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title="Copy message"
                          onClick={() => void navigator.clipboard.writeText(message.content)}
                          className="h-auto w-auto rounded p-1 text-muted-foreground hover:text-foreground hover:bg-surface-muted transition-colors"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    {/* Bubble indented to align with name (past avatar + gap) */}
                    <div className="relative ml-8 max-w-[85%]">
                      {isUser ? (
                        <UserMessageBubble
                          message={message}
                          onEdit={(id, content) => void editAndResend(id, content)}
                          disabled={hasActiveStream}
                          isSlackMode
                          editRequested={requestEditMessageId === message.id}
                          onEditStarted={() => setRequestEditMessageId(null)}
                          mentionables={mentionables}
                        />
                      ) : (
                        <div className="group min-w-0 max-w-full flex-1">
                          {/* Ordered parts: when an assistant message
                              has a `parts` trace, render text + tool badges
                              chronologically interleaved. Replaces the
                              flat thoughtGroups-above-content layout. Old
                              messages without parts fall through to the
                              legacy path below. */}
                          {message.parts && message.parts.length > 0 && !message.error ? (
                            <OrderedPartsSection
                              parts={message.parts}
                              trimContent={streamingAbortControllersRef.current.has(message.id) ? trimIncompleteEmbeds : undefined}
                              theme={theme}
                              detectWidgets={widgetRuntime.detectWidgets}
                              onMarkdownClick={handleAssistantMarkdownClick}
                              onActiveGateChange={handleActiveGateChange}
                            />
                          ) : (
                            <>
                              {message.thoughtGroups && message.thoughtGroups.length > 0 && !streamingAbortControllersRef.current.has(message.id) && (
                                <div>
                                  {message.thoughtGroups.map((group) => (
                                    <ThoughtGroupSection
                                      key={group.id}
                                      group={group}
                                      isLive={streamingAbortControllersRef.current.has(message.id)}
                                    />
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                          {message.error ? (
                            <ErrorCard error={message.error} errorRaw={message.errorRaw} />
                          ) : (message.parts && message.parts.length > 0) ? (
                            // Rich-content adjuncts (mermaid, charts, citations,
                            // widgets) are computed from `message.content` which
                            // is populated alongside `parts`. Render them BELOW
                            // the interleaved parts so the feature set matches
                            // the legacy path.
                            <>
                              {(() => {
                                const widgets = widgetRuntime.detectWidgets(message.content);
                                if (widgets.length === 0) return null;
                                const isLastMessage = message === messages[messages.length - 1];
                                return widgets.map((widget) => (
                                  <ChatWidget
                                    key={widget.widgetId + widget.resourceId}
                                    widget={widget}
                                    def={widgetRuntime.findWidget(widget.widgetId)}
                                    submitRef={isLastMessage ? widgetSubmitRef : { current: null }}
                                    isOlderWidget={!isLastMessage}
                                    refreshKey={widgetRefreshKey}
                                  />
                                ));
                              })()}
                              {(() => {
                                const mermaidBlocks = detectMermaidBlocks(message.content);
                                if (mermaidBlocks.length === 0) return null;
                                return mermaidBlocks.map((block, i) => (
                                  <MermaidBlock
                                    key={`${message.id}-mermaid-${i}`}
                                    id={`${message.id}-${i}`}
                                    source={block.source}
                                  />
                                ));
                              })()}
                              {(() => {
                                const charts = detectCharts(message.content);
                                if (charts.length === 0) return null;
                                return charts.map((c, i) =>
                                  c.spec
                                    ? <ChartEmbed key={`chart-${message.id}-${i}`} spec={c.spec} />
                                    : <ChartError key={`chart-err-${message.id}-${i}`} reason="invalid schema" />,
                                );
                              })()}
                              {message.citations && message.citations.length > 0 && (
                                <div className="mt-4 border-t border-line pt-3">
                                  <div className="mb-2 text-xs font-semibold text-muted-foreground">Sources</div>
                                  <ol className="text-xs">
                                    {message.citations.map((c, i) => {
                                      const host = (() => {
                                        try { return new URL(c.url).hostname.replace(/^www\./, ""); } catch { return c.url; }
                                      })();
                                      return (
                                        <li key={`${message.id}-cite-${i}`} className="my-1 flex gap-2 first:mt-0">
                                          <span className="text-muted-foreground">{i + 1}.</span>
                                          <a href={c.url} target="_blank" rel="noreferrer" className="truncate text-muted-foreground underline underline-offset-4 hover:text-foreground">
                                            {c.title || host}
                                            <span className="ml-2 text-muted-foreground/70">({host})</span>
                                          </a>
                                        </li>
                                      );
                                    })}
                                  </ol>
                                </div>
                              )}
                              {streamingAbortControllersRef.current.has(message.id) && shouldShowLiveProgressStatus(message) && (
                                <ThinkingIndicator className="mt-2" label={getLiveProgressStatus(message)} />
                              )}
                            </>
                          ) : message.content ? (
                            <>
                              <div
                                className="max-w-none text-[15px] leading-relaxed text-foreground [&_table]:my-0"
                                dangerouslySetInnerHTML={{ __html: renderMarkdown(
                                  streamingAbortControllersRef.current.has(message.id)
                                    ? trimIncompleteEmbeds(message.content)
                                    : message.content,
                                  theme,
                                  widgetRuntime.detectWidgets,
                                ) }}
                                onClick={handleAssistantMarkdownClick}
                              />
                              {(() => {
                                const widgets = widgetRuntime.detectWidgets(message.content);
                                if (widgets.length === 0) return null;
                                const isLastMessage = message === messages[messages.length - 1];
                                return widgets.map((widget) => (
                                  <ChatWidget
                                    key={widget.widgetId + widget.resourceId}
                                    widget={widget}
                                    def={widgetRuntime.findWidget(widget.widgetId)}
                                    submitRef={isLastMessage ? widgetSubmitRef : { current: null }}
                                    isOlderWidget={!isLastMessage}
                                    refreshKey={widgetRefreshKey}
                                  />
                                ));
                              })()}
                              {(() => {
                                const mermaidBlocks = detectMermaidBlocks(message.content);
                                if (mermaidBlocks.length === 0) return null;
                                return mermaidBlocks.map((block, i) => (
                                  <MermaidBlock
                                    key={`${message.id}-mermaid-${i}`}
                                    id={`${message.id}-${i}`}
                                    source={block.source}
                                  />
                                ));
                              })()}
                              {(() => {
                                const charts = detectCharts(message.content);
                                if (charts.length === 0) return null;
                                return charts.map((c, i) =>
                                  c.spec
                                    ? <ChartEmbed key={`chart-${message.id}-${i}`} spec={c.spec} />
                                    : <ChartError key={`chart-err-${message.id}-${i}`} reason="invalid schema" />,
                                );
                              })()}
                              {message.citations && message.citations.length > 0 && (
                                <div className="mt-4 border-t border-line pt-3">
                                  <div className="mb-2 text-xs font-semibold text-muted-foreground">Sources</div>
                                  <ol className="text-xs">
                                    {message.citations.map((c, i) => {
                                      const host = (() => {
                                        try { return new URL(c.url).hostname.replace(/^www\./, ""); } catch { return c.url; }
                                      })();
                                      return (
                                        <li key={`${message.id}-cite-${i}`} className="my-1 flex gap-2 first:mt-0">
                                          <span className="text-muted-foreground">{i + 1}.</span>
                                          <a href={c.url} target="_blank" rel="noreferrer" className="truncate text-muted-foreground underline underline-offset-4 hover:text-foreground">
                                            {c.title || host}
                                            <span className="ml-2 text-muted-foreground/70">({host})</span>
                                          </a>
                                        </li>
                                      );
                                    })}
                                  </ol>
                                </div>
                              )}
                              {streamingAbortControllersRef.current.has(message.id) && shouldShowLiveProgressStatus(message) && (
                                <ThinkingIndicator className="mt-2" label={getLiveProgressStatus(message)} />
                              )}
                            </>
                          ) : streamingAbortControllersRef.current.has(message.id) && shouldShowLiveProgressStatus(message) ? (
                            <ThinkingIndicator label={getLiveProgressStatus(message)} />
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }
              // ChatGPT branch — preserve byte-identical render behavior.
              const showParticipantHeaders = true;
              const nmUserInitials = session?.user?.name
                ? session.user.name.split(" ").map((n: string) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2)
                : "Me";
              const nmUserName = session?.user?.name ?? "You";
              const nmThreadHasMention = taggedAssistantUserIds.length >= 1
                || messages.some((m) => m.role === "user" && /@[a-z0-9_-]+/i.test(m.content));
              const nmResolvedHandle = nmThreadHasMention ? activeAssistantHandle : undefined;
              const nmHandle = !isUser
                ? (message.authorUserId
                    ? (assistantHandleMap.get(message.authorUserId) ?? nmResolvedHandle ?? "cinatra")
                    : (nmResolvedHandle ?? "cinatra"))
                : null;
              const nmDisplayName = isUser ? nmUserName : resolveAssistantDisplayName(nmHandle);
              const nmAssistantIcon = !isUser ? getAssistantProviderIcon(nmHandle ?? undefined) : null;
              const nmInitials = !isUser ? getParticipantInitials(nmHandle ?? undefined) : nmUserInitials;
              return (
                <div key={message.id} className={cn("flex flex-col gap-1", isUser && "items-end")}>
                  {showParticipantHeaders && (
                    isUser ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">{nmUserName}</span>
                        <Avatar size="sm">
                          {session?.user?.image && <AvatarImage src={session.user.image} />}
                          <AvatarFallback>{nmUserInitials}</AvatarFallback>
                        </Avatar>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Avatar size="sm">
                          <AvatarFallback>{nmAssistantIcon ?? nmInitials}</AvatarFallback>
                        </Avatar>
                        <span className="text-xs font-medium text-muted-foreground">{nmDisplayName}</span>
                      </div>
                    )
                  )}
                  {isUser ? (
                    <UserMessageBubble
                      message={message}
                      onEdit={(id, content) => void editAndResend(id, content)}
                      disabled={hasActiveStream}
                      mentionables={mentionables}
                    />
                  ) : (
                    <div className="group min-w-0 max-w-full flex-1">
                      {/* Ordered parts — see comment at the first render site
                          above. Same conditional applies here in slack-mode
                          view. */}
                      {message.parts && message.parts.length > 0 && !message.error ? (
                        <OrderedPartsSection
                          parts={message.parts}
                          trimContent={streamingAbortControllersRef.current.has(message.id) ? trimIncompleteEmbeds : undefined}
                          theme={theme}
                          detectWidgets={widgetRuntime.detectWidgets}
                          onMarkdownClick={handleAssistantMarkdownClick}
                          onActiveGateChange={handleActiveGateChange}
                        />
                      ) : (
                        <>
                          {message.thoughtGroups && message.thoughtGroups.length > 0 && !streamingAbortControllersRef.current.has(message.id) && (
                            <div>
                              {message.thoughtGroups.map((group) => (
                                <ThoughtGroupSection
                                  key={group.id}
                                  group={group}
                                  isLive={streamingAbortControllersRef.current.has(message.id)}
                                />
                              ))}
                            </div>
                          )}
                        </>
                      )}
                      {message.error ? (
                        <ErrorCard error={message.error} errorRaw={message.errorRaw} />
                      ) : (message.parts && message.parts.length > 0) ? (
                        // Same rich-content adjuncts treatment as the
                        // ChatGPT-mode render site above.
                        <>
                          {(() => {
                            const widgets = widgetRuntime.detectWidgets(message.content);
                            if (widgets.length === 0) return null;
                            const isLastMessage = message === messages[messages.length - 1];
                            return widgets.map((widget) => (
                              <ChatWidget
                                key={widget.widgetId + widget.resourceId}
                                widget={widget}
                                def={widgetRuntime.findWidget(widget.widgetId)}
                                submitRef={isLastMessage ? widgetSubmitRef : { current: null }}
                                isOlderWidget={!isLastMessage}
                                refreshKey={widgetRefreshKey}
                              />
                            ));
                          })()}
                          {(() => {
                            const mermaidBlocks = detectMermaidBlocks(message.content);
                            if (mermaidBlocks.length === 0) return null;
                            return mermaidBlocks.map((block, i) => (
                              <MermaidBlock
                                key={`${message.id}-mermaid-${i}`}
                                id={`${message.id}-${i}`}
                                source={block.source}
                              />
                            ));
                          })()}
                          {(() => {
                            const charts = detectCharts(message.content);
                            if (charts.length === 0) return null;
                            return charts.map((c, i) =>
                              c.spec
                                ? <ChartEmbed key={`chart-${message.id}-${i}`} spec={c.spec} />
                                : <ChartError key={`chart-err-${message.id}-${i}`} reason="invalid schema" />,
                            );
                          })()}
                          {message.citations && message.citations.length > 0 && (
                            <div className="mt-4 border-t border-line pt-3">
                              <div className="mb-2 text-xs font-semibold text-muted-foreground">Sources</div>
                              <ol className="text-xs">
                                {message.citations.map((c, i) => {
                                  const host = (() => {
                                    try { return new URL(c.url).hostname.replace(/^www\./, ""); } catch { return c.url; }
                                  })();
                                  return (
                                    <li key={`${message.id}-cite-${i}`} className="my-1 flex gap-2 first:mt-0">
                                      <span className="text-muted-foreground">{i + 1}.</span>
                                      <a href={c.url} target="_blank" rel="noreferrer" className="truncate text-muted-foreground underline underline-offset-4 hover:text-foreground">
                                        {c.title || host}
                                        <span className="ml-2 text-muted-foreground/70">({host})</span>
                                      </a>
                                    </li>
                                  );
                                })}
                              </ol>
                            </div>
                          )}
                          {streamingAbortControllersRef.current.has(message.id) && shouldShowLiveProgressStatus(message) && (
                            <ThinkingIndicator className="mt-2" label={getLiveProgressStatus(message)} />
                          )}
                        </>
                      ) : message.content ? (
                        <>
                          <div
                            className="max-w-none text-[15px] leading-relaxed text-foreground [&_table]:my-0"
                            dangerouslySetInnerHTML={{ __html: renderMarkdown(
                              // While streaming, trim incomplete embed prefixes so partial
                              // JSON/mermaid never flashes as raw text in the markdown output.
                              streamingAbortControllersRef.current.has(message.id)
                                ? trimIncompleteEmbeds(message.content)
                                : message.content,
                              theme,
                              widgetRuntime.detectWidgets,
                            ) }}
                            /* renderMarkdown strips mermaid blocks; they are rendered separately below */
                            onClick={handleAssistantMarkdownClick}
                          />
                          {(() => {
                            const widgets = widgetRuntime.detectWidgets(message.content);
                            if (widgets.length === 0) return null;
                            const isLastMessage = message === messages[messages.length - 1];
                            return widgets.map((widget) => (
                              <ChatWidget
                                key={widget.widgetId + widget.resourceId}
                                widget={widget}
                                def={widgetRuntime.findWidget(widget.widgetId)}
                                submitRef={isLastMessage ? widgetSubmitRef : { current: null }}
                                isOlderWidget={!isLastMessage}
                                refreshKey={widgetRefreshKey}
                              />
                            ));
                          })()}
                          {(() => {
                            const mermaidBlocks = detectMermaidBlocks(message.content);
                            if (mermaidBlocks.length === 0) return null;
                            return mermaidBlocks.map((block, i) => (
                              <MermaidBlock
                                key={`${message.id}-mermaid-${i}`}
                                id={`${message.id}-${i}`}
                                source={block.source}
                              />
                            ));
                          })()}
                          {(() => {
                            const charts = detectCharts(message.content);
                            if (charts.length === 0) return null;
                            return charts.map((c, i) =>
                              c.spec
                                ? <ChartEmbed key={`chart-${message.id}-${i}`} spec={c.spec} />
                                : <ChartError key={`chart-err-${message.id}-${i}`} reason="invalid schema" />,
                            );
                          })()}
                          {message.role === "assistant" && message.citations && message.citations.length > 0 && (
                            <div className="mt-4 border-t border-line pt-3">
                              <div className="mb-2 text-xs font-semibold text-muted-foreground">Sources</div>
                              <ol className="text-xs">
                                {message.citations.map((c, i) => {
                                  const host = (() => {
                                    try { return new URL(c.url).hostname.replace(/^www\./, ""); } catch { return c.url; }
                                  })();
                                  return (
                                    <li key={`${message.id}-cite-${i}`} className="my-1 flex gap-2 first:mt-0">
                                      <span className="text-muted-foreground">{i + 1}.</span>
                                      <a href={c.url} target="_blank" rel="noreferrer" className="truncate text-muted-foreground underline underline-offset-4 hover:text-foreground">
                                        {c.title || host}
                                        <span className="ml-2 text-muted-foreground/70">({host})</span>
                                      </a>
                                    </li>
                                  );
                                })}
                              </ol>
                            </div>
                          )}
                          {streamingAbortControllersRef.current.has(message.id) && shouldShowLiveProgressStatus(message) && (
                            <ThinkingIndicator className="mt-2" label={getLiveProgressStatus(message)} />
                          )}
                          {(() => {
                            const confirmMatch = message.content.match(/\[confirm-([a-z_-]+):([a-f0-9-]{36})\]/i);
                            if (!confirmMatch) return null;
                            const [, resourceType, resourceId] = confirmMatch;
                            const manifest = widgetRuntime.findManifestByConfirmationResourceType(resourceType);
                            if (!manifest?.wizard) return null;
                            const isLastMessage = message === messages[messages.length - 1];
                            if (!isLastMessage) return null;
                            return (
                              <div className="mt-3 flex gap-2">
                                <Button
                                  type="button"
                                  onClick={() => void activateResource(resourceType, resourceId)}
                                  disabled={hasActiveStream}
                                  className="h-auto rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/80 disabled:opacity-50"
                                >
                                  {manifest.wizard.confirmation.buttonLabel}
                                </Button>
                              </div>
                            );
                          })()}
                          {!(streamingAbortControllersRef.current.has(message.id)) && (
                            <div className="mt-1 flex gap-0.5">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => void navigator.clipboard.writeText(message.content)}
                                className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground"
                                title="Copy response"
                              >
                                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
                                  <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
                                  <path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5" />
                                </svg>
                              </Button>
                              {(() => {
                                const idx = messages.findIndex((m) => m.id === message.id);
                                const prevUser = idx > 0 ? messages.slice(0, idx).findLast((m) => m.role === "user") : undefined;
                                if (!prevUser || isSlackMode) return null;
                                return (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => void editAndResend(prevUser.id, prevUser.content)}
                                    disabled={hasActiveStream}
                                    className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground disabled:opacity-50"
                                    title="Try again"
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  </Button>
                                );
                              })()}
                            </div>
                          )}
                        </>
                      ) : streamingAbortControllersRef.current.has(message.id) && shouldShowLiveProgressStatus(message) ? (
                        <ThinkingIndicator label={getLiveProgressStatus(message)} />
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Waiting indicator — shown while an external assistant is expected to reply */}
            {pendingExternalHandle && (
              <div className="flex justify-start">
                <div className="min-w-0 max-w-full flex-1">
                  <WaitingIndicator handle={pendingExternalHandle} />
                </div>
              </div>
            )}
            {/* Slack mode: per-assistant typing indicator while stream is buffering */}
            {isSlackMode && typingIndicators.size > 0 && Array.from(typingIndicators.entries()).map(([id, indicatorHandle]) => (
              <div key={id} className="flex justify-start">
                <div className="min-w-0 max-w-full flex-1">
                  <SlackTypingIndicator handle={indicatorHandle} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Zero-height relative anchor — constrains input bar to max-w-3xl+px-4 exactly as messages content */}
        <div className="relative mx-auto w-full max-w-3xl px-4">
          <div className="absolute bottom-0 left-4 right-4 bg-background pb-3 pt-0">
            <PromptField
              ref={promptRef}
              editorTestId="chat-prompt-input"
              placeholder={hasActiveEmbed ? "Press Enter to save, or type a message..." : "Type a message..."}
              storageKey={`cinatra_thread_prompt_${activeThreadId}`}
              rows={1}
              canSubmitEmpty={hasActiveEmbed}
              onSubmit={(value) => void sendMessage(value)}
              submitAriaLabel={hasActiveEmbed ? "Save form" : "Send message"}
              pending={isSlackMode ? false : (hasActiveStream || !!pendingExternalHandle)}
              onStop={() => {
                for (const c of streamingAbortControllersRef.current.values()) c.abort();
              }}
              stopAriaLabel="Stop generating"
              showStatusMessage={false}
              mentionables={mentionables}
              onAttachmentsSelected={handleAttachmentsSelected}
              autosave={autosaveVisible ? {
                enabled: autosaveEnabled,
                canToggle: autosaveCanToggle,
                onToggle: (enabled) => {
                  setAutosaveEnabled(enabled);
                  void fetch("/api/chat/autosave", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ enabled }),
                  });
                },
              } : undefined}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

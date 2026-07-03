"use client";

// ---------------------------------------------------------------------------
// Chat thread persistence seam (cinatra#918 — split out of chat-page.tsx).
// ---------------------------------------------------------------------------
// Plain-fetch thread CRUD + the pure thread-model helpers (id/title
// derivation). Everything here is moved UNCHANGED from chat-page.tsx so the
// component keeps byte-identical behavior; the module exists so the
// persistence contract is testable without mounting the component.
//
// Plain fetch instead of a Next.js server action — avoids the RSC re-render
// that server actions trigger, which caused a corrective navigation (and
// visible "page reload") when the URL had been changed via pushState while
// Next.js's internal router state still pointed at the old route.

import type { UiThread, UiThreadSummary } from "./types";

export const MAX_STORED_THREADS = 50;

export function generateId() {
  return crypto.randomUUID();
}

export function deriveThreadTitle(firstUserMessage: string) {
  const cleaned = firstUserMessage.replace(/\n/g, " ").trim();
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

export function extractAgentName(text: string): string | null {
  const match = text.match(/the agent'?s?\s+name\s+is[:\s]+([^\n.!?,]+)/i);
  const name = match?.[1]?.trim();
  return name && name.length > 0 ? name : null;
}

export async function saveChatThreadViaFetch(thread: Record<string, unknown> & { id: string }): Promise<void> {
  await fetch("/api/chat/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(thread),
  });
}

// Plain fetch instead of a Next.js server action — avoids corrective navigation
// triggered when the URL was updated via pushState before the action resolved.
export async function fetchThreadByIdViaFetch(threadId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`/api/chat/thread/${threadId}`);
  if (!res.ok) return null;
  return res.json() as Promise<Record<string, unknown> | null>;
}

export async function fetchThreadListViaFetch(): Promise<UiThreadSummary[]> {
  const res = await fetch("/api/chat/threads");
  if (!res.ok) return [];
  return res.json() as Promise<UiThreadSummary[]>;
}

export async function fetchThreadList(): Promise<UiThreadSummary[]> {
  try {
    const list = await fetchThreadListViaFetch();
    return list.slice(0, MAX_STORED_THREADS);
  } catch {
    return [];
  }
}

export async function fetchThreadById(threadId: string): Promise<UiThread | null> {
  try {
    return await fetchThreadByIdViaFetch(threadId) as UiThread | null;
  } catch {
    return null;
  }
}

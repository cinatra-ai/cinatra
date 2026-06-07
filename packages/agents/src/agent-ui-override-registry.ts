import type { ComponentType } from "react";
import type { PresentationHint } from "./result-renderers";

// ---------------------------------------------------------------------------
// Namespace validation
// ---------------------------------------------------------------------------

const OVERRIDE_NAMESPACE_RE = /^@[\w.-]+\/[\w.-]+:[\w.-]+$/;

// ---------------------------------------------------------------------------
// Event type union
// ---------------------------------------------------------------------------

/**
 * AG-UI event types handled by the override registry.
 * Mirrors packages/agent-ui-protocol/src/events.ts — keep in sync when new event types are added.
 * Defined locally to avoid adding @cinatra-ai/agent-ui-protocol as a package dependency.
 */
export type AgentUIEventType =
  | "RUN_STARTED"
  | "RUN_FINISHED"
  | "RUN_ERROR"
  | "TEXT_MESSAGE_START"
  | "TEXT_MESSAGE_CONTENT"
  | "TEXT_MESSAGE_END"
  | "TOOL_CALL_START"
  | "TOOL_CALL_END"
  | "STATE_SNAPSHOT"
  | "INTERRUPT"
  | "RESUME";

// ---------------------------------------------------------------------------
// Props contract
// ---------------------------------------------------------------------------

/**
 * Props every AG-UI override renderer component receives.
 *
 * Discriminated union — TypeScript narrows `payload` type inside the renderer
 * based on `eventType`. STATE_SNAPSHOT is the primary override target; other
 * variants carry `unknown` payload until their event types are wired.
 */
export type AgentUIOverrideRendererProps =
  | {
      eventType: "STATE_SNAPSHOT";
      /** The PresentationHint object from the STATE_SNAPSHOT event. */
      payload: PresentationHint;
      agentPackageName: string;
      runId: string;
    }
  | {
      eventType: Exclude<AgentUIEventType, "STATE_SNAPSHOT">;
      /** Raw event payload — type not yet narrowed for this event type. */
      payload: unknown;
      agentPackageName: string;
      runId: string;
    };

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------

export type AgentUIOverrideEntry = {
  /**
   * Unique, namespaced ID: "@scope/package:local-id".
   * A development warning is emitted when the ID does not match this format.
   */
  id: string;
  /** Higher priority wins when multiple entries match the same (eventType, agentPackageName). */
  priority: number;
  /** Which AG-UI event type this entry overrides. */
  eventType: AgentUIEventType;
  /**
   * If set, this entry only applies to the named agent package (template slug).
   * If unset, the entry applies to all agents (global override).
   */
  agentPackageName?: string;
  renderer: ComponentType<AgentUIOverrideRendererProps>;
};

// ---------------------------------------------------------------------------
// Registry implementation
// ---------------------------------------------------------------------------

class AgentUIOverrideRegistryImpl {
  private entries: AgentUIOverrideEntry[] = [];

  /**
   * Register an override entry. Idempotent by `id` — re-registering the same ID
   * replaces the existing entry, safe for hot reload and multiple entry points.
   */
  register(entry: AgentUIOverrideEntry): void {
    // Warn in development when the ID is not in @scope/package:local-id format.
    if (process.env.NODE_ENV !== "production" && !OVERRIDE_NAMESPACE_RE.test(entry.id)) {
      console.warn(
        `Agent UI override ID '${entry.id}' is not namespaced. Use '@scope/package:local-id' format.`,
      );
    }
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    this.entries.push(entry);
    this.entries.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Resolve the highest-priority override entry for the given event type and agent.
   *
   * Resolution rules (in order):
   * 1. `eventType` must match exactly.
   * 2. If the entry has `agentPackageName` set, it must match the caller's `agentPackageName`.
   * 3. Entries without `agentPackageName` (global overrides) match any agent.
   * 4. First match after priority sort wins.
   *
   * Returns null when no matching entry is found — the caller falls back to Tier 1 (DispatchRenderer).
   *
   * NOTE: Only STATE_SNAPSHOT resolution is wired into AgenticRunPanel.
   * Other event types are supported by the registry but not yet consulted at render time.
   */
  resolve(
    eventType: AgentUIEventType,
    agentPackageName?: string,
  ): AgentUIOverrideEntry | null {
    for (const entry of this.entries) {
      if (entry.eventType !== eventType) continue;
      if (entry.agentPackageName && entry.agentPackageName !== agentPackageName) continue;
      return entry;
    }
    return null;
  }

  /** Returns a readonly snapshot of all registered entries sorted by priority. */
  list(): readonly AgentUIOverrideEntry[] {
    return this.entries;
  }

  /** Remove all registered entries. Intended for use in tests only. */
  clear(): void {
    this.entries = [];
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const agentUIOverrideRegistry = new AgentUIOverrideRegistryImpl();

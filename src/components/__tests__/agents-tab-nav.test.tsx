/**
 * AgentsTabNav — the All Agents / Executions tab bar shown on both /agents
 * and /agents/executions (cinatra#1007).
 *
 * Mirrors the established route-tab pattern (src/components/metric-api-nav.tsx):
 * each tab renders as a real <Link> (a full route navigation), and the
 * active tab is driven by the `activeTab` prop the caller passes per-route
 * (not client-side tab state) — Radix's Tabs.Root marks the matching
 * TabsTrigger `data-state="active"` deterministically from `value`, so this
 * is fully assertable via static SSR markup.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentsTabNav } from "../agents-tab-nav";

describe("AgentsTabNav", () => {
  it("renders both tabs with the correct labels and hrefs", () => {
    const html = renderToStaticMarkup(<AgentsTabNav activeTab="all" />);
    expect(html).toContain('href="/agents"');
    expect(html).toContain(">All Agents<");
    expect(html).toContain('href="/agents/executions"');
    expect(html).toContain(">Executions<");
  });

  it('marks "All Agents" active on the /agents (default) tab', () => {
    const html = renderToStaticMarkup(<AgentsTabNav activeTab="all" />);
    // Radix Tabs.Trigger renders data-state="active"/"inactive" per the
    // controlled `value` — order-independent match: find each trigger's
    // anchor + its data-state without assuming attribute order.
    const allAgentsTrigger = html.match(
      /<a[^>]*href="\/agents"[^>]*>All Agents<\/a>/,
    )?.[0];
    const executionsTrigger = html.match(
      /<a[^>]*href="\/agents\/executions"[^>]*>Executions<\/a>/,
    )?.[0];
    expect(allAgentsTrigger).toBeTruthy();
    expect(executionsTrigger).toBeTruthy();
    // The Link is wrapped by Tabs.Trigger (asChild) — data-state lives on the
    // same rendered anchor element via Radix's Slot merge.
    expect(allAgentsTrigger).toContain('data-state="active"');
    expect(executionsTrigger).toContain('data-state="inactive"');
  });

  it('marks "Executions" active on the /agents/executions tab', () => {
    const html = renderToStaticMarkup(<AgentsTabNav activeTab="executions" />);
    const allAgentsTrigger = html.match(
      /<a[^>]*href="\/agents"[^>]*>All Agents<\/a>/,
    )?.[0];
    const executionsTrigger = html.match(
      /<a[^>]*href="\/agents\/executions"[^>]*>Executions<\/a>/,
    )?.[0];
    expect(allAgentsTrigger).toContain('data-state="inactive"');
    expect(executionsTrigger).toContain('data-state="active"');
  });
});

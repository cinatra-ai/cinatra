import type { Metadata } from "next";

export const metadata: Metadata = { title: "Agents" };

// /agents is the "All Agents" tab (default) — the run-agent picker
// (cinatra#1007). This is the exact content formerly served at
// /agents/run — that route is removed, not redirected (old deep links/
// bookmarks to /agents/run intentionally 404). The dashboard that used to
// live here (top-5-recently-used + 5-latest widgets) moved to
// /agents/executions — see src/app/agents/executions/page.tsx.
export { NewAgentPageMount as default } from "@/app/plugins-routes";

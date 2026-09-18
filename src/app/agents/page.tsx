import type { Metadata } from "next";

import { AGENT_RUN_LABEL } from "@/lib/breadcrumb-trail";

// THE TAB MIRRORS THIS PAGE'S OWN TRAIL (cinatra#2934, fix leg 11).
//
// The ratified drawing: "the page that starts a run reads 'Agents > Agent run',
// never 'Run agent' alone", and "the browser-tab title mirrors the resolved
// trail under the same rules". Fix leg 10 taught the trail to keep the area
// crumb and append this page's own title beneath it; the tab still exported the
// AREA's word, so the proof round read the trail "Agents > Agent run" over a tab
// that said "Agents" - the two apart on one page. The title is the trail's
// resolved leaf, which is this page's own header word, taken from the one place
// that word is written.
export const metadata: Metadata = { title: AGENT_RUN_LABEL };

// /agents is the "All Agents" tab (default) — the run-agent picker
// (cinatra#1007). This is the exact content formerly served at
// /agents/run — that route is removed, not redirected (old deep links/
// bookmarks to /agents/run intentionally 404). The dashboard that used to
// live here (top-5-recently-used + 5-latest widgets) moved to
// /agents/executions — see src/app/agents/executions/page.tsx.
export { NewAgentPageMount as default } from "@/app/plugins-routes";

/**
 * THE PRODUCER INVENTORY SWEEP (cinatra#2701 change 1b, epic #2699 S2).
 *
 * The epic's rule is absolute: "No member-facing surface renders a link into
 * `/configuration` for a non-admin." A per-producer fixture proves each
 * producer we KNOW about. This suite proves we know about all of them.
 *
 * It scans the whole `src/` + `packages/` tree for a `/configuration` string in
 * a link-ish position and demands that every file it finds carries a recorded
 * DISPOSITION below. A new producer — a new nav entry, a new empty-state CTA, a
 * new approval source — therefore fails CI on the day it is written, with the
 * table as the place to state which of the four dispositions it takes:
 *
 *   gated-at-render  the file renders the link only for a platform admin;
 *                    the `gate` field names a token that must appear in it.
 *   admin-only-mount the file only ever renders under `/configuration` (or another
 *                    admin-gated route), so the segment gate already covers it.
 *   not-a-renderer   the occurrence is not a rendered link — a post-action
 *                    `redirect()`, a URL rewriter, a shared predicate, a value
 *                    carried in a payload that no surface links.
 *   suppressed-downstream  the file MINTS an href into row data, and every
 *                    renderer of that data drops it for a non-admin (the feed
 *                    view-model and the approvals MCP output).
 *
 * The scan deliberately excludes `src/app/configuration/**` (that IS the admin
 * segment) and `src/app/design-fixtures/**` (a static design harness with no
 * session), and skips tests and comment lines.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

type Disposition =
  | "gated-at-render"
  | "admin-only-mount"
  | "not-a-renderer"
  | "suppressed-downstream";

interface Entry {
  /** Why this disposition, in one line. */
  why: string;
  disposition: Disposition;
  /** Required for `gated-at-render`: a token proving the gate is still there. */
  gate?: RegExp;
}

// ---------------------------------------------------------------------------
// THE INVENTORY. Sorted by disposition, then by path.
// ---------------------------------------------------------------------------
const INVENTORY: Record<string, Entry> = {
  // ── gated at render: member-reachable, now admin-only ─────────────────────
  "src/components/command-menu.tsx": {
    why: "Cmd/Ctrl-K palette, mounted app-wide in SearchProvider; seven /configuration entries.",
    disposition: "gated-at-render",
    gate: /navGroupsForViewer\(viewerIsAdmin\)/,
  },
  "src/components/app-shell.tsx": {
    why: "Development toolbar's 'All development administration' link.",
    disposition: "gated-at-render",
    gate: /\{isAdmin \? \(\s*\n\s*<div className="mt-1 border-t border-warning\/20/,
  },
  "src/components/data-safety/object-history-panel.tsx": {
    why: "Per-event change-set link + the Restore-to-this-version button.",
    disposition: "gated-at-render",
    gate: /const viewerIsAdmin = isPlatformAdmin\(await getAuthSession\(\)/,
  },
  "src/components/extensions/install-activate-cta.tsx": {
    why: "Connector setup empty state's 'Install or activate' button (marketplace).",
    disposition: "gated-at-render",
    gate: /canInstall \? \(/,
  },
  "src/app/not-found.tsx": {
    why: "404 page's 'Open configuration' button — reachable by anyone.",
    disposition: "gated-at-render",
    gate: /\{viewerIsAdmin \? \(/,
  },
  "src/components/configuration-topbar-cog.tsx": {
    why: "Top-bar cog — the single discoverability entry to /configuration (pre-existing gate, #1563).",
    disposition: "gated-at-render",
    gate: /if \(!isAdmin\) return null;/,
  },
  "src/components/assistants/assistants-directory-client.tsx": {
    why: "Assistants toolbar's marketplace + upload items (pre-existing gate, isPlatformAdmin at the page).",
    disposition: "gated-at-render",
    gate: /\{canReachMarketplace \? \([\s\S]{0,1200}canUploadExtension \? \(/,
  },
  "packages/connectors/src/connectors-client.tsx": {
    why: "Three '/configuration/marketplace?tab=connector' CTAs (pre-existing gate, canReachMarketplace).",
    disposition: "gated-at-render",
    gate: /const showInstallCta = canReachMarketplace &&/,
  },
  "packages/agents/src/pages.tsx": {
    why: "Agent card 'More details' listing link, the missing-dependency CTA, and the empty-state marketplace button.",
    disposition: "gated-at-render",
    gate: /const viewerIsAdmin = isPlatformAdmin\(await getAuthSession\(\)/,
  },
  "packages/agents/src/instance-screens.tsx": {
    why: "Run-screen header link to the agent's marketplace listing.",
    disposition: "gated-at-render",
    gate: /if \(!packageName \|\| !viewerIsAdmin\) return null;/,
  },
  "packages/agents/src/orchestrator-screens.tsx": {
    why: "Orchestrator run-screen header link to the agent's marketplace listing.",
    disposition: "gated-at-render",
    gate: /if \(!packageName \|\| !viewerIsAdmin\) return null;/,
  },
  "packages/agents/src/agentic-run-panel.tsx": {
    why: "Run-error CTAs into /configuration/llm and /configuration/mcp.",
    disposition: "gated-at-render",
    gate: /const viewerIsAdmin = useViewerIsAdmin\(\)/,
  },
  "packages/chat/src/chat-error-display.tsx": {
    why: "Chat error card's 'Update your OpenAI API key' CTA into /configuration/llm.",
    disposition: "gated-at-render",
    gate: /const viewerIsAdmin = useViewerIsAdmin\(\)/,
  },
  "packages/objects/src/screens/object-detail-drawer.tsx": {
    why: "Object drawer History tab's 'Open full history' button.",
    disposition: "gated-at-render",
    gate: /const viewerIsAdmin = isPlatformAdmin\(await getAuthSession\(\)/,
  },

  // ── suppressed downstream: the href is DATA, dropped by every renderer ────
  "src/lib/approvals/sources/agent-creation-requests.ts": {
    why: "Sets the approval-detail href on every row; the feed view-model and the MCP output drop it for a non-admin.",
    disposition: "suppressed-downstream",
  },
  "src/lib/approvals/sources/marketplace-shared.ts": {
    why: "Marketplace moderation/self-status row hrefs; same two renderers drop them for a non-admin.",
    disposition: "suppressed-downstream",
  },
  "packages/agents/src/mcp/agent-creation-request-handlers.ts": {
    why: "Writes the author's decision notification; a NEW row carries the href only for an admin recipient.",
    disposition: "suppressed-downstream",
  },

  // ── admin-only mount: the file renders only under an admin-gated route ────
  "packages/extensions/src/screens/extension-settings-view.tsx": {
    why: "Renders under /configuration/extensions/[...] only.",
    disposition: "admin-only-mount",
  },
  "packages/extensions/src/screens/extensions-marketplace-screen.tsx": {
    why: "Renders under /configuration/marketplace only.",
    disposition: "admin-only-mount",
  },
  "packages/extensions/src/screens/installed-empty-states.tsx": {
    why: "Renders inside the registry catalog screen under /configuration only.",
    disposition: "admin-only-mount",
  },
  "packages/extensions/src/screens/registry-catalog-screen.tsx": {
    why: "The /configuration/extensions catalog itself.",
    disposition: "admin-only-mount",
  },
  "packages/extensions/src/screens/marketplace-install-form.tsx": {
    why: "Renders under /configuration/marketplace only.",
    disposition: "admin-only-mount",
  },
  "packages/agents/src/screens.tsx": {
    why: "RegistryPermissionsScreen + AgentBuilderImportScreen — both mount under /configuration only.",
    disposition: "admin-only-mount",
  },
  "packages/agents/src/import-form.tsx": {
    why: "The upload form of /configuration/extensions/upload.",
    disposition: "admin-only-mount",
  },
  "packages/sdk-ui/src/nango-managed-api-card.tsx": {
    why: "Renders on /configuration/llm only.",
    disposition: "admin-only-mount",
  },
  "src/components/instance-setup-required-card.tsx": {
    why: "Rendered by /configuration/extensions and /configuration/environment only.",
    disposition: "admin-only-mount",
  },
  "src/components/marketplace-detail-header.tsx": {
    why: "Rendered by /configuration/marketplace/[scope]/[name] only.",
    disposition: "admin-only-mount",
  },
  "packages/permissions/src/settings-card.tsx": {
    why: "Exported but mounted nowhere; no member-reachable renderer exists.",
    disposition: "admin-only-mount",
  },

  // ── not a renderer ────────────────────────────────────────────────────────
  "src/lib/configuration-href.ts": {
    why: "The shared predicate this whole sweep is built on; mints no href.",
    disposition: "not-a-renderer",
  },
  "src/app/providers.tsx": {
    why: "Rewrites a better-auth-ui URL (/configuration/workspace/settings → /configuration/workspace); the organization views it configures mount under /configuration only.",
    disposition: "not-a-renderer",
  },
  "src/app/campaigns/actions.ts": {
    why: "Post-action redirect()s; the actions carry their own requireAdminSession gates (S1, #2700).",
    disposition: "not-a-renderer",
  },
  "src/app/plugins-registry.tsx": {
    why: "Server redirect() for a plugin modal deep link — no rendered control.",
    disposition: "not-a-renderer",
  },
  "packages/agents/src/actions.ts": {
    why: "Post-action redirect()s back to the admin extensions list.",
    disposition: "not-a-renderer",
  },
  "packages/extensions/src/actions.ts": {
    why: "Post-action redirect()s back to the admin extensions list.",
    disposition: "not-a-renderer",
  },
  "packages/agents/src/agent-error-display.ts": {
    why: "Exports the two CTA href CONSTANTS; the renderers (agentic-run-panel) gate them.",
    disposition: "not-a-renderer",
  },
  "src/lib/agent-llm-preflight.ts": {
    why: "Carries settingsHref inside an error payload; no surface renders it as a link.",
    disposition: "not-a-renderer",
  },
};

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set(["node_modules", ".next", "__tests__", "dist", ".git"]);
const EXCLUDED_PREFIXES = ["src/app/configuration/", "src/app/design-fixtures/"];
/** A `/configuration` occurrence in a link-ish position. */
const LINKISH = /(href|Href|HREF|router\.push\(|redirect\(|\bLink\b)/;

function scan(): Map<string, number[]> {
  const hits = new Map<string, number[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      const rel = path.relative(REPO_ROOT, full).split(path.sep).join("/");
      if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;
      readFileSync(full, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!line.includes("/configuration")) return;
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
          if (!LINKISH.test(line)) return;
          const at = hits.get(rel) ?? [];
          at.push(i + 1);
          hits.set(rel, at);
        });
    }
  };
  // NOTE the leading-segment match: a bare "extensions" skip would also swallow
  // `packages/extensions` and `src/components/extensions`, hiding real producers.
  for (const root of ["src", "packages"]) walk(path.join(REPO_ROOT, root));
  return hits;
}

const HITS = scan();

describe("cinatra#2701 — the /configuration producer inventory is complete", () => {
  it("the scan finds producers at all (the sweep is not vacuous)", () => {
    expect(HITS.size).toBeGreaterThanOrEqual(30);
  });

  it("EVERY file that mints a /configuration link has a recorded disposition", () => {
    const unrecorded = [...HITS.keys()].filter((f) => !(f in INVENTORY)).sort();
    expect(
      unrecorded,
      `New /configuration producer(s) with no recorded disposition. Add each to ` +
        `INVENTORY in this file with one of: gated-at-render | admin-only-mount | ` +
        `not-a-renderer | suppressed-downstream — and make it true first.`,
    ).toEqual([]);
  });

  it("the inventory carries no stale entry (every recorded file still has a hit)", () => {
    const stale = Object.keys(INVENTORY).filter((f) => !HITS.has(f)).sort();
    // `agentic-run-panel.tsx` reaches /configuration through imported constants,
    // so it has no literal hit; it is recorded because it RENDERS them.
    expect(stale).toEqual(["packages/agents/src/agentic-run-panel.tsx"]);
  });

  it("every gated-at-render producer still carries its gate", () => {
    for (const [file, entry] of Object.entries(INVENTORY)) {
      if (entry.disposition !== "gated-at-render") continue;
      expect(entry.gate, `${file}: gated-at-render requires a gate pattern`).toBeDefined();
      expect(read(file), `${file}: gate no longer present — ${entry.why}`).toMatch(
        entry.gate as RegExp,
      );
    }
  });

  it("every entry states why", () => {
    for (const [file, entry] of Object.entries(INVENTORY)) {
      expect(entry.why.length, `${file}: empty rationale`).toBeGreaterThan(20);
    }
  });
});

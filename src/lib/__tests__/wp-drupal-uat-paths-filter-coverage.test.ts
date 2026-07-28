// cinatra#1919 — WP/Drupal UAT gate paths-filter coverage regression.
//
// The gate at `.github/workflows/wp-drupal-uat.yml` runs the (expensive) full
// UAT suite on a PR only when a `relevant`-listed path changes. The suite boots
// the real app (`pnpm dev`) and drives the hosted-LLM MCP write path, so the
// filter MUST cover the modules that boot actually exercises — otherwise a PR
// changing a real boot-dependency skips the suite and gets a MISLEADING green
// required check (the exact defect in cinatra#1919: a PR touching only
// `src/lib/external-mcp-registry.ts` produced `run_uat=false`).
//
// This guard fails when a boot-dependency module is dropped from the filter, or
// when a listed exact-file path stops existing (a rename that would silently
// stop triggering the gate). It is intentionally a plain text parse — the repo
// ships no YAML parser and the filter block is a simple `- '<glob>'` list.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github/workflows/wp-drupal-uat.yml",
);

// The boot-dependency modules the suite exercises and that MUST keep the gate
// running. `external-mcp-registry.ts` is the cinatra#1919 addition; the others
// are pre-existing critical boot inputs pinned here so a future filter edit
// cannot silently drop them.
const REQUIRED_BOOT_DEPENDENCY_PATHS = [
  "src/lib/external-mcp-registry.ts",
  "src/lib/dev-auto-setup.ts",
  "src/lib/wordpress-mcp-connection.ts",
  "src/lib/wp-drupal-contract.ts",
  "packages/llm/src/scripted-test-provider.ts",
  // S5 iframe cutover (cinatra#1221): the WP/Drupal widget frames the
  // Cinatra-served /embed/assistant page, so the suite now boots + drives that
  // surface. A regression in the embed page, the frame-ancestors resolver, the
  // assistant chat route, or the route-guard that sets the frame-ancestors CSP
  // breaks the suite — these are real boot dependencies and MUST trigger run_uat.
  "src/app/embed/assistant/**",
  "src/lib/embed/**",
  "src/app/api/assistants/chat/**",
  "src/lib/auth-route-guard.ts",
  // cinatra#2036 (surfaced by #2031): the assistant/widget/boot MOUNT + TURN
  // closure the suite's scenarios 4/5/6 actually execute. The #2031
  // out-of-audience regression lived in the audience closure + the closed
  // handle→built-in binding; the whole PR family behind it (#1915 registry,
  // #1935 chat/boot, #1991 widget) changed ONLY paths like these and fast-passed
  // the PR gate. Keep this set equal to the workflow's `relevant` additions.
  // Assistant registry + audience closure (scenarios 4/5 assistant visibility):
  "src/lib/assistant-registry-reader.ts",
  "src/lib/assistant-registry-schema.ts",
  "src/lib/assistant-audience-closure.ts",
  "src/lib/assistant-selector-audience.ts",
  "src/lib/assistant-widget-handles.ts",
  // Assistant boot-seed closure (the WP/Drupal built-in siblings the widget binds
  // to are minted at boot; a regression here means the assistant never exists):
  "src/lib/assistant-agent-registration.ts",
  "src/lib/assistant-users.ts",
  "src/lib/assistant-config.ts",
  "packages/agents/src/builtin-assistant-template.ts",
  // The assistant turn runtime + the chat runner/dispatch it runs through:
  "src/lib/assistant-runtime/**",
  "src/app/api/chat/**",
  "packages/chat/src/**",
  // Widget auth/broker — the dual-token sequence gating the widget turn + mints:
  "src/lib/widget-broker-route.ts",
  "src/lib/widget-token-broker.ts",
  "src/lib/widget-user-auth.ts",
  "src/lib/widget-stream-agents.server.ts",
  "src/lib/widget-stream-auth.ts",
  "src/lib/widget-auth-audit.ts",
  "src/lib/widget-mcp-actor-token.ts",
  "src/lib/widget-chat-resume-token.ts",
  "src/app/api/widget-auth/**",
  // The surviving cit_ transport-token mint the suite hits before every widget
  // turn (POST /api/agents/{slug}/token; global-setup + scenarios 4/5).
  "src/app/api/agents/*/token/**",
  // Boot orchestration/phases the mount + assistant seeding depend on:
  "src/lib/boot/**",
  // cinatra#2165 — the Drupal companion image + its entrypoint. The suite's
  // Drupal scenarios run against a container compose BUILDS from
  // docker/drupal/Dockerfile and boots via scripts/drupal-entrypoint.sh, so a
  // base-image major or a bootstrap rewrite changes the subject under test.
  // A php base-image bump previously fast-passed this gate.
  "docker/drupal/**",
  "scripts/drupal-entrypoint.sh",
];

/**
 * Extract the `relevant:` filter globs from the dorny/paths-filter `filters:`
 * block. Collects `- '<glob>'` entries after the `relevant:` key until the
 * indentation dedents back to (or past) the key's own indent on a non-list line
 * (the next filter key or job) — i.e. the end of the `relevant` list.
 */
function readRelevantFilterGlobs(): string[] {
  const src = readFileSync(WORKFLOW_PATH, "utf8");
  const lines = src.split("\n");
  const keyIdx = lines.findIndex((l) => /^\s*relevant:\s*$/.test(l));
  if (keyIdx === -1) {
    throw new Error(
      "wp-drupal-uat.yml: could not find a `relevant:` filter key — the UAT gate structure changed; update this guard.",
    );
  }
  const keyIndent = lines[keyIdx].match(/^\s*/)![0].length;
  const globs: string[] = [];
  for (let i = keyIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.match(/^\s*/)![0].length;
    const listMatch = line.match(/^\s*-\s*'([^']+)'\s*$/);
    if (listMatch) {
      globs.push(listMatch[1]);
      continue;
    }
    // A non-list line at or below the key's indent ends the `relevant` block.
    if (indent <= keyIndent) break;
  }
  return globs;
}

describe("cinatra#1919 — WP/Drupal UAT paths-filter covers the suite's boot dependencies", () => {
  const globs = readRelevantFilterGlobs();

  it("parses a non-trivial `relevant` filter list", () => {
    expect(globs.length).toBeGreaterThanOrEqual(REQUIRED_BOOT_DEPENDENCY_PATHS.length);
  });

  it("covers external-mcp-registry.ts (the cinatra#1919 regression: it must trigger run_uat)", () => {
    expect(globs).toContain("src/lib/external-mcp-registry.ts");
  });

  it.each(REQUIRED_BOOT_DEPENDENCY_PATHS)(
    "covers boot-dependency module %s",
    (required) => {
      expect(globs).toContain(required);
    },
  );

  it("every exact-file glob in the filter still exists (a rename would silently stop triggering the gate)", () => {
    const missing = globs
      .filter((g) => !g.includes("*")) // only exact file paths, not directory globs
      .filter((g) => !existsSync(path.join(REPO_ROOT, g)));
    expect(missing, `filter references non-existent path(s): ${missing.join(", ")}`).toEqual([]);
  });
});

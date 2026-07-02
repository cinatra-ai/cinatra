// cinatra#408 — PRODUCTION POLICY INVARIANT (anti-revert regression).
//
// The interactive widget-stream route is FAIL-CLOSED BY DEFAULT: a request to a
// content-editor widget agent that omits the per-user `cwu_` token is denied
// (the install/site identity may NEVER be used for a public_site_widget edit).
// The route enforces this via `entry.auth.requireUserToken !== false`, so an
// entry whose `requireUserToken` flag is ABSENT (undefined) still enforces.
//
// This suite reads the REAL generated manifest (NOT a mock) and pins that the
// production content-editor entries do NOT carry an explicit `false` opt-out —
// i.e. they ENFORCE. If a future manifest change silently set
// `requireUserToken: false` on these production entries, the confused-deputy
// bypass would reopen (omit the user token → install identity). This test trips
// FIRST in that case, forcing a deliberate, reviewed decision (and a matching
// security rationale) rather than a silent revert to opt-in-off.
import { describe, expect, it } from "vitest";

import { GENERATED_WIDGET_STREAM_AGENTS } from "@/lib/generated/extensions.server";

// The real production interactive widget surfaces (content-editor relays). Each
// MUST enforce the per-user token by default.
const PRODUCTION_CONTENT_EDITOR_SLUGS = [
  "wordpress-content-editor",
  "drupal-content-editor",
] as const;

// The route gate: enforce unless the entry EXPLICITLY opts out with `false`.
// Mirrors src/app/api/agents/[agentSlug]/stream/route.ts. Kept here as the
// single source of truth the invariant asserts against the real manifest.
function entryEnforcesUserToken(auth: { requireUserToken?: boolean }): boolean {
  return auth.requireUserToken !== false;
}

describe("cinatra#408 — production widget content-editor entries enforce the per-user token", () => {
  it("the real generated manifest still ships both production content-editor slugs", () => {
    // Anti-vacuity: if the slugs ever rename/disappear the per-slug assertions
    // below would pass vacuously; pin their presence first.
    for (const slug of PRODUCTION_CONTENT_EDITOR_SLUGS) {
      expect(GENERATED_WIDGET_STREAM_AGENTS[slug], slug).toBeTruthy();
    }
  });

  it.each(PRODUCTION_CONTENT_EDITOR_SLUGS)(
    "%s ENFORCES the per-user token (no silent opt-out)",
    (slug) => {
      const entry = GENERATED_WIDGET_STREAM_AGENTS[slug];
      // The production entries carry an `auth` block but must NOT opt out.
      expect(entry.auth.requireUserToken, `${slug}.auth.requireUserToken`).not.toBe(false);
      // The exact route-gate predicate must resolve to ENFORCE for these.
      expect(entryEnforcesUserToken(entry.auth), `${slug} fail-closed gate`).toBe(true);
    },
  );

  it("NO production widget-stream relay entry opts OUT of the per-user token", () => {
    // Broad invariant (codex-recommended): any generated widget-stream entry that
    // declares a relayAgentPackage (i.e. a real content-editor relay surface) must
    // not carry `requireUserToken: false`. A deliberate future opt-out must update
    // this test WITH a security rationale, never slip in silently.
    for (const [slug, entry] of Object.entries(GENERATED_WIDGET_STREAM_AGENTS)) {
      if (!entry.relayAgentPackage) continue;
      expect(entry.auth.requireUserToken, `${slug} (relay) must not opt out`).not.toBe(false);
      expect(entryEnforcesUserToken(entry.auth), `${slug} (relay) fail-closed`).toBe(true);
    }
  });
});

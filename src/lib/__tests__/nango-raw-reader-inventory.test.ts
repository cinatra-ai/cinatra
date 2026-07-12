/**
 * Raw credential-reader caller-inventory RATCHET (cinatra#952 W2).
 *
 * Every call site of the connection-addressed credential primitives
 * (`getNangoCredentials` / `buildBearerAuthHeaderFromNango` /
 * `getNangoConnection` — the third returns credentials too) is enumerated
 * here with its gating status. The per-connection use-gate (W2) fronts the
 * gated sites; the REST are pinned residue with their migration wave — a NEW
 * un-pinned call site (or a count growth in a pinned file) FAILS this test,
 * so no ungated credential read can be added silently. Same shape as the
 * postgres-sync-inventory ratchet.
 *
 * Extension repos under extensions/ are SEPARATE repos (not scanned here);
 * their reads hold the first-party `nango-system` ctx capability (reserved in
 * src/lib/extension-host-context.ts — pinned below) and are the W3/W4 fleet
 * wave of epic #950.
 *
 * Statuses:
 *   gated-by-w2        — behind `enforceConnectionUse`/the resolver.
 *   primitive-surface  — the host delegating wrappers / SDK contract types
 *                        themselves (the surface, not consumers).
 *   dev-only           — dev auto-setup, never a prod path.
 *   system-credential  — machine credentials outside the per-user connection
 *                        model (registry publish secrets).
 *   w3-residue         — connector consumer to be re-routed in W3 (actor
 *                        threading / instance-flow identity seeding).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["src", "packages"];
const CALL_RE = /\b(?:getNangoCredentials|buildBearerAuthHeaderFromNango|getNangoConnection)\s*\(/g;

const PINNED: Record<string, { count: number; status: string; note?: string }> = {
  "packages/sdk-extensions/src/nango-system-contract.ts": {
    count: 3,
    status: "primitive-surface",
    note: "contract member declarations, not calls",
  },
  "src/lib/nango-system.ts": { count: 3, status: "primitive-surface" },
  // src/lib/dev-auto-setup.ts retired (cinatra#976, epic #978 W-D): the 4
  // dev-only nango raw reads moved OUT of core into the owning connector
  // `dev-setup.ts` hooks (extensions/, separate repos — not scanned here); the
  // core shell is now vendor-neutral and reads no nango credential.
  // The five vendor connection clients (wordpress/drupal/linkedin/github/
  // youtube) relocated into their owning connectors (cinatra#975 Wave 3 core
  // eviction; extensions/ are separate repos — not scanned here). Their raw
  // reads now ride the first-party `nango-system` ctx capability and the
  // #1077 instance-connection-gate seam, pinned by each connector's own test
  // suite.
  "src/lib/registry-credentials.ts": {
    count: 2,
    status: "system-credential",
    note: "registry publish request-secrets/tokens — machine creds, not user connections",
  },
  "src/lib/external-mcp-registry.ts": {
    count: 3,
    status: "gated-by-w2",
    note: "bearer mint behind gateExternalMcpConnectionUse; Twenty import readback; setup-page apiKey import readback (cinatra#1407 — write-time verify, not a use-time read)",
  },
  "src/lib/extension-host-context.ts": {
    count: 2,
    status: "w3-residue",
    note: "first-party extension ctx capability (reserved surface) — W3/W4 fleet wave",
  },
  "src/lib/drupal-mcp-connection.ts": {
    count: 1,
    status: "gated-by-w2",
    note: "cinatra#967: getDrupalMcpInstanceStatuses gates the per-instance Bearer resolution via enforceInstanceConnectionUse (self-heal identity seeding + actor threading)",
  },
  "packages/google-oauth-connection/src/index.ts": {
    count: 1,
    status: "w3-residue",
    note: "scope:'user' reads stay strictly per-actor (only:'user' class)",
  },
  "packages/agents/src/execution.ts": { count: 1, status: "w3-residue" },
  "packages/agents/src/a2a-actions.ts": { count: 1, status: "w3-residue" },
};

function scan(dir: string, hits: Map<string, number>): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      scan(p, hits);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.|\.spec\./.test(entry)) continue;
    const text = readFileSync(p, "utf8");
    const count = (text.match(CALL_RE) ?? []).length;
    if (count > 0) hits.set(relative(REPO_ROOT, p), count);
  }
}

describe("nango raw credential-reader inventory ratchet", () => {
  const hits = new Map<string, number>();
  for (const root of SCAN_ROOTS) scan(join(REPO_ROOT, root), hits);

  it("every raw-reader call site is pinned with a status (no new ungated site)", () => {
    const unpinned = [...hits.entries()].filter(([file]) => !PINNED[file]);
    expect(
      unpinned,
      `NEW raw credential-reader call site(s) detected: ${JSON.stringify(unpinned)}. ` +
        "Route the read through the cinatra#952 per-connection use-gate (or pin it " +
        "here with a reviewed status + justification).",
    ).toEqual([]);
  });

  it("no pinned file's call count grows (ratchet), and stale pins are retired", () => {
    for (const [file, pin] of Object.entries(PINNED)) {
      const current = hits.get(file) ?? 0;
      expect(
        current,
        `${file}: expected ${pin.count} raw-reader call(s) (${pin.status}), found ${current}. ` +
          "A GROWTH must go through the use-gate; a SHRINK should update this pin to lock the win in.",
      ).toBe(pin.count);
    }
  });
});

// Extension naming-conformance policy.
//
// Walks `extensions/<scope>/<pkg>/package.json` and enforces the rules
// documented at https://docs.cinatra.ai/references/platform/extensions/ ("Naming conventions"). This
// test is the source of truth for what counts as conforming: the doc
// describes it for humans; this enforces it for CI.
//
// Three explicit lists carry the current policy state:
//   - transitionalAllowlist  : known package exceptions that must still fail
//                              at least one rule
//   - grandfatherList        : existing package names allowed to remain while
//                              they still match their tracked constraints
//   - oldNameDenylist        : forbidden package names; package-name surface
//                              scope only (no repo-wide grep)
//
// The policy fails CI when a new extension trips the rule without an
// allowlist entry. The allowlist mechanism keeps known exceptions visible
// without blocking legitimate work.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── repo + extensions roots ─────────────────────────────────────────────
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const EXTENSIONS_ROOT = path.join(REPO_ROOT, "extensions");

// ─── kind scope policy (per https://docs.cinatra.ai/references/platform/extensions/) ────────────────
// Workflow is the fifth extension kind.
type Kind = "agent" | "connector" | "artifact" | "skill" | "workflow";

const KIND_SCOPE_POLICY: Record<Kind, "first-party-only" | "any-scope" | "first-party-plus-vendored"> = {
  agent: "first-party-only",
  connector: "any-scope",
  artifact: "first-party-only",
  skill: "first-party-plus-vendored",
  // Workflow extensions are first-party-authored marketplace packages.
  // First-party-only matches the agent/artifact policy.
  workflow: "first-party-only",
};

const FIRST_PARTY_SCOPE = "@cinatra-ai";

// Vendored-skill scopes that may use the `VendoredPackageName` shape (no -kind suffix).
const VENDORED_SKILL_SCOPE_ALLOWLIST: ReadonlySet<string> = new Set(["@anthropics"]);

// Exact-name vendored package allowlist (matches `<scope>/<slug>` without a -kind suffix).
const VENDORED_PACKAGE_NAME_ALLOWLIST: ReadonlySet<string> = new Set(["@anthropics/skills"]);

// ─── orchestrator-topology forbidden tokens ──────────────────────────────
// Forbidden as suffix OR prefix on `kind: "agent"` slugs (applied AFTER
// the trailing -agent suffix has been stripped). Also catches exact-token
// slugs where the topology token IS the role (e.g. `pipeline-agent`).
const FORBIDDEN_TOPOLOGY_TOKENS: ReadonlyArray<RegExp> = [
  // exact-token (slug after -agent strip equals the token)
  /^pipeline$/,
  /^orchestrator$/,
  /^handler$/,
  /^child$/,
  /^stage-\d+$/,
  // suffix form
  /-pipeline$/,
  /-orchestrator$/,
  /-handler$/,
  /-child$/,
  /-stage-\d+$/,
  // prefix form
  /^pipeline-/,
  /^orchestrator-/,
  /^handler-/,
  /^child-/,
  /^stage-\d+-/,
];

// ─── transitional allowlist ──────────────────────────────────────────────
// Known package exceptions. Each entry must still fail at least one rule.
const transitionalAllowlist: ReadonlyArray<{ packageName: string; reason: string }> = [];

// ─── grandfather list ────────────────────────────────────────────────────
// Existing names that are allowed but still tracked. Advisory-only: no fail.
const grandfatherList: ReadonlyArray<{ packageName: string; reason: string }> = [
  {
    packageName: "@cinatra-ai/blog-pipeline-agent",
    reason:
      "Orchestrator-topology suffix. Allowed until the package role or decomposition is settled.",
  },
  {
    packageName: "@cinatra-ai/blog-linkedin-publish-agent",
    reason:
      "Workflow-coupled (hardcoded to blog_post_publish_linkedin_* primitives). Allowed until the package is generalized.",
  },
  {
    packageName: "@cinatra-ai/blog-linkedin-writer-agent",
    reason:
      "Workflow-coupled (blog-specific input schema). Allowed until the package is generalized.",
  },
  {
    packageName: "@cinatra-ai/blog-draft-writer-agent",
    reason: "Domain-prefixed role noun is allowed by rule; entry kept for tracking only.",
  },
  {
    packageName: "@cinatra-ai/blog-idea-generator-agent",
    reason: "Domain-prefixed role noun; tracked for possible generalization.",
  },
  {
    packageName: "@cinatra-ai/blog-image-prompt-agent",
    reason: "Domain-prefixed role noun; tracked for possible generalization.",
  },
  {
    packageName: "@cinatra-ai/blog-wordpress-publish-agent",
    reason: "Workflow-coupled; allowed until the package is generalized.",
  },
  {
    packageName: "@cinatra-ai/email-drafting-agent",
    reason: "Workflow-coupled email family; allowed until the package is generalized.",
  },
  {
    packageName: "@cinatra-ai/email-follow-up-agent",
    reason: "Workflow-coupled email family; allowed until the package is generalized.",
  },
  {
    packageName: "@cinatra-ai/email-recipient-selection-agent",
    reason: "Workflow-coupled email family; allowed until the package is generalized.",
  },
  {
    packageName: "@cinatra-ai/email-delivery-agent",
    reason: "Workflow-coupled email family; allowed until the package is generalized.",
  },
];

// ─── old-name denylist ───────────────────────────────────────────────────
// Forbidden package names. Package-name surface scope only (NOT a
// repo-wide string grep).
const oldNameDenylist: ReadonlyArray<{ packageName: string; reason: string }> = [
  {
    packageName: "@cinatra-ai/claude-connector",
    reason:
      "Use @cinatra-ai/mcp-client-registry-connector. The package is the inbound MCP-client registry, not a Claude integration.",
  },
  {
    packageName: "@cinatra-ai/skill-creator",
    reason:
      "Reference the vendored @anthropics/skills:skill-creator bundle instead.",
  },
  {
    packageName: "@cinatra-ai/context-agent",
    reason:
      "Use @cinatra-ai/context-selection-agent. The compatibility renderer-id alias is retained for paused-run safety; see packages/agents/src/context-selector-renderer.tsx CONTEXT_SELECTOR_RENDERER_LEGACY_ID.",
  },
];

// ─── helpers ─────────────────────────────────────────────────────────────

interface ExtensionPackage {
  dirAbs: string;
  vendorScope: string; // "cinatra-ai", "anthropics", "example-namespace", ...
  dirBasename: string;
  packageJsonPath: string;
  manifest: Record<string, unknown>;
}

function readExtensions(): ExtensionPackage[] {
  const result: ExtensionPackage[] = [];
  const vendorDirs = fs
    .readdirSync(EXTENSIONS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const vendorScope of vendorDirs) {
    const vendorDirAbs = path.join(EXTENSIONS_ROOT, vendorScope);
    const pkgEntries = fs
      .readdirSync(vendorDirAbs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const dirBasename of pkgEntries) {
      const dirAbs = path.join(vendorDirAbs, dirBasename);
      const packageJsonPath = path.join(dirAbs, "package.json");
      if (!fs.existsSync(packageJsonPath)) continue;
      const raw = fs.readFileSync(packageJsonPath, "utf-8");
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      result.push({ dirAbs, vendorScope, dirBasename, packageJsonPath, manifest });
    }
  }
  return result;
}

function getCinatraBlock(manifest: Record<string, unknown>): {
  apiVersion?: string;
  kind?: string;
} {
  const c = (manifest.cinatra ?? {}) as Record<string, unknown>;
  return {
    apiVersion: typeof c.apiVersion === "string" ? c.apiVersion : undefined,
    kind: typeof c.kind === "string" ? c.kind : undefined,
  };
}

function isVendoredExactName(packageName: string): boolean {
  return VENDORED_PACKAGE_NAME_ALLOWLIST.has(packageName);
}

function parsePackageName(packageName: string): { scope: string; slug: string } | null {
  const m = /^(@[^/]+)\/(.+)$/.exec(packageName);
  return m ? { scope: m[1], slug: m[2] } : null;
}

function scopeAllowedForKind(scope: string, kind: Kind, packageName: string): boolean {
  const policy = KIND_SCOPE_POLICY[kind];
  switch (policy) {
    case "first-party-only":
      return scope === FIRST_PARTY_SCOPE;
    case "any-scope":
      return true; // Generic vendor policy
    case "first-party-plus-vendored":
      if (scope === FIRST_PARTY_SCOPE) return true;
      if (VENDORED_SKILL_SCOPE_ALLOWLIST.has(scope) && isVendoredExactName(packageName)) return true;
      return false;
  }
}

function dirSuffixForKind(kind: Kind): string {
  // Singular kind → directory suffix
  return kind === "skill" ? "-skills" : `-${kind}`;
}

function isAllowedDirShapeForKind(dirBasename: string, kind: Kind, packageName: string): boolean {
  // Vendored carve-out: dir basename matches the slug portion of the vendored name (no -kind suffix).
  if (isVendoredExactName(packageName)) {
    const parsed = parsePackageName(packageName);
    if (parsed && dirBasename === parsed.slug) return true;
  }
  const suffix = dirSuffixForKind(kind);
  return dirBasename.endsWith(suffix);
}

function isInTransitionalAllowlist(packageName: string): boolean {
  return transitionalAllowlist.some((e) => e.packageName === packageName);
}

function isInGrandfatherList(packageName: string): boolean {
  return grandfatherList.some((e) => e.packageName === packageName);
}

function isInOldNameDenylist(packageName: string): boolean {
  return oldNameDenylist.some((e) => e.packageName === packageName);
}

function hitsTopologyToken(slug: string): RegExp | null {
  for (const re of FORBIDDEN_TOPOLOGY_TOKENS) {
    if (re.test(slug)) return re;
  }
  return null;
}

// ─── rule evaluator (used by both per-extension tests and bookkeeping) ───

interface RuleResult {
  rule: string;
  ok: boolean;
  message?: string;
}

function evaluateAllRules(ext: ExtensionPackage, opts: { skipTopologyForGrandfathered?: boolean } = {}): RuleResult[] {
  const out: RuleResult[] = [];
  const packageName = (ext.manifest.name ?? "") as string;
  const { apiVersion, kind } = getCinatraBlock(ext.manifest);
  const parsed = parsePackageName(packageName);

  // Rule: dir basename matches unscoped package name
  if (!parsed) {
    out.push({ rule: "dir-basename-match-name", ok: false, message: `package.json#name not @scope/slug-shaped: ${packageName}` });
  } else {
    out.push({
      rule: "dir-basename-match-name",
      ok: parsed.slug === ext.dirBasename,
      message: parsed.slug === ext.dirBasename ? undefined : `dir ${ext.dirBasename} != unscoped name ${parsed.slug}`,
    });
  }

  // Rule: cinatra block well-formed
  const cinatraOk = apiVersion === "cinatra.ai/v1" && kind !== undefined && ["agent", "connector", "artifact", "skill", "workflow"].includes(kind);
  out.push({
    rule: "cinatra-block-shape",
    ok: cinatraOk,
    message: cinatraOk ? undefined : `${packageName}: cinatra.apiVersion=${apiVersion ?? "MISSING"} kind=${kind ?? "MISSING"}`,
  });

  // Rule: dir suffix matches kind
  if (kind) {
    const dirOk = isAllowedDirShapeForKind(ext.dirBasename, kind as Kind, packageName);
    out.push({
      rule: "dir-suffix-matches-kind",
      ok: dirOk,
      message: dirOk ? undefined : `dir ${ext.dirBasename} does not match suffix for kind=${kind}`,
    });
  } else {
    out.push({ rule: "dir-suffix-matches-kind", ok: false, message: "kind missing — cannot evaluate suffix" });
  }

  // Rule: scope allowed for kind
  if (kind && parsed) {
    const scopeOk = scopeAllowedForKind(parsed.scope, kind as Kind, packageName);
    out.push({
      rule: "scope-allowed-for-kind",
      ok: scopeOk,
      message: scopeOk ? undefined : `scope ${parsed.scope} not allowed for kind=${kind}`,
    });
  } else {
    out.push({ rule: "scope-allowed-for-kind", ok: false, message: "kind or scope missing — cannot evaluate" });
  }

  // Rule: no orchestrator-topology tokens (agents only; grandfathered may be skipped)
  if (kind === "agent" && parsed) {
    const inGrandfather = isInGrandfatherList(packageName);
    if (opts.skipTopologyForGrandfathered && inGrandfather) {
      // grandfathered — exclude from results
    } else {
      const slug = parsed.slug.replace(/-agent$/, "");
      const hit = hitsTopologyToken(slug);
      out.push({
        rule: "no-topology-tokens",
        ok: hit === null,
        message: hit === null ? undefined : `slug ${slug} matches forbidden topology token /${hit.source}/`,
      });
    }
  }

  // Rule: not in oldNameDenylist
  out.push({
    rule: "not-in-oldNameDenylist",
    ok: !isInOldNameDenylist(packageName),
    message: isInOldNameDenylist(packageName) ? `${packageName} is on the forbidden-name denylist` : undefined,
  });

  return out;
}

// ─── tests ───────────────────────────────────────────────────────────────

describe("naming-conformance policy", () => {
  const extensions = readExtensions();

  it("discovers at least one extension package", () => {
    expect(extensions.length).toBeGreaterThan(0);
  });

  describe("per-extension rules", () => {
    for (const ext of extensions) {
      const packageName = (ext.manifest.name ?? "") as string;
      const inTransitional = isInTransitionalAllowlist(packageName);
      const results = evaluateAllRules(ext, { skipTopologyForGrandfathered: true });

      for (const r of results) {
        const label = `${ext.vendorScope}/${ext.dirBasename}: ${r.rule}`;
        if (inTransitional) {
          // Transitional packages are EXPECTED to fail one or more rules;
          // the per-rule it() still runs (so a fix becomes visible) but
          // the expectation is INVERTED for the rule(s) the entry covers.
          // The book-keeping test below asserts at least one rule still
          // fails; this loop just reports per-rule status so the dev sees
          // exactly which rules are deferred.
          //
          // To avoid spurious red CI for transitional entries on rules
          // they happen to pass, we mark these as `skip` here — the
          // bookkeeping test is the actual enforcement.
          it.skip(`${label} [TRANSITIONAL — tracked exception]`, () => {});
        } else {
          it(label, () => {
            expect(r.ok, r.message ?? "").toBe(true);
          });
        }
      }
    }
  });

  describe("allowlist book-keeping (fails when an exception is fixed but allowlist stale)", () => {
    it("every transitional allowlist entry resolves to an on-disk package", () => {
      const onDiskNames = new Set(extensions.map((e) => (e.manifest.name ?? "") as string));
      for (const entry of transitionalAllowlist) {
        expect(
          onDiskNames.has(entry.packageName),
          `transitionalAllowlist entry ${entry.packageName} not found on disk — remove it from the allowlist`,
        ).toBe(true);
      }
    });

    // For each transitional entry, assert at least one rule still fails.
    // When a package fix lands and every rule passes, this test fails with a clear
    // "remove the allowlist entry" message. That is the desired signal.
    for (const entry of transitionalAllowlist) {
      it(`transitional ${entry.packageName} still violates at least one rule (remove from allowlist once green)`, () => {
        const ext = extensions.find((e) => ((e.manifest.name ?? "") as string) === entry.packageName);
        expect(ext, `${entry.packageName} not found on disk`).toBeDefined();
        if (!ext) return;
        const results = evaluateAllRules(ext, { skipTopologyForGrandfathered: false });
        const failures = results.filter((r) => !r.ok);
        expect(
          failures.length,
          `${entry.packageName} no longer fails any naming rule — remove it from transitionalAllowlist. Reason was: ${entry.reason}`,
        ).toBeGreaterThan(0);
      });
    }

    it("oldNameDenylist entries do not appear as on-disk packages", () => {
      const onDiskNames = new Set(extensions.map((e) => (e.manifest.name ?? "") as string));
      for (const entry of oldNameDenylist) {
        expect(
          onDiskNames.has(entry.packageName),
          `oldNameDenylist entry ${entry.packageName} still present on disk — remove the forbidden package name`,
        ).toBe(false);
      }
    });

    it("grandfatherList entries all exist on disk (else they're noise)", () => {
      const onDiskNames = new Set(extensions.map((e) => (e.manifest.name ?? "") as string));
      for (const entry of grandfatherList) {
        expect(
          onDiskNames.has(entry.packageName),
          `grandfatherList entry ${entry.packageName} not found on disk — remove it`,
        ).toBe(true);
      }
    });
  });
});

// Re-exports for cross-test inspection (e.g. follow-up tests that want to
// build their own allowlists against the same constants).
export {
  KIND_SCOPE_POLICY,
  VENDORED_SKILL_SCOPE_ALLOWLIST,
  VENDORED_PACKAGE_NAME_ALLOWLIST,
  FORBIDDEN_TOPOLOGY_TOKENS,
  transitionalAllowlist,
  grandfatherList,
  oldNameDenylist,
};

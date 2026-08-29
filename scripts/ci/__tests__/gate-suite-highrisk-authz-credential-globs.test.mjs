// Regression assertion for the 2026-08 high-risk coverage widening (the finding
// the monthly gate-suite re-audit recorded and deliberately did not fix in the
// audit commit). Twenty-six authorization, credential, widget-session and
// org-write-kernel leaves added since the prior audit matched ZERO glob of the
// 44-glob effective set, so a change to any of them was machine-arm mergeable
// with no maintainer Reviewed-by. The near misses are all anchoring accidents:
// 'src/lib/auth*' stops at the first slash so src/lib/authz/… is out; '**/auth/**'
// needs a path segment spelled exactly 'auth', which neither src/lib/authz/… nor
// src/app/api/widget-auth/… has; '**/session*' anchors the BASENAME START so
// widget-session-binding.ts is out; 'src/lib/**/*token*.ts' is src/lib-scoped so
// the app-router token route is out.
//
// This suite pins the flip set BY KIND: every one of the 26 must classify
// high-risk under THIS repo's own gate-suite.json highRiskPaths, every central
// default anchor must still classify, and a named benign set must stay NORMAL —
// the approval-fatigue guard cinatra#1289 established and cinatra#1856 /
// cinatra#2493 carried forward. What this can and cannot catch is worth being
// exact about: a hard-coded path list reds when one of the pinned paths is
// RENAMED out from under its glob, or when a later edit broadens a rule and
// drags a named benign leaf in — it cannot discover a NEW security leaf nobody
// added here, which is why the globs are written by kind rather than as a file
// list. It is a sibling of gate-suite-highrisk-token-globs.test.mjs,
// gate-suite-highrisk-cli-bearer-globs.test.mjs and
// gate-suite-highrisk-execplane-globs.test.mjs (same pattern, same include), and
// runs inside the root Vitest suite (gate of record) via the scripts/ci/__tests__
// include.
//
// The classification uses a FAITHFUL COPY of the gate's own glob→regex
// translation. The production classifier lives cross-repo and is not importable
// here, so globToRegExp below is copied verbatim from
//   cinatra-ai/ci scripts/truthful-attribution-gate.mjs @fdc26811b97f435bbf8a754247631db39267a197
// (the exact pin carried by requiredContexts[].pinned for the
// truthful-attribution-gate context in gate-suite.json). If that pin advances
// and the matcher semantics change, update this copy in the same audit that
// bumps the pin.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const GATE_SUITE = path.join(REPO_ROOT, ".github", "gate-suite.json");

// --- verbatim copy of the production matcher (see header for the source pin) ---
function globToRegExp(glob) {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") {
          re += "(?:.*/)?";
          i++;
        } else {
          re += ".*";
        }
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
      i++;
      continue;
    }
    re += c;
    i++;
  }
  return new RegExp("^" + re + "$");
}

function loadSuite() {
  return JSON.parse(fs.readFileSync(GATE_SUITE, "utf8"));
}

function loadHighRiskPaths() {
  const globs = loadSuite().highRiskPaths;
  if (!Array.isArray(globs)) {
    throw new Error("gate-suite.json highRiskPaths is not an array");
  }
  return globs.map(String);
}

function classify(file, globs) {
  return globs.some((g) => globToRegExp(g).test(file));
}

// The twelve globs this widening adds, grouped by the KIND each states. Every
// entry is a rule about a class of surface, never a file list — a new leaf that
// joins one of these kinds is covered the day it lands.
const WIDENED_GLOBS = [
  // Authorization DIRECTORIES the central 'auth' anchors miss by one letter.
  "**/authz/**",
  "**/widget-auth/**",
  // The org-write authorization kernel: capability table, guard, leases, locks,
  // permits, tickets — the one gate every org-scoped write flows through.
  "packages/org-write-kernel/src/**",
  // The A2A publication/dispatch boundary: which principals are A2A-addressable
  // and what an external peer may invoke.
  "packages/agents/src/a2a-*.ts",
  // Organization tenancy state and its write-admission guards.
  "src/lib/organization-*.ts",
  // Name-derived security leaves under the app's server library.
  "src/lib/**/*session*.ts",
  "src/lib/**/*grant*.ts",
  "src/lib/**/*authorization*.ts",
  "src/lib/**/*capability*.ts",
  // Name-derived security leaves anywhere in the monorepo.
  "**/*credential*.ts",
  "**/*verifier*.ts",
  "**/*token*.ts",
];

// The 26 leaves the re-audit measured as matching ZERO glob of the prior
// 44-glob effective set. Each must classify high-risk now.
const PREVIOUSLY_UNCOVERED = [
  "packages/agents/src/a2a-publication-guard.ts",
  "packages/agents/src/wayflow-run-token-carrier.ts",
  "packages/chat/src/conversation-credential.ts",
  "packages/chat/src/mention-tokenizer.ts",
  "packages/org-write-kernel/src/capabilities.ts",
  "packages/org-write-kernel/src/guard.ts",
  "src/app/api/widget-auth/frame/token/route.ts",
  "src/components/widget-auth/widget-auth-grant.tsx",
  "src/lib/authz/audit-events-schema.ts",
  "src/lib/authz/organization-manage-gate.ts",
  "src/lib/authz/owner-containment-resolver.ts",
  "src/lib/authz/project-read-gate.ts",
  "src/lib/connector-instance-trusted-read-verifier.ts",
  "src/lib/embed/frame-widget-session.client.ts",
  "src/lib/execution/surface-execution-session.ts",
  "src/lib/lifecycle/capture-capability-serving.ts",
  "src/lib/lifecycle/capture-capability.ts",
  "src/lib/lifecycle/review-island-credential.ts",
  "src/lib/lifecycle/review-island-grant-store.ts",
  "src/lib/llm-credential-fingerprint.ts",
  "src/lib/objects/collection-add-authorization.ts",
  "src/lib/organization-archive-guard.ts",
  "src/lib/review-island-grant-schema.ts",
  "src/lib/widget-conversation-grants.ts",
  "src/lib/widget-mcp-actor-authorization.ts",
  "src/lib/widget-session-binding.ts",
];

// The full central high-risk default set (cinatra-ai/ci
// config/high-risk-defaults.json @fdc26811b97f435bbf8a754247631db39267a197).
// A repo suite may EXTEND the defaults but never remove one — the gate fails
// closed on a non-superset set. This is the local, fast-feedback mirror of that
// rule: it reds the moment an edit to highRiskPaths drops a default, instead of
// the whole repository going fail-closed high-risk in CI.
const CENTRAL_DEFAULT_GLOBS = [
  "**/auth/**",
  "**/permissions/**",
  "**/session*",
  "**/session/**",
  "src/lib/auth*",
  "src/lib/auth/**",
  "**/webhooks/**/verify*",
  "**/*signature*verif*",
  "**/secrets/**",
  "**/migrations/**",
  "**/schema.prisma",
  "**/schema.sql",
  "**/*.migration.*",
  ".github/**",
  "**/CODEOWNERS",
  "**/release*.sh",
  "**/publish*.sh",
  "scripts/release/**",
  "scripts/publish/**",
  "**/gate-suite.json",
  "config/high-risk-defaults.json",
  ".github/workflows/truthful-attribution-gate.yml",
  "packages/sdk-extensions/**",
  "**/extension-loader/**",
  "**/trust-gate/**",
  "**/signature-gate/**",
  "**/capability-registry/**",
  "**/transport-registry/**",
  "docs-site/astro.config.mjs",
  "docs-site/src/content.config.ts",
  "docs-site/integrations-registry.json",
  "**/integrations-registry.json",
  "scripts/sync-docs.mjs",
  "scripts/docs-contract-gate.mjs",
  "scripts/lib/docs-contract-rules.mjs",
];

// Representative paths, one per central default family, asserting the defaults
// still CLASSIFY and not merely that the strings are present. Several are
// deliberately synthetic — they stand in for "the first file that lands there",
// the same device gate-suite-highrisk-execplane-globs.test.mjs uses — so this
// list is never bound by the rename guard below.
const CENTRAL_DEFAULT_ANCHORS = [
  ["**/auth/**", "src/lib/auth/policy.ts"],
  ["**/permissions/**", "packages/agents/src/permissions/matrix.ts"],
  ["**/session*", "packages/llm/src/execution-plane/session.ts"],
  ["src/lib/auth*", "src/lib/auth-session.ts"],
  ["**/webhooks/**/verify*", "packages/webhooks/src/webhooks/verify-hmac.ts"],
  ["**/*signature*verif*", "packages/extensions/src/signature-verify.ts"],
  ["**/secrets/**", "scripts/secrets/rotate.mjs"],
  ["**/migrations/**", "migrations/0001_init.sql"],
  ["**/schema.prisma", "prisma/schema.prisma"],
  ["**/schema.sql", "packages/store/schema.sql"],
  ["**/*.migration.*", "packages/extensions/src/0001.migration.ts"],
  [".github/**", ".github/workflows/truthful-attribution-gate.yml"],
  ["**/CODEOWNERS", ".github/CODEOWNERS"],
  ["**/release*.sh", "scripts/release.sh"],
  ["**/publish*.sh", "scripts/publish-extensions.sh"],
  ["scripts/release/**", "scripts/release/cut-tag.mjs"],
  ["scripts/publish/**", "scripts/publish/npm.mjs"],
  ["**/gate-suite.json", ".github/gate-suite.json"],
  ["packages/sdk-extensions/**", "packages/sdk-extensions/src/action-guard.ts"],
  ["**/extension-loader/**", "packages/extensions/src/extension-loader/load.ts"],
  ["**/trust-gate/**", "packages/extensions/src/trust-gate/verify.ts"],
  ["**/signature-gate/**", "packages/extensions/src/signature-gate/check.ts"],
  ["**/capability-registry/**", "packages/extensions/src/capability-registry/index.ts"],
  ["**/transport-registry/**", "packages/extensions/src/transport-registry/index.ts"],
  ["**/integrations-registry.json", "docs-site/integrations-registry.json"],
  ["scripts/sync-docs.mjs", "scripts/sync-docs.mjs"],
];

// The approval-fatigue guard. Each of these sits one naming or scoping step
// away from a widened glob and MUST stay NORMAL; a red here means a later edit
// broadened a rule past the kind it states.
//
//   packages/agents/src/store.ts        — 'packages/agents/src/a2a-*.ts' is the
//     A2A boundary, not the whole agents package.
//   packages/chat/src/mentions.ts,
//   packages/chat/src/classify-mentions.ts — '**/*token*.ts' reaches the mention
//     TOKENIZER by name; it must not become a mention-wide rule.
//   packages/org-write-kernel/tests/kernel-core.test.ts — the kernel glob is
//     src/**-scoped.
//   packages/llm/src/providers/openai-model-capabilities.ts — a MODEL capability
//     is a feature list, not a grant of authority; the capability rule is
//     deliberately src/lib-scoped so this stays out.
//   packages/metric-usage-api/src/components/token-by-provider-table.tsx — a
//     BILLING token is not a credential; the '.ts' anchor keeps it out.
//   src/lib/__tests__/organization-default-team-slug.test.ts — the organization
//     rule covers the tenancy leaves themselves, not a slug-naming test.
//   src/lib/drizzle-store.ts, src/lib/utils.ts — the #1289 wholesale-src/lib
//     alternative, still rejected.
const KNOWN_NORMAL = [
  "packages/agents/src/store.ts",
  "packages/chat/src/mentions.ts",
  "packages/chat/src/classify-mentions.ts",
  "packages/org-write-kernel/tests/kernel-core.test.ts",
  "packages/llm/src/providers/openai-model-capabilities.ts",
  "packages/metric-usage-api/src/components/token-by-provider-table.tsx",
  "src/lib/__tests__/organization-default-team-slug.test.ts",
  "src/lib/drizzle-store.ts",
  "src/lib/utils.ts",
];

describe("gate-suite highRiskPaths authz/credential/session coverage (2026-08 widening)", () => {
  const globs = loadHighRiskPaths();

  it.each(PREVIOUSLY_UNCOVERED)(
    "classifies the previously-uncovered security surface high-risk: %s",
    (file) => {
      expect(classify(file, globs)).toBe(true);
    },
  );

  it.each(KNOWN_NORMAL)(
    "does NOT over-match the benign neighbour: %s",
    (file) => {
      expect(classify(file, globs)).toBe(false);
    },
  );

  it.each(CENTRAL_DEFAULT_ANCHORS)(
    "still classifies the central default anchor %s",
    (_glob, file) => {
      expect(classify(file, globs)).toBe(true);
    },
  );

  it.each(CENTRAL_DEFAULT_GLOBS)(
    "keeps the central default glob present (superset rule): %s",
    (glob) => {
      expect(globs).toContain(glob);
    },
  );

  // Classification alone is a CONFIG guard, not a RENAME guard: every path above
  // is a hard-coded string, so renaming widget-session-binding.ts out from under
  // 'src/lib/**/*session*.ts' would leave every assertion green while the real
  // surface silently left coverage. Binding each pinned path to a file that must
  // EXIST turns a rename into a red check — the same discipline
  // gate-suite-highrisk-cli-bearer-globs.test.mjs established.
  it.each([...PREVIOUSLY_UNCOVERED, ...KNOWN_NORMAL])(
    "still binds a path that exists in the tree (rename guard): %s",
    (file) => {
      expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true);
    },
  );

  it("keeps every widened glob present in highRiskPaths", () => {
    for (const g of WIDENED_GLOBS) {
      expect(globs).toContain(g);
    }
  });

  it("keeps the three prior glob-closure sets present (no silent narrowing)", () => {
    for (const g of [
      "src/lib/**/*token*.ts",
      "src/app/api/assistants/chat/**",
      "src/app/api/assistants/runs/**/stream/**",
      "**/verified-bearer*",
      "**/cli-api/route-guard*",
      "packages/execution-plane/src/service/**",
      "packages/execution-plane/src/authz/**",
    ]) {
      expect(globs).toContain(g);
    }
  });

  // Pins the CalVer the widened set shipped under. This is the half of the
  // version-bump rule a local assertion can carry: a later `version` bump reds
  // here and sends the editor back to this flip set to re-confirm it still
  // holds. The converse — a highRiskPaths edit that forgets the bump — is the
  // ENGINE's rule (checkSuiteVersionBump), not this assertion's, and stays the
  // gate's job.
  it("carries the CalVer the widened glob set shipped under", () => {
    expect(loadSuite().version).toBe("2026.08.5");
  });
});

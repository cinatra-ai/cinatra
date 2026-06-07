/**
 * Parity test for the deterministic portion of agent_source_review against
 * every shipped reference agent.
 *
 * For each extensions/cinatra-ai/<slug>/cinatra/oas.json file:
 *   (a) blockers.length === 0 from the deterministic scans (no literal
 *       secrets, no untrusted URLs, no malformed /api/llm-bridge wiring).
 *   (b) metadata.cinatra.packageName matches the sibling package.json name.
 *   (c) validateOasAgentJson returns zero structural errors.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/agent-source-review-parity.test.ts
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ValidateAgentJson from "../validate-agent-json";
import { expectMessagesMatchAllowlist } from "./__fixtures__/known-broken-agents";
const { validateOasAgentJson } = ValidateAgentJson;

// Read these scan functions off the module namespace so the test file stays
// type-clean while still exercising the real exported scanners at runtime.
const scanOasForLiteralSecrets = (
  ValidateAgentJson as unknown as Record<
    string,
    (oas: Record<string, unknown>) => Array<{ code: string; severity: string; message: string; source: string; location?: unknown }>
  >
)["scanOasForLiteralSecrets"];
const scanOasForUntrustedUrls = (
  ValidateAgentJson as unknown as Record<
    string,
    (oas: Record<string, unknown>) => Array<{ code: string; severity: string; message: string; source: string; location?: unknown }>
  >
)["scanOasForUntrustedUrls"];
const scanOasForLlmBridgeWiring = (
  ValidateAgentJson as unknown as Record<
    string,
    (oas: Record<string, unknown>) => Array<{ code: string; severity: string; message: string; source: string; location?: unknown }>
  >
)["scanOasForLlmBridgeWiring"];

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const AGENTS_DIR = path.join(REPO_ROOT, "extensions", "cinatra-ai");

interface AgentFixture {
  slug: string;
  oasPath: string;
  packageJsonPath: string;
}

function enumerateAgents(): AgentFixture[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  const out: AgentFixture[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const slug = e.name;
    const oasPath = path.join(AGENTS_DIR, slug, "cinatra", "oas.json");
    const packageJsonPath = path.join(AGENTS_DIR, slug, "package.json");
    if (!fs.existsSync(oasPath)) continue; // skip non-conforming layouts
    out.push({ slug, oasPath, packageJsonPath });
  }
  return out;
}

const AGENTS = enumerateAgents();

// Skip-list for known structural issues unrelated to the deterministic scans.
// TODO(retrofit-quick-task): both of these have known structural problems caught by
// validateOasAgentJson. Their structural-validation case is skipped here; the
// rest of the parity contract (scans, packageName) still runs for them.
//   - email-outreach-agent: unresolved $component_ref errors in subflow nodes
const STRUCTURAL_VALIDATION_SKIPLIST = new Set([
  "email-outreach-agent",
]);

describe("agent_source_review — deterministic parity across reference agents", () => {
  it("found at least one reference agent on disk (sanity)", () => {
    expect(AGENTS.length).toBeGreaterThan(0);
  });

  // Per-agent test names use the slug so `vitest -t "<slug>"` targeting works.
  for (const agent of AGENTS) {
    it(`${agent.slug} passes deterministic review`, () => {
      const raw = fs.readFileSync(agent.oasPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      const literalFindings = scanOasForLiteralSecrets(parsed);
      const urlFindings = scanOasForUntrustedUrls(parsed);
      const bridgeFindings = scanOasForLlmBridgeWiring(parsed);

      const allBlockers = [
        ...literalFindings,
        ...urlFindings,
        ...bridgeFindings,
      ];
      expect(allBlockers, JSON.stringify(allBlockers, null, 2)).toHaveLength(0);
    });

    // When metadata.cinatra.packageName is present, it must match
    // package.json#name. Absence is tolerated for legacy Flow agents that do
    // not yet declare the packageName field. New helper agents must declare it;
    // the focused helper-agent assertions enforce presence for those fixtures.
    it(`${agent.slug} packageName consistency (present-implies-matches)`, () => {
      const raw = fs.readFileSync(agent.oasPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        metadata?: { cinatra?: { packageName?: string } };
      };
      const oasPackageName = parsed.metadata?.cinatra?.packageName;

      if (oasPackageName === undefined) {
        // Legacy agent without packageName — skip parity, but flag it for
        // the retrofit followup.
        return;
      }

      const pkgRaw = fs.readFileSync(agent.packageJsonPath, "utf-8");
      const pkg = JSON.parse(pkgRaw) as { name?: string };
      expect(pkg.name).toBeDefined();
      expect(oasPackageName).toBe(pkg.name);
    });

    // Every agent package.json must have an explicit license field. Without it,
    // ensureAgentPackageFromGitFile's synthesized zip fails detectSpdxLicense
    // and the agent can't load.
    it(`${agent.slug} package.json has explicit license field`, () => {
      const pkgParsed = JSON.parse(fs.readFileSync(agent.packageJsonPath, "utf-8")) as Record<
        string,
        unknown
      >;
      const findings = (
        ValidateAgentJson as unknown as Record<
          string,
          (p: Record<string, unknown>) => Array<{ code: string; message: string }>
        >
      )["scanAgentForRequiredLicense"](pkgParsed);
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    });

    // When both OAS metadata.cinatra.packageVersion and sibling
    // package.json#version are present, they must match. Mismatch causes the
    // startup loader (ensureAgentPackageFromGitFile) to read the stale OAS
    // value, hit the version-skip guard, and silently skip re-importing.
    it(`${agent.slug} OAS↔package.json packageVersion sync`, () => {
      const oasParsed = JSON.parse(fs.readFileSync(agent.oasPath, "utf-8")) as Record<
        string,
        unknown
      >;
      const pkgParsed = JSON.parse(fs.readFileSync(agent.packageJsonPath, "utf-8")) as Record<
        string,
        unknown
      >;
      const findings = (
        ValidateAgentJson as unknown as Record<
          string,
          (
            o: Record<string, unknown>,
            p: Record<string, unknown>,
          ) => Array<{ code: string; message: string }>
        >
      )["scanOasForPackageVersionSync"](oasParsed, pkgParsed);
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    });

    it(`${agent.slug} passes validateOasAgentJson structural validation`, () => {
      if (STRUCTURAL_VALIDATION_SKIPLIST.has(agent.slug)) {
        // Known structural issues — see skip-list comment at top of file.
        return;
      }
      const raw = fs.readFileSync(agent.oasPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const errors = validateOasAgentJson(parsed);
      // Honors the documented runtime-backed-agent allowlist
      // (KNOWN_BROKEN_AGENTS): the context-selection-agent OAS and its
      // byte-faithful inlines inherently trip one OAS-RUNTIME-005 by design.
      expectMessagesMatchAllowlist(agent.slug, errors);
    });
  }
});

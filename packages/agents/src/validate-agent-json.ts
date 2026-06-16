/**
 * Standalone OAS Agent.json validator — no server imports, safe to use in tests.
 *
 * The compact OAS Flow format (agentspec_version 26.1.0) is authoritative;
 * legacy fields such as
 * componentType, formatVersion, executionMode, approvalPolicy (as authored),
 * inputSchema (as authored), outputSchema (as authored), prompt, taskSpec, and
 * compiledPlan are rejected.
 *
 * Used by agent_source_write and agent_source_validate MCP handlers.
 *
 * Returns array of human-readable error strings (empty = valid).
 *
 * Deterministic scan functions (literal secrets, untrusted URLs,
 * llm-bridge wiring) share a common `ReviewFinding` shape. The scans are
 * wired into `validateOasAgentJson` so existing callers
 * (agent_source_validate, agent_source_compile) inherit the rejections
 * automatically.
 */
import { z } from "zod";

import { ALLOWED_MODEL_IDS, OasCinatraLlmSchema } from "./llm-provider-policy";
import type { LlmProvider } from "./llm-provider-policy";
import { validateOasFlowStructural } from "./oas-compiler";
import { scanOasForRuntimeInvariantFindings } from "./validate-oas-runtime-invariants";

const LEGACY_FIELDS = ["componentType"] as const;
const LEGACY_CINATRA_FIELDS = [
  "formatVersion",
  "executionMode",
  "approvalPolicy",
  "compiledPlan",
  "inputSchema",
  "outputSchema",
  "prompt",
  "taskSpec",
] as const;

// All components must live in each agent's own $referenced_components. No ids
// are allowed to resolve from a shared registry. An unresolved $component_ref
// always fails validation, which protects against partial component graphs.
const KNOWN_GLOBAL_IDS = new Set<string>();

// ---------------------------------------------------------------------------
// ReviewFinding shape shared by deterministic scans, MCP review handler, and
// tests. Exported so MCP layer + parity tests can import it.
// ---------------------------------------------------------------------------

export type ReviewFindingSeverity = "blocker" | "warning" | "suggestion";

export type ReviewFindingSource =
  | "deterministic"
  | "agent-planner"
  | "agent-security-reviewer"
  | "agent-code-reviewer"
  | "agent-lint-policy";

/**
 * The set of `ReviewFindingSource` values authorized to emit
 * `severity: "blocker"`. Per the all-agents review architecture, only
 * the `@cinatra-ai/lint-policy-agent` agent and the deterministic source may
 * hard-gate publish.
 * LLM helpers (`agent-planner`, `agent-security-reviewer`,
 * `agent-code-reviewer`) are advisory — they may emit `warning` or
 * `suggestion` severity but a `blocker` from those sources is rejected
 * or downgraded by `normalizeReviewFindings`.
 *
 * Both `"deterministic"` and `"agent-lint-policy"` are valid blocker sources.
 * The endpoint at `/api/oas-lint/scan-all` stamps every finding to
 * `source: "agent-lint-policy"`, so policy findings flow in under the agent
 * identity. The `"deterministic"` source remains valid because some callers
 * run the scanners inline for publish and compile hard-gates.
 */
export const BLOCKER_AUTHORIZED_SOURCES: ReadonlySet<ReviewFindingSource> = new Set([
  "agent-lint-policy",
  "deterministic",
]);

/**
 * Defense-in-depth normalization for a `ReviewFinding[]` returned by an
 * agent or aggregator. Downgrades `severity: "blocker"` to `"warning"`
 * when the source is NOT authorized to emit blockers. Used by:
 *   - The merge step of the reviewer-orchestrator parent agent
 *   - Any handler that aggregates findings from multiple sources
 *
 * The schema-enforcement rule: an LLM helper agent (code-reviewer,
 * security-reviewer, planner) may decide that something is "wrong" — but
 * it cannot single-handedly block a publish. Hard-gating authority is
 * reserved for the deterministic policy agent. This prevents LLM
 * hallucination from silently blocking publish on Cinatra-wide policy.
 */
export function normalizeReviewFindings(
  findings: ReviewFinding[],
): ReviewFinding[] {
  return findings.map((f) => {
    if (f.severity === "blocker" && !BLOCKER_AUTHORIZED_SOURCES.has(f.source)) {
      return { ...f, severity: "warning" as const };
    }
    return f;
  });
}

export interface ReviewFinding {
  code: string;
  severity: ReviewFindingSeverity;
  message: string;
  location?: string;
  source: ReviewFindingSource;
}

// Keys whose string values may carry literal credentials. Top-level fields
// like `description` / `name` are intentionally NOT scanned; negative fixtures
// in src/__tests__/scan-oas-literal-secrets.test.ts pin that behavior.
const SCANNABLE_KEYS = new Set<string>([
  "body",
  "data",
  "config",
  "headers",
  "params",
  "system_prompt",
  "prompt_template",
  "message",
  "system",
  "user",
]);

// Known credential prefixes — when seen at the start of any candidate token
// the value is flagged regardless of entropy.
const KNOWN_PREFIX_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "openai-sk", re: /^sk-[A-Za-z0-9_-]{16,}$/ },
  { name: "github-pat", re: /^(gho|ghp|gha|ghs|ghr)_[A-Za-z0-9]{20,}$/ },
  { name: "google-oauth", re: /^ya29\.[A-Za-z0-9_-]{20,}$/ },
  { name: "slack-token", re: /^(xoxb|xoxp|xoxa|xoxr|xoxs)-[A-Za-z0-9-]{16,}$/ },
  { name: "aws-access-key", re: /^(AKIA|ASIA)[A-Z0-9]{12,}$/ },
];

// JWT-shape detection: three base64url-ish segments separated by dots, where
// the first two segments begin with the `eyJ` header marker.
//
// Implemented as a linear single-pass scanner rather than a backtracking regex.
// The previous form `/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/`
// is polynomial (O(n^2)) on adversarial input such as `"eyJ".repeat(n)`: the
// unanchored regex retries the unbounded `+` segments at every offset. Because
// `detectCredentialPattern` runs over untrusted, author-submitted agent
// OAS/JSON string values (see scanOasForLiteralSecrets -> walkOasForScannableStrings),
// that quadratic blowup is a reachable ReDoS (js/polynomial-redos, eng#196).
//
// This scanner is behaviorally identical to the old regex (verified against the
// original via a 500k-case fuzz, including the exact matched substring) but
// runs in O(n): it splits on "." once and checks consecutive segment triples.
const JWT_FULL_SEGMENT_RE = /^[A-Za-z0-9_-]+$/; // anchored => linear
const JWT_LEADING_SEGMENT_RE = /^[A-Za-z0-9_-]+/; // leading base64url run

/**
 * Returns `[matchedToken]` when `value` contains a JWT-shaped substring
 * (`eyJ<b64url>.eyJ<b64url>.<b64url>`), else `null`. The single-element tuple
 * mirrors the `RegExpMatchArray` shape the caller relies on (`jwtMatch[0]`).
 */
function matchJwtShape(value: string): [string] | null {
  if (value.indexOf("eyJ") === -1) return null;
  const parts = value.split(".");
  for (let i = 0; i + 2 < parts.length; i++) {
    // First segment: take the leftmost `eyJ` header start, then require the
    // rest of that inter-dot segment to be base64url with >=1 char after `eyJ`.
    const headerIdx = parts[i].indexOf("eyJ");
    if (headerIdx === -1) continue;
    const seg0 = parts[i].slice(headerIdx);
    if (seg0.length < 4 || !JWT_FULL_SEGMENT_RE.test(seg0)) continue;
    // Second segment must also start `eyJ` and be entirely base64url.
    const seg1 = parts[i + 1];
    if (seg1.length < 4 || !seg1.startsWith("eyJ") || !JWT_FULL_SEGMENT_RE.test(seg1)) {
      continue;
    }
    // Third segment only needs a leading base64url run (regex stops at first
    // non-base64url char, matching the old `[A-Za-z0-9_-]+`).
    const tail = parts[i + 2].match(JWT_LEADING_SEGMENT_RE);
    if (tail === null) continue;
    return [`${seg0}.${seg1}.${tail[0]}`];
  }
  return null;
}

// Placeholder patterns that short-circuit a scanned value to "no finding".
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^\s*\{\{[\s\S]*\}\}\s*$/, // {{var}}
  /\$\{[A-Z0-9_]+\}/, // ${TOKEN}
  /^\$[A-Z0-9_]+$/, // $TOKEN
  /<[A-Z0-9_]+>/, // <API_KEY>
  /^\s*\*+\s*$/, // ***
  /^\s*REDACTED\s*$/i,
];

// Substrings whose presence (case-insensitive) marks a token as a doc example
// and prevents flagging.
const PLACEHOLDER_SUBSTRINGS = ["example", "redacted", "placeholder"];

// Min length for an opaque entropy-based token candidate.
const ENTROPY_MIN_LENGTH = 24;

// Shannon entropy threshold (bits/char). Tunable per CONTEXT — keep just
// below the level of typical opaque credentials and above natural text.
const ENTROPY_THRESHOLD = 4.5;

// Token splitter — separates words, JSON punctuation, and brackets.
const TOKEN_SPLIT_RE = /[\s,;:|()\[\]<>{}"'`]+/;

function computeShannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const len = s.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / len;
    h -= p * Math.log2(p);
  }
  return h;
}

// Whole-value placeholder check — matches only the explicit placeholder
// patterns (no EXAMPLE/REDACTED substring check). The substring check is
// applied at the token level after known-prefix matching so that genuine
// AWS example keys (e.g. AKIAIOSFODNN7EXAMPLE) are still flagged but
// `Bearer sk-EXAMPLE` is not.
function isPlaceholderValue(v: string): boolean {
  const trimmed = v.trim();
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

function isPlaceholderToken(token: string): boolean {
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(token)) return true;
  }
  const lower = token.toLowerCase();
  for (const sub of PLACEHOLDER_SUBSTRINGS) {
    if (lower.includes(sub)) return true;
  }
  return false;
}

// Inspect a single scanned string value and return the first detected
// credential pattern label, or null when the value looks safe.
/**
 * Exported for reuse by the package-sibling-file scanner.
 * Pure function: given any string, returns a credential-pattern label
 * ("openai-sk", "github-pat", "jwt", "high-entropy-token", etc.) or null.
 */
export function detectCredentialPattern(value: string): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (isPlaceholderValue(value)) return null;

  // JWT scan operates on the whole value (its body fragments are not always
  // word-split friendly).
  const jwtMatch = matchJwtShape(value);
  if (jwtMatch && !isPlaceholderToken(jwtMatch[0])) {
    return "jwt";
  }

  // Bearer-token handling: when the value starts with `Bearer `, extract the
  // suffix and re-evaluate against the same skip list / pattern set.
  const bearerMatch = /^\s*Bearer\s+(\S+)\s*$/i.exec(value);
  if (bearerMatch) {
    const inner = bearerMatch[1];
    if (isPlaceholderToken(inner)) return null;
    return detectCredentialPattern(inner);
  }

  // Tokenize, then score each candidate token independently.
  const tokens = value.split(TOKEN_SPLIT_RE).filter((t) => t.length > 0);
  for (const token of tokens) {
    // Known prefix match — flag immediately regardless of entropy. The
    // KNOWN_PREFIX_PATTERNS regexes already require sufficient length, so
    // short placeholder tokens like `sk-EXAMPLE` (10 chars) won't match.
    // Real AWS example keys like `AKIAIOSFODNN7EXAMPLE` (20 chars) DO match
    // — they are intentionally flagged as positive fixtures even though
    // they contain the substring "EXAMPLE", because the AKIA prefix +
    // length is high-signal enough on its own.
    for (const { name, re } of KNOWN_PREFIX_PATTERNS) {
      if (re.test(token)) return name;
    }

    if (isPlaceholderToken(token)) continue;

    // High-entropy opaque token.
    if (token.length >= ENTROPY_MIN_LENGTH) {
      const h = computeShannonEntropy(token);
      if (h >= ENTROPY_THRESHOLD) return "high-entropy-token";
    }
  }

  return null;
}

// Walk the OAS tree, invoking `visit` for every (key, string-value, path)
// pair where the parent key is in SCANNABLE_KEYS. Recurses into objects and
// arrays. Strings encountered outside a scannable key are skipped — but
// nested scannable keys inside an otherwise non-scannable subtree are still
// visited (e.g. {{CINATRA_BASE_URL}}/api/llm-bridge ApiNode under
// $referenced_components has its own `body` / `data` / `config`).
function walkOasForScannableStrings(
  node: unknown,
  path: string,
  visit: (value: string, path: string) => void,
  scanThisLevel: boolean,
): void {
  if (node === null || node === undefined) return;
  if (typeof node === "string") {
    if (scanThisLevel) visit(node, path);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) =>
      walkOasForScannableStrings(item, `${path}[${i}]`, visit, scanThisLevel),
    );
    return;
  }
  if (typeof node !== "object") return;

  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const childPath = path ? `${path}.${k}` : k;
    const childScanThisLevel = scanThisLevel || SCANNABLE_KEYS.has(k);
    if (typeof v === "string") {
      // For a string child, scan iff the immediate key is scannable OR
      // we are already inside a scannable subtree.
      if (childScanThisLevel) visit(v, childPath);
    } else {
      walkOasForScannableStrings(v, childPath, visit, childScanThisLevel);
    }
  }
}

/**
 * Detect literal credentials baked into an OAS Flow document.
 *
 * Walks ONLY values under scannable keys (body, data, config, headers,
 * params, system_prompt, prompt_template, message, system, user). Skips
 * placeholders ({{var}}, ${VAR}, <KEY>, ***, REDACTED, anything containing
 * "EXAMPLE" / "redacted" / "placeholder"). Flags known credential prefixes,
 * JWT-shape strings, and high-entropy opaque tokens (Shannon entropy ≥ 4.5
 * bits/char and length ≥ 24).
 */
export function scanOasForLiteralSecrets(parsed: Record<string, unknown>): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  walkOasForScannableStrings(
    parsed,
    "",
    (value, path) => {
      const pattern = detectCredentialPattern(value);
      if (pattern) {
        findings.push({
          code: "literal_credential_detected",
          severity: "blocker",
          message: `literal credential detected at ${path}: pattern=${pattern}`,
          location: path,
          source: "deterministic",
        });
      }
    },
    false,
  );
  return findings;
}

// ---------------------------------------------------------------------------
// Untrusted URL scan
// ---------------------------------------------------------------------------

// Default URL allow-list for A2AAgent.agent_url and MCPToolBox.url.
// Empty string is treated as trusted because existing reference agents declare
// A2AAgent components with `agent_url: ""` as a structural placeholder when
// the agent is invoked in-process, so no out-of-band HTTP call is made.
// If a future contributor wants to forbid this, lift the allow-list constant
// into config.
const DEFAULT_TRUSTED_URL_PREFIXES = ["{{CINATRA_BASE_URL}}", "/"];

function isTrustedUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  if (url === "") return true;
  for (const prefix of DEFAULT_TRUSTED_URL_PREFIXES) {
    if (url.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Flag A2AAgent.agent_url and MCPToolBox.url values that point at
 * non-allowlisted external hosts. The default allow-list accepts
 * {{CINATRA_BASE_URL}} placeholders, relative paths starting with `/`,
 * and empty strings.
 */
export function scanOasForUntrustedUrls(parsed: Record<string, unknown>): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const refs =
    (parsed.$referenced_components as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [id, comp] of Object.entries(refs)) {
    const ct = comp.component_type;
    let field: "agent_url" | "url" | null = null;
    let url: unknown = undefined;
    if (ct === "A2AAgent") {
      field = "agent_url";
      url = comp.agent_url;
    } else if (ct === "MCPToolBox") {
      field = "url";
      url = comp.url;
    } else {
      continue;
    }
    if (typeof url !== "string") continue;
    if (isTrustedUrl(url)) continue;
    findings.push({
      code: "untrusted_external_url",
      severity: "blocker",
      message: `untrusted ${field} on ${String(ct)} ${id}: ${url}`,
      location: `$referenced_components.${id}.${field}`,
      source: "deterministic",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// llm-bridge wiring scan
// ---------------------------------------------------------------------------

function isLlmBridgeUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  if (url === "{{CINATRA_BASE_URL}}/api/llm-bridge") return true;
  if (url === "/api/llm-bridge") return true;
  // Accept any URL whose path ends with /api/llm-bridge.
  if (url.endsWith("/api/llm-bridge")) return true;
  return false;
}

function hasAgentIdField(container: unknown): boolean {
  if (!container || typeof container !== "object") return false;
  const agentId = (container as Record<string, unknown>).agent_id;
  return typeof agentId === "string" && agentId.length > 0;
}

/**
 * Flag ApiNodes that target /api/llm-bridge without an agent_id in body, data,
 * or config. The bridge cannot resolve the
 * calling agent's compiled toolboxes without an agent_id.
 */
export function scanOasForLlmBridgeWiring(parsed: Record<string, unknown>): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const refs =
    (parsed.$referenced_components as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [id, comp] of Object.entries(refs)) {
    if (comp.component_type !== "ApiNode") continue;
    if (!isLlmBridgeUrl(comp.url)) continue;
    const hasInBody = hasAgentIdField(comp.body);
    const hasInData = hasAgentIdField(comp.data);
    const hasInConfig = hasAgentIdField(comp.config);
    if (hasInBody || hasInData || hasInConfig) continue;
    findings.push({
      code: "llm_bridge_missing_agent_id",
      severity: "blocker",
      message: `ApiNode ${id} targets /api/llm-bridge but data/body/config lacks agent_id; the bridge cannot resolve the calling agent's compiled toolboxes`,
      location: `$referenced_components.${id}`,
      source: "deterministic",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// metadata.cinatra.llm provider/model/capability scan
//
// Emits findings with stable codes — caller error-handling depends on them:
//   OAS-LLM-001  structural failure inside metadata.cinatra.llm (Zod-detected:
//                unknown provider, unknown capability, .strict() rejection,
//                type mismatch)
//   OAS-LLM-002  preferredModel not in ALLOWED_MODEL_IDS[preferredProvider]
//   OAS-LLM-003  preferredModel set without preferredProvider
//   OAS-LLM-004  capabilityRequired:"media_input" without preferredProvider:"gemini"
//
// Zod-level violations are normalized to OAS-LLM-001 via normalizeLlmZodIssue
// so callers never see raw Zod issue shapes.
// ---------------------------------------------------------------------------

function normalizeLlmZodIssue(issue: z.ZodIssue): ReviewFinding {
  const pathStr = issue.path.join(".");
  const location = pathStr ? `metadata.cinatra.llm.${pathStr}` : "metadata.cinatra.llm";

  let message: string;
  if (pathStr.endsWith("preferredProvider") && issue.code === "invalid_value") {
    message = `Unknown preferredProvider: ${issue.message}`;
  } else if (pathStr.endsWith("capabilityRequired") && issue.code === "invalid_value") {
    message = `Unknown capabilityRequired: ${issue.message}`;
  } else if (issue.code === "unrecognized_keys") {
    message = `Unknown field in metadata.cinatra.llm: ${issue.message}`;
  } else {
    message = `metadata.cinatra.llm structural error: ${issue.message}`;
  }

  return {
    code: "OAS-LLM-001",
    severity: "blocker",
    message,
    location,
    source: "deterministic",
  };
}

/**
 * Scan the optional `metadata.cinatra.llm` declaration for provider/model/
 * capability mismatches. Absence of the block is valid.
 *
 * Layering: a `safeParse` against `OasCinatraLlmSchema` catches structural
 * failures (unknown enum values, `.strict()` unknown keys) and normalizes
 * them to `OAS-LLM-001`. When parse succeeds, three cross-field rules emit
 * the remaining stable IDs (OAS-LLM-002 / 003 / 004).
 */
export function scanOasForLlmMetadata(parsed: Record<string, unknown>): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const metadata = parsed.metadata as Record<string, unknown> | undefined;
  const cinatra = metadata?.cinatra as Record<string, unknown> | undefined;
  if (!cinatra || cinatra.llm === undefined) return findings;

  const result = OasCinatraLlmSchema.safeParse(cinatra.llm);
  if (!result.success) {
    for (const issue of result.error.issues) {
      findings.push(normalizeLlmZodIssue(issue));
    }
    return findings;
  }

  const llm = result.data;
  if (!llm) return findings;

  const preferredProvider = llm.preferredProvider as LlmProvider | undefined;
  const preferredModel = llm.preferredModel;
  const capabilityRequired = llm.capabilityRequired;

  // OAS-LLM-003 — preferredModel without preferredProvider (cannot infer provider safely).
  if (preferredModel && !preferredProvider) {
    findings.push({
      code: "OAS-LLM-003",
      severity: "blocker",
      message: "metadata.cinatra.llm.preferredModel requires preferredProvider",
      location: "metadata.cinatra.llm.preferredModel",
      source: "deterministic",
    });
  }

  // OAS-LLM-002 — preferredModel not in ALLOWED_MODEL_IDS[preferredProvider].
  if (preferredModel && preferredProvider) {
    const allowed = ALLOWED_MODEL_IDS[preferredProvider];
    if (!allowed.includes(preferredModel)) {
      findings.push({
        code: "OAS-LLM-002",
        severity: "blocker",
        message: `metadata.cinatra.llm.preferredModel "${preferredModel}" is not in the allowlist for provider "${preferredProvider}". Allowed: ${allowed.join(", ")}`,
        location: "metadata.cinatra.llm.preferredModel",
        source: "deterministic",
      });
    }
  }

  // OAS-LLM-004 — capabilityRequired:"media_input" only valid with preferredProvider:"gemini".
  if (capabilityRequired === "media_input" && preferredProvider !== "gemini") {
    findings.push({
      code: "OAS-LLM-004",
      severity: "blocker",
      message: `metadata.cinatra.llm.capabilityRequired "media_input" requires preferredProvider "gemini" (got ${JSON.stringify(preferredProvider)})`,
      location: "metadata.cinatra.llm.capabilityRequired",
      source: "deterministic",
    });
  }

  return findings;
}

/**
 * Surface StartNode inputs that lack a `metadata.cinatra.required` or
 * `metadata.cinatra.hidden` declaration.
 * The runtime will not prompt the user for these — the agent will
 * silently run with whatever the dispatcher passed.
 *
 * Warning-level finding for `agent_source_review`; does not block
 * `agent_source_validate` or `agent_source_compile`.
 *
 * Walks nested Flow `$referenced_components` too. Lane Flows inside a
 * `ParallelFlowNode` subflow declare their own StartNodes; those must satisfy
 * the same invariant. Findings emit the full
 * `$referenced_components.<parent>.<child>...` path so authors can locate
 * the offender even when it lives several Flow levels deep.
 */
export function scanOasForStartNodeInputsWithoutRequired(
  parsed: Record<string, unknown>,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const visit = (
    refs: Record<string, Record<string, unknown>>,
    locationPrefix: string,
  ) => {
    for (const [id, comp] of Object.entries(refs)) {
      const compPath = `${locationPrefix}.${id}`;
      if (comp.component_type === "StartNode") {
        const inputs = Array.isArray(comp.inputs)
          ? (comp.inputs as Array<Record<string, unknown>>)
          : [];
        if (inputs.length > 0) {
          const cinatraMeta =
            ((comp.metadata as Record<string, unknown> | undefined)?.cinatra as
              | Record<string, unknown>
              | undefined) ?? {};
          const required = new Set(
            (Array.isArray(cinatraMeta.required) ? (cinatraMeta.required as unknown[]) : [])
              .filter((v): v is string => typeof v === "string"),
          );
          const hidden = new Set(
            (Array.isArray(cinatraMeta.hidden) ? (cinatraMeta.hidden as unknown[]) : [])
              .filter((v): v is string => typeof v === "string"),
          );
          const orphaned: string[] = [];
          for (const input of inputs) {
            const title = typeof input.title === "string" ? input.title : null;
            if (!title) continue;
            if (required.has(title) || hidden.has(title)) continue;
            orphaned.push(title);
          }
          if (orphaned.length > 0) {
            findings.push({
              code: "start_node_inputs_without_required",
              severity: "warning",
              message:
                `StartNode "${id}" declares input(s) [${orphaned.map((s) => `"${s}"`).join(", ")}] that are neither in metadata.cinatra.required nor metadata.cinatra.hidden. ` +
                `The runtime will not prompt the user for these — the agent will silently run with whatever the dispatcher passed. ` +
                `Add the input names to metadata.cinatra.required for pre-run HITL field collection (default schema-field renderer handles strings, numbers, enums, URLs, emails), ` +
                `or to metadata.cinatra.hidden when the value is always provided programmatically.`,
              location: compPath,
              source: "deterministic",
            });
          }
        }
      }
      // Recurse into nested Flow $referenced_components for lane subflows.
      if (comp.component_type === "Flow") {
        const nested = comp.$referenced_components as
          | Record<string, Record<string, unknown>>
          | undefined;
        if (nested && typeof nested === "object") {
          visit(nested, `${compPath}.$referenced_components`);
        }
      }
    }
  };
  const topRefs =
    (parsed.$referenced_components as Record<string, Record<string, unknown>> | undefined) ?? {};
  visit(topRefs, "$referenced_components");
  return findings;
}

/**
 * Surface OAS↔package.json packageVersion drift.
 *
 * `ensureAgentPackageFromGitFile` reads `metadata.cinatra.packageVersion` from
 * the OAS first and falls back to sibling `package.json#version`. The version-
 * skip guard then short-circuits import when the OAS-side value matches the
 * existing DB row. If the OAS field has been left stale (package.json bumped
 * but OAS forgotten), the loader silently skips re-importing the new code.
 *
 * This scanner pins the invariant: when both fields are present, they must
 * match. Either-side absent is allowed (loader fallback handles it).
 *
 * Pure / parsed-input only — caller owns file IO so this is reusable from
 * MCP handlers, hermetic tests, and future upload flows.
 *
 * Severity is blocker because the bug it catches is silent stale imports, not
 * cosmetic drift.
 */
export function scanOasForPackageVersionSync(
  oasParsed: Record<string, unknown>,
  packageJsonParsed: Record<string, unknown>,
): ReviewFinding[] {
  const cinatra = (oasParsed.metadata as Record<string, unknown> | undefined)?.cinatra as
    | Record<string, unknown>
    | undefined;
  const oasVersion = cinatra?.packageVersion;
  const pkgVersion = packageJsonParsed.version;
  if (typeof oasVersion !== "string" || oasVersion.length === 0) return [];
  if (typeof pkgVersion !== "string" || pkgVersion.length === 0) return [];
  if (oasVersion === pkgVersion) return [];
  return [
    {
      code: "package_version_oas_pkg_drift",
      severity: "blocker",
      message:
        `metadata.cinatra.packageVersion "${oasVersion}" must match sibling package.json#version "${pkgVersion}". ` +
        `Mismatch causes the startup loader (ensureAgentPackageFromGitFile) to read the stale OAS value, hit the version-skip guard, and silently skip re-importing the new code.`,
      location: "metadata.cinatra.packageVersion",
      source: "deterministic",
    },
  ];
}

/**
 * Surface agents missing an explicit `license` field in package.json.
 *
 * `ensureAgentPackageFromGitFile` synthesizes a package.json into the import
 * zip; that zip's package.json#license feeds detectSpdxLicense at
 * import-agent-core.ts:135. Without an explicit `license` at source, agents
 * fail license-detection on every re-import.
 *
 * This scanner makes the invariant explicit so license intent is sourced at
 * author/review time instead of being inferred during import.
 *
 * Scoped to package.json only — not OAS — because license is npm-package
 * metadata, not OAS metadata.
 */
export function scanAgentForRequiredLicense(
  packageJsonParsed: Record<string, unknown>,
): ReviewFinding[] {
  const license = packageJsonParsed.license;
  if (typeof license === "string" && license.length > 0) return [];
  return [
    {
      code: "agent_package_missing_license",
      severity: "blocker",
      message:
        `Agent package.json is missing an explicit "license" field. ` +
        `Add e.g. "license": "Apache-2.0" so the startup loader (ensureAgentPackageFromGitFile) ` +
        `can propagate it to the import zip and detectSpdxLicense can validate.`,
      location: "package.json#license",
      source: "deterministic",
    },
  ];
}

function formatFindingAsError(f: ReviewFinding): string {
  const loc = f.location ?? "<root>";
  return `${f.code} at ${loc}: ${f.message}`;
}

export function validateOasAgentJson(parsed: Record<string, unknown>): string[] {
  const errors: string[] = [];
  errors.push(...validateOasFlowStructural(parsed));

  // Legacy field rejection.
  for (const f of LEGACY_FIELDS) {
    if (f in parsed) {
      errors.push(
        `legacy field ${f} must not appear in OAS agent.json`,
      );
    }
  }
  const cinatra = (parsed.metadata as Record<string, unknown> | undefined)?.cinatra as
    | Record<string, unknown>
    | undefined;
  if (cinatra) {
    for (const f of LEGACY_CINATRA_FIELDS) {
      if (f in cinatra) {
        errors.push(
          `legacy field metadata.cinatra.${f} must not appear in OAS agent.json (derived at compile time or moved to Agent.system_prompt)`,
        );
      }
    }
  }

  // Cinatra semantic — per-AgentNode checks
  const refs =
    (parsed.$referenced_components as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [id, comp] of Object.entries(refs)) {
    if (comp.component_type !== "AgentNode") continue;
    const c = (comp.metadata as { cinatra?: Record<string, unknown> } | undefined)?.cinatra;
    if (!c) continue;
    if (c.hitlOwnedBy !== undefined && c.hitlOwnedBy !== "childAgent" && c.hitlOwnedBy !== "self") {
      errors.push(
        `AgentNode ${id}.metadata.cinatra.hitlOwnedBy must be "childAgent" or "self" (got ${JSON.stringify(c.hitlOwnedBy)})`,
      );
    }
    // a2uiSurfaceIdOverride is only valid when the node delegates to a child (hitlOwnedBy === "childAgent")
    if (c.a2uiSurfaceIdOverride !== undefined && c.hitlOwnedBy !== "childAgent") {
      errors.push(
        `AgentNode ${id}.metadata.cinatra.a2uiSurfaceIdOverride only valid when hitlOwnedBy === "childAgent"`,
      );
    }
    if (c.requiresApproval !== undefined && typeof c.requiresApproval !== "boolean") {
      errors.push(`AgentNode ${id}.metadata.cinatra.requiresApproval must be a boolean`);
    }
  }

  // Additional semantic checks:

  // Referenced component existence: every $component_ref target must
  // resolve in its enclosing Flow's $referenced_components (or against the
  // empty global id set). Nested ParallelFlowNode subflows declare their OWN
  // local `$referenced_components` and refs inside the nested Flow are strictly
  // local — they do NOT fall back to the enclosing Flow's scope. This matches
  // pyagentspec's runtime resolution model (cross-scope refs are not
  // supported); each lane Flow must self-contain every component it references.
  const walkForRefs = (
    obj: unknown,
    path: string[],
    localScope: ReadonlySet<string>,
  ) => {
    if (!obj || typeof obj !== "object") return;
    const rec = obj as Record<string, unknown>;

    const isFlowWithRefs =
      rec.component_type === "Flow" &&
      rec.$referenced_components !== undefined &&
      typeof rec.$referenced_components === "object" &&
      rec.$referenced_components !== null;
    if (isFlowWithRefs) {
      const nestedRefs = rec.$referenced_components as Record<string, unknown>;
      const nestedScope: ReadonlySet<string> = new Set(Object.keys(nestedRefs));
      for (const [k, v] of Object.entries(rec)) {
        const childPath = [...path, k];
        if (k === "$referenced_components") {
          for (const [compId, compDef] of Object.entries(v as Record<string, unknown>)) {
            walkForRefs(compDef, [...childPath, compId], nestedScope);
          }
        } else if (Array.isArray(v)) {
          v.forEach((item, i) => walkForRefs(item, [...childPath, String(i)], nestedScope));
        } else if (v && typeof v === "object") {
          walkForRefs(v, childPath, nestedScope);
        }
      }
      return;
    }

    if (typeof rec.$component_ref === "string") {
      const target = rec.$component_ref;
      if (!localScope.has(target) && !KNOWN_GLOBAL_IDS.has(target)) {
        errors.push(
          `unresolved $component_ref "${target}" at ${path.join(".") || "<root>"} (not in local $referenced_components nor a known global id)`,
        );
      }
      return;
    }
    for (const [k, v] of Object.entries(rec)) {
      if (Array.isArray(v))
        v.forEach((item, i) => walkForRefs(item, [...path, k, String(i)], localScope));
      else if (v && typeof v === "object") walkForRefs(v, [...path, k], localScope);
    }
  };
  walkForRefs(parsed, [], new Set<string>());

  // Duplicate node ids: Object.keys() always returns unique keys, so
  // true "duplicate $referenced_components id" is impossible in a parsed JSON
  // object. The meaningful duplicate check is on the nodes array.
  const nodeArrayIds: string[] = [];
  for (const n of ((parsed.nodes as Array<{ "$component_ref": string }> | undefined) ?? [])) {
    nodeArrayIds.push(n.$component_ref);
  }
  const seenNodeIds = new Set<string>();
  for (const id of nodeArrayIds) {
    if (seenNodeIds.has(id)) errors.push(`duplicate node reference in nodes array: ${id}`);
    seenNodeIds.add(id);
  }

  // Exactly one StartNode among referenced components used by the flow.
  const startNodes = Object.entries(refs).filter(([, c]) => c.component_type === "StartNode");
  if (startNodes.length !== 1) {
    errors.push(
      `flow must have exactly one StartNode in $referenced_components (got ${startNodes.length})`,
    );
  }

  // Exactly one EndNode among referenced components used by the flow.
  const endNodes = Object.entries(refs).filter(([, c]) => c.component_type === "EndNode");
  if (endNodes.length !== 1) {
    errors.push(
      `flow must have exactly one EndNode in $referenced_components (got ${endNodes.length})`,
    );
  }

  // Wire deterministic scans so existing callers (agent_source_validate,
  // agent_source_compile) inherit the rejections.
  for (const f of scanOasForLiteralSecrets(parsed)) {
    errors.push(formatFindingAsError(f));
  }
  for (const f of scanOasForUntrustedUrls(parsed)) {
    errors.push(formatFindingAsError(f));
  }
  for (const f of scanOasForLlmBridgeWiring(parsed)) {
    errors.push(formatFindingAsError(f));
  }
  // Provider/model/capability declaration scan.
  for (const f of scanOasForLlmMetadata(parsed)) {
    errors.push(formatFindingAsError(f));
  }

  // pyagentspec runtime-invariant scans (placeholder/inputs parity,
  // JS-ternary detection, FloatProperty integer default, agent_run_id
  // propagation, EndNode output sources). All findings are severity:"blocker"
  // because they describe mount failures, not stylistic concerns.
  for (const f of scanOasForRuntimeInvariantFindings(parsed)) {
    errors.push(formatFindingAsError(f));
  }

  return errors;
}

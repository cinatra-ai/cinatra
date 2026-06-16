/**
 * `AuthorDraft` typed-artifact contract for the
 * `@cinatra-ai/author-agent` extension.
 *
 * Creation agents emit typed artifacts consumed by deterministic
 * `agent_source_*`; the assistant must not reinterpret prose as authoring
 * actions.
 *
 * This module owns the wire shape AND the STRICT extractor. The author-agent
 * emits a single `{"draft":{…}}` JSON envelope — anything else (prose, code
 * fences, top-level arrays, sibling envelope keys, malformed children) fires
 * the typed-artifact gate (`AuthorDraftExtractionError`) and the dispatch
 * caller (`runAuthorAgent` in `run-author-agent.ts`) propagates it.
 *
 * Field shape matches the agent-authoring SKILL.md spec at
 * `extensions/cinatra-ai/author-agent/skills/agent-authoring/SKILL.md`.
 *
 * Standing invariants:
 *   - The assistant NEVER reinterprets prose into authoring actions —
 *     `extractAuthorDraftFromText` is the ONLY allowed parse path.
 *   - NO function-tool fallback for Anthropic (this module is provider-agnostic
 *     and reads only the LLM's text body — the no-function-tools guarantee
 *     belongs to the dispatch site `resolve-agent-creation-dispatch.ts`).
 */

import "server-only";

// ---------------------------------------------------------------------------
// Type shape (matches author-agent SKILL.md spec)
// ---------------------------------------------------------------------------

export type AuthorDraftKind = "agent" | "skill" | "connector" | "artifact";

export type AuthorDraftPackage = {
  /** `@cinatra-ai/<slug>-<kind>` — kind-at-end naming convention. */
  name: string;
  /** Semver. */
  version: string;
  /** One-sentence purpose. */
  description: string;
  /** Cinatra package metadata. */
  cinatra: { apiVersion: string; kind: AuthorDraftKind };
  /** Apache-2.0 conventionally. */
  license: string;
};

export type AuthorDraftSkillFile = {
  /** Path relative to the package root, e.g. `skills/my-skill/SKILL.md`. */
  relPath: string;
  /** SKILL.md body contents. */
  contents: string;
};

export type AuthorDraft = {
  package: AuthorDraftPackage;
  /** Full OAS Flow 26.1.0 body — validated downstream by deterministic `agent_source_*`. */
  oas: Record<string, unknown>;
  /** Zero or more SKILL.md drafts (co-located under the extension's `skills/`). */
  skills: AuthorDraftSkillFile[];
};

// ---------------------------------------------------------------------------
// Sentinel error
// ---------------------------------------------------------------------------

export type AuthorDraftExtractionErrorCode =
  | "no_envelope"
  | "trailing_text"
  | "top_level_array"
  | "extra_envelope_fields"
  | "malformed_json"
  | "missing_fields"
  | "invalid_kind"
  | "invalid_name_shape"
  | "invalid_skills_shape";

export class AuthorDraftExtractionError extends Error {
  readonly code: AuthorDraftExtractionErrorCode;
  constructor(code: AuthorDraftExtractionErrorCode, message: string) {
    super(message);
    this.name = "AuthorDraftExtractionError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// STRICT extractor
// ---------------------------------------------------------------------------

// Two-layer package-name validation.
//
// Layer 1: StandardPackageName — the canonical shape every NEW extension
// must follow. Scope is open ended for connectors to support generic vendors;
// other kinds are first-party-scoped by naming-conformance tests.
// `skills` is accepted as a directory-suffix synonym for `cinatra.kind: "skill"`.
//
// Layer 2: VENDORED_PACKAGE_NAME_ALLOWLIST — exact-name allowlist for
// upstream packages that don't follow Cinatra's <slug>-<kind> convention.
// Today: @anthropics/skills. Future entries are added by amending this set.
// Naming-conformance tests enforce that the package's cinatra.kind matches.
const STANDARD_PACKAGE_NAME_REGEX = /^@[a-z0-9-]+\/[a-z0-9-]+-(agent|skill|skills|connector|artifact)$/;
const VENDORED_PACKAGE_NAME_ALLOWLIST: ReadonlySet<string> = new Set(["@anthropics/skills"]);

export function isValidPackageName(name: string): boolean {
  if (STANDARD_PACKAGE_NAME_REGEX.test(name)) return true;
  if (VENDORED_PACKAGE_NAME_ALLOWLIST.has(name)) return true;
  return false;
}

// Export-compatible regex alias for tests that directly import it.
// Prefer isValidPackageName() for new package-name checks.
const PACKAGE_NAME_REGEX = STANDARD_PACKAGE_NAME_REGEX;
const VALID_KINDS: ReadonlySet<AuthorDraftKind> = new Set(["agent", "skill", "connector", "artifact"]);

// `draft.skills[].relPath` MUST be a package-local path under
// `skills/<slug>/SKILL.md`. Reject absolute paths, traversal segments,
// backslashes, and anything outside the allowed shape. The downstream
// deterministic `agent_source_*` primitives consume this path without further
// validation — strict-validate here as the typed-artifact gate's path-traversal
// defense.
const SKILL_REL_PATH_REGEX = /^skills\/[a-z0-9-]+\/SKILL\.md$/;
function isValidSkillRelPath(relPath: string): boolean {
  if (relPath.length === 0) return false;
  if (relPath.startsWith("/")) return false;       // absolute Unix
  if (/^[a-zA-Z]:/.test(relPath)) return false;     // absolute Windows (e.g. C:)
  if (relPath.includes("\\")) return false;         // backslash separator
  if (relPath.includes("..")) return false;         // traversal
  if (relPath.includes("//")) return false;         // empty segment
  return SKILL_REL_PATH_REGEX.test(relPath);
}

/**
 * Returns the body of a SINGLE wrapping code fence (```json\n<body>\n``` or
 * ```\n<body>\n```), or `null` when `trimmed` is not a single fenced block.
 *
 * Linear single-pass reimplementation of the matcher
 * `/^```(?:json)?\s*\n([\s\S]*)\n```\s*$/`, whose greedy `[\s\S]*` paired with
 * the `\n```\s*$` tail is polynomial (O(n^2)) on adversarial input such as
 * "```\n" + "\n".repeat(n). `stripWrappingCodeFence` runs over LLM completion
 * text (not a bounded trusted config surface), so the linear form removes the
 * ReDoS (js/polynomial-redos, eng#196). Verified identical to the old regex's
 * captured body via a 4M-case fuzz.
 */
function matchWrappingCodeFenceBody(trimmed: string): string | null {
  if (!trimmed.startsWith("```")) return null;
  let openerEnd = 3;
  if (trimmed.startsWith("json", openerEnd)) openerEnd += 4;
  // Closing fence: \n```\s*$  — strip the trailing whitespace run, then require
  // a closing ``` preceded by a newline.
  let end = trimmed.length;
  while (end > 0 && /\s/.test(trimmed[end - 1])) end--;
  if (end < 4) return null;
  if (trimmed.slice(end - 3, end) !== "```") return null;
  if (trimmed[end - 4] !== "\n") return null;
  const closeNewline = end - 4; // body-terminating "\n" (owned by the close)
  // Opener: ```(?:json)? then greedy \s* then "\n". The greedy `\s*` consumes
  // the maximal leading-whitespace run; the body therefore starts after the
  // last "\n" in that run that is still before the closing "\n".
  let wsEnd = openerEnd;
  while (wsEnd < trimmed.length && /\s/.test(trimmed[wsEnd])) wsEnd++;
  const limit = Math.min(wsEnd, closeNewline);
  let openerNewline = -1;
  for (let k = limit - 1; k >= openerEnd; k--) {
    if (trimmed[k] === "\n") {
      openerNewline = k;
      break;
    }
  }
  if (openerNewline === -1) return null;
  const bodyStart = openerNewline + 1;
  if (closeNewline < bodyStart) return null;
  return trimmed.slice(bodyStart, closeNewline);
}

/**
 * Strip a SINGLE wrapping code fence from the body. Returns the unwrapped
 * content trimmed. Does NOT strip multiple fences (multiple fences = prose).
 */
function stripWrappingCodeFence(text: string): string {
  const trimmed = text.trim();
  // Match  ```json\n<body>\n```  OR  ```\n<body>\n```  (single wrap).
  const fenceBody = matchWrappingCodeFenceBody(trimmed);
  if (fenceBody !== null) {
    return fenceBody.trim();
  }
  return trimmed;
}

/**
 * STRICT typed-artifact extractor. Accepts ONLY `{"draft":{…}}` JSON envelope
 * (optionally wrapped in a SINGLE code fence). Any deviation throws
 * `AuthorDraftExtractionError`.
 */
export function extractAuthorDraftFromText(text: string): AuthorDraft {
  const body = stripWrappingCodeFence(text);
  if (body.length === 0) {
    throw new AuthorDraftExtractionError("no_envelope", "empty author-agent output");
  }

  // Must begin with `{` and end with `}` (after trim) — no extra prose.
  if (body[0] !== "{" || body[body.length - 1] !== "}") {
    // Could be a top-level array, or text-wrapped content. Distinguish.
    if (body[0] === "[") {
      throw new AuthorDraftExtractionError(
        "top_level_array",
        "author-agent emitted a top-level JSON array; expected the single-object envelope `{\"draft\":{…}}`",
      );
    }
    throw new AuthorDraftExtractionError(
      "trailing_text",
      "author-agent output is not a single top-level JSON object (extra prose or trailing text)",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new AuthorDraftExtractionError(
      "malformed_json",
      `author-agent JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (Array.isArray(parsed)) {
    // Defensive — JSON.parse of `[…]` should have been caught by the `[` check above.
    throw new AuthorDraftExtractionError(
      "top_level_array",
      "author-agent emitted a top-level JSON array; expected the single-object envelope `{\"draft\":{…}}`",
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new AuthorDraftExtractionError(
      "no_envelope",
      "author-agent emitted a non-object top-level JSON value",
    );
  }

  const envelope = parsed as Record<string, unknown>;
  const envelopeKeys = Object.keys(envelope);
  if (envelopeKeys.length !== 1 || envelopeKeys[0] !== "draft") {
    throw new AuthorDraftExtractionError(
      "extra_envelope_fields",
      `author-agent envelope must contain exactly one key "draft", got [${envelopeKeys.join(", ")}]`,
    );
  }

  const draftRaw = envelope.draft;
  if (draftRaw === null || typeof draftRaw !== "object" || Array.isArray(draftRaw)) {
    throw new AuthorDraftExtractionError(
      "missing_fields",
      "author-agent envelope.draft must be a non-array object",
    );
  }
  const draft = draftRaw as Record<string, unknown>;

  // package
  if (draft.package === null || typeof draft.package !== "object" || Array.isArray(draft.package)) {
    throw new AuthorDraftExtractionError("missing_fields", "draft.package must be a non-array object");
  }
  const pkg = draft.package as Record<string, unknown>;
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    throw new AuthorDraftExtractionError("missing_fields", "draft.package.name must be a non-empty string");
  }
  if (!isValidPackageName(pkg.name)) {
    throw new AuthorDraftExtractionError(
      "invalid_name_shape",
      `draft.package.name "${pkg.name}" must match @<scope>/<slug>-(agent|skill|skills|connector|artifact) or appear in the vendored allowlist`,
    );
  }
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new AuthorDraftExtractionError("missing_fields", "draft.package.version must be a non-empty string");
  }
  if (typeof pkg.description !== "string" || pkg.description.length === 0) {
    throw new AuthorDraftExtractionError("missing_fields", "draft.package.description must be a non-empty string");
  }
  if (pkg.cinatra === null || typeof pkg.cinatra !== "object" || Array.isArray(pkg.cinatra)) {
    throw new AuthorDraftExtractionError("missing_fields", "draft.package.cinatra must be a non-array object");
  }
  const cinatra = pkg.cinatra as Record<string, unknown>;
  if (typeof cinatra.apiVersion !== "string" || cinatra.apiVersion.length === 0) {
    throw new AuthorDraftExtractionError("missing_fields", "draft.package.cinatra.apiVersion must be a non-empty string");
  }
  if (typeof cinatra.kind !== "string" || !VALID_KINDS.has(cinatra.kind as AuthorDraftKind)) {
    throw new AuthorDraftExtractionError(
      "invalid_kind",
      `draft.package.cinatra.kind "${String(cinatra.kind)}" must be one of agent|skill|connector|artifact`,
    );
  }
  if (typeof pkg.license !== "string" || pkg.license.length === 0) {
    throw new AuthorDraftExtractionError("missing_fields", "draft.package.license must be a non-empty string");
  }

  // oas
  if (draft.oas === null || typeof draft.oas !== "object" || Array.isArray(draft.oas)) {
    throw new AuthorDraftExtractionError("missing_fields", "draft.oas must be a non-array object");
  }

  // skills
  if (!Array.isArray(draft.skills)) {
    throw new AuthorDraftExtractionError("invalid_skills_shape", "draft.skills must be an array");
  }
  const seenRelPaths = new Set<string>();
  const skills: AuthorDraftSkillFile[] = [];
  for (let i = 0; i < draft.skills.length; i++) {
    const entry = draft.skills[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AuthorDraftExtractionError(
        "invalid_skills_shape",
        `draft.skills[${i}] must be a non-array object`,
      );
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.relPath !== "string" || obj.relPath.length === 0) {
      throw new AuthorDraftExtractionError(
        "invalid_skills_shape",
        `draft.skills[${i}].relPath must be a non-empty string`,
      );
    }
    if (!isValidSkillRelPath(obj.relPath)) {
      throw new AuthorDraftExtractionError(
        "invalid_skills_shape",
        `draft.skills[${i}].relPath "${obj.relPath}" must match skills/<slug>/SKILL.md (no absolute paths, no '..', no backslashes)`,
      );
    }
    if (typeof obj.contents !== "string" || obj.contents.length === 0) {
      throw new AuthorDraftExtractionError(
        "invalid_skills_shape",
        `draft.skills[${i}].contents must be a non-empty string`,
      );
    }
    if (seenRelPaths.has(obj.relPath)) {
      throw new AuthorDraftExtractionError(
        "invalid_skills_shape",
        `draft.skills has duplicate relPath "${obj.relPath}"`,
      );
    }
    seenRelPaths.add(obj.relPath);
    skills.push({ relPath: obj.relPath, contents: obj.contents });
  }

  return {
    package: {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      cinatra: {
        apiVersion: cinatra.apiVersion,
        kind: cinatra.kind as AuthorDraftKind,
      },
      license: pkg.license,
    },
    oas: draft.oas as Record<string, unknown>,
    skills,
  };
}

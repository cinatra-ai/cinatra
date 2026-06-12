// Agent UI binding kinds + shared fail-closed validation (cinatra#151 Stage 5).
//
// The SINGLE definition of the neutral renderer/translator KIND vocabulary and
// the validator for the `cinatra.fieldRenderers` / `cinatra.roles` manifest
// metadata. Consumed by:
//   - scripts/extensions/generate-extension-manifest.mjs (build-time: validates
//     every on-disk manifest FAIL-CLOSED before emitting
//     src/lib/generated/agent-bindings.ts — an invalid declaration fails
//     generation and therefore the byte-pinned `--check` CI step; nothing
//     invalid can become exempt generated data);
//   - packages/agents/src/field-renderer-bindings.server.ts (runtime: the
//     installed-package collector applies the SAME validator SKIP-WARN — a
//     hostile/typo'd runtime manifest can never break the host, it is just
//     not registered).
//
// KIND names are deliberately host-neutral (no extension package names): the
// host's component table in packages/agents/src/register-default-renderers.ts
// keys on these names, and a repo test pins set-equality between that table
// and KNOWN_FIELD_RENDERER_KINDS so the two cannot drift.
//
// Dependency-free on purpose (imported by build scripts, TS host code via
// `allowJs`, and tests).

export const KNOWN_FIELD_RENDERER_KINDS = Object.freeze([
  "auditor-review",
  "campaign-recipients-review",
  "context-selector",
  "cta",
  "email-drafts-review",
  "final-list-review",
  "follow-up-cadence",
  "gmail-sender",
  "linkedin-draft-review",
  "list-picker",
  "reviewer-output",
  "scrape-schema-review",
  "send-confirmation",
  "skill-recommend",
  "test-delivery-input",
  "trigger-configure",
  "trigger-confirm",
  "wayflow-setup-form",
  "wordpress-draft-confirm",
]);

export const KNOWN_A2UI_TRANSLATOR_KINDS = Object.freeze([
  "drafts-output",
  "followups-output",
  "recipients-output",
  "send-output",
]);

// Mirrors RENDERER_NAMESPACE_RE in packages/agents/src/field-renderer-registry.ts
// (pinned by a set-equality test there).
export const BINDING_ID_RE = /^@[\w-]+\/[\w-]+:[\w-]+$/;

// Role names: kebab-case, host-neutral (a role is NOT a package name).
export const ROLE_NAME_RE = /^[a-z][a-z0-9-]*$/;

// `params` is public renderer metadata (it crosses a "use server" boundary to
// the client and is registered into the client-side renderer registry). It
// must be a small plain-JSON object and MUST NOT carry secrets.
export const MAX_PARAMS_JSON_BYTES = 2048;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Validate one `cinatra.fieldRenderers` array. Returns
 * `{ entries: [...normalized], errors: [...strings] }`. Callers decide the
 * failure posture (generator: any error -> throw; runtime collector: any
 * error -> skip entry + warn).
 */
export function validateFieldRendererDeclarations(packageName, raw) {
  const errors = [];
  const entries = [];
  if (raw === undefined || raw === null) return { entries, errors };
  if (!Array.isArray(raw)) {
    return { entries, errors: [`${packageName}: cinatra.fieldRenderers must be an array`] };
  }
  raw.forEach((e, i) => {
    const where = `${packageName} cinatra.fieldRenderers[${i}]`;
    if (!isPlainObject(e)) {
      errors.push(`${where}: entry must be an object`);
      return;
    }
    const { id, kind, priority, midRunHitl, a2uiTranslator, params, ...rest } = e;
    const unknownKeys = Object.keys(rest);
    if (unknownKeys.length > 0) {
      errors.push(`${where}: unknown key(s) ${unknownKeys.join(", ")}`);
      return;
    }
    if (typeof id !== "string" || !BINDING_ID_RE.test(id)) {
      errors.push(`${where}: id must match @scope/package:local-id (got ${JSON.stringify(id)})`);
      return;
    }
    if (typeof kind !== "string" || !KNOWN_FIELD_RENDERER_KINDS.includes(kind)) {
      errors.push(`${where}: unknown kind ${JSON.stringify(kind)} (known: ${KNOWN_FIELD_RENDERER_KINDS.join(", ")})`);
      return;
    }
    if (!Number.isInteger(priority) || priority < 1 || priority > 100) {
      errors.push(`${where}: priority must be an integer 1..100 (got ${JSON.stringify(priority)})`);
      return;
    }
    if (midRunHitl !== undefined && typeof midRunHitl !== "boolean") {
      errors.push(`${where}: midRunHitl must be a boolean when present`);
      return;
    }
    if (
      a2uiTranslator !== undefined &&
      !KNOWN_A2UI_TRANSLATOR_KINDS.includes(a2uiTranslator)
    ) {
      errors.push(`${where}: unknown a2uiTranslator ${JSON.stringify(a2uiTranslator)}`);
      return;
    }
    if (params !== undefined) {
      if (!isPlainObject(params)) {
        errors.push(`${where}: params must be a plain object when present`);
        return;
      }
      let serialized;
      try {
        serialized = JSON.stringify(params);
      } catch {
        errors.push(`${where}: params must be JSON-serializable`);
        return;
      }
      if (serialized === undefined || serialized.length > MAX_PARAMS_JSON_BYTES) {
        errors.push(`${where}: params must serialize to <= ${MAX_PARAMS_JSON_BYTES} bytes of JSON`);
        return;
      }
      if (JSON.stringify(JSON.parse(serialized)) !== serialized) {
        errors.push(`${where}: params must round-trip as plain JSON`);
        return;
      }
    }
    entries.push({
      id,
      kind,
      priority,
      ...(midRunHitl === true ? { midRunHitl: true } : {}),
      ...(a2uiTranslator !== undefined ? { a2uiTranslator } : {}),
      ...(params !== undefined ? { params: JSON.parse(JSON.stringify(params)) } : {}),
      declaredBy: packageName,
    });
  });
  return { entries, errors };
}

/**
 * The canonical comparable form for duplicate-divergence checks (the
 * deep-equal contract: kind, priority, midRunHitl, a2uiTranslator, params).
 * ONE definition — the generator's merge and the runtime collector's
 * generated-vs-runtime divergence warning both consume it.
 */
export function comparableFieldRendererBinding(e) {
  return JSON.stringify({
    kind: e.kind,
    priority: e.priority,
    midRunHitl: e.midRunHitl === true,
    a2uiTranslator: e.a2uiTranslator ?? null,
    params: e.params ?? null,
  });
}

/**
 * Merge per-package validated entries with the cross-declaration rules:
 *   - duplicate id with DEEP-EQUAL (kind, priority, midRunHitl,
 *     a2uiTranslator, params) -> dedupe (first declarer recorded);
 *   - duplicate id with ANY divergence -> error naming both declarers.
 * Input: array of entries (each carrying `declaredBy`). Output:
 * `{ merged: [...], errors: [...] }` with `merged` sorted by id for
 * deterministic emission.
 */
export function mergeFieldRendererBindings(allEntries) {
  const errors = [];
  const byId = new Map();
  const comparable = comparableFieldRendererBinding;
  for (const e of allEntries) {
    const prev = byId.get(e.id);
    if (!prev) {
      byId.set(e.id, e);
      continue;
    }
    if (comparable(prev) !== comparable(e)) {
      errors.push(
        `conflicting fieldRenderers declarations for ${e.id}: ` +
          `${prev.declaredBy} vs ${e.declaredBy} disagree on kind/priority/flags/params`,
      );
    }
    // deep-equal duplicate -> keep first declarer
  }
  const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { merged, errors };
}

/**
 * Validate + merge `cinatra.roles` declarations.
 * Input: array of { packageName, roles } (raw). Output:
 * `{ roles: { role -> packageName } (sorted keys), errors }`.
 * A role claimed by two packages is an ERROR (global uniqueness — the
 * fail-loud role resolution depends on a single authority per role).
 */
export function mergeRoleDeclarations(declarations) {
  const errors = [];
  const claims = new Map();
  for (const { packageName, roles } of declarations) {
    if (roles === undefined || roles === null) continue;
    if (!Array.isArray(roles)) {
      errors.push(`${packageName}: cinatra.roles must be an array`);
      continue;
    }
    for (const role of roles) {
      if (typeof role !== "string" || !ROLE_NAME_RE.test(role)) {
        errors.push(`${packageName}: invalid role name ${JSON.stringify(role)}`);
        continue;
      }
      const prev = claims.get(role);
      if (prev && prev !== packageName) {
        errors.push(`role "${role}" claimed by BOTH ${prev} and ${packageName} (roles must have exactly one claimant)`);
        continue;
      }
      claims.set(role, packageName);
    }
  }
  const roles = Object.fromEntries(
    [...claims.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  return { roles, errors };
}

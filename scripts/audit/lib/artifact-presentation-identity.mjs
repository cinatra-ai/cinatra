// Artifact-UI boundary — presentation-identity DETECTION library (G1).
//
// The pure, AST-based detector behind the G1 type-identity gate
// (scripts/audit/artifact-ui-boundary-gate.mjs). It answers ONE question for a
// core source file: "does this file KEY a decision on a concrete
// extension-owned presentation identity for type-specific presentation?" — the
// epic #1620 / issue #1624 violation predicate. Core must treat identity as an
// opaque input to generic dispatch; every match here is a site that (today)
// couples core to a concrete type / representation / view identity and is
// therefore either a MIGRATE arm (moves into the claimant extension in an
// S4/S7/S8/S9 wave), a DEFER arm (a deferred family — markdown/mermaid), or a
// STAY disposition (legitimately core-owned, allowlisted with a rationale).
//
// The detector is deterministic and PURE (node builtins + the `typescript`
// compiler API only — no project .ts toolchain, no DB, no network), so the gate
// can seed a shrink-only baseline from it and re-derive "live findings" on every
// run. It is exported node-by-node with stable FINGERPRINTS so a baseline entry
// maps 1:1 to a live finding regardless of unrelated edits above it.
//
// WHAT COUNTS (the predicate, narrowed to be truthful):
//   1. The string value is a concrete PRESENTATION IDENTITY — a curated
//      vocabulary drawn from the epic's migration inventory:
//        - representation forms: the inline-preview MIME allowlist + the viewer
//          selection MIMEs, and the `image/` `video/` `audio/` prefix tokens;
//        - chat renderable-view viewTypes (M4);
//        - object/artifact TYPE ids of the shape `@scope/name:local` (M2) — only
//          in a presentational (.tsx) module, so materializers / stores /
//          registration keyed on the SAME id for non-presentation reasons are
//          NOT swept in (they render nothing);
//        - HITL field-renderer binding ids passed explicitly by the caller.
//   2. It appears in a KEYING context — an equality/inequality comparison, a
//      `switch` case, an argument to `.startsWith/.endsWith/.includes/.has/.get/
//      .match`, an element-access key, or an object-literal KEY (a
//      identity→renderer map). A literal used as a VALUE (a schema descriptor
//      `{ viewType: "x" }`, a `z.literal("x")` discriminant) is NOT a keying
//      site — core defining a shape is not core dispatching on identity.
//
// Fixtures / tests / generated maps are excluded by the gate's walker, not here.

import { createHash } from "node:crypto";

/**
 * The curated presentation-identity vocabulary, seeded from the epic #1620
 * migration inventory (grounded against the live host-side arms). Extending this
 * set widens what the gate SEES; it never on its own changes the baseline (a
 * newly-seen site is an `unknown` finding the ratchet fails on until it is
 * dispositioned). Exact MIME forms mirror
 * `src/lib/artifacts/artifact-read.ts` PREVIEW_INLINE_MIME_ALLOWLIST + the
 * viewer selection set; the prefixes mirror `pick-handler.ts`.
 */
export const REPRESENTATION_MIME_EXACT = new Set([
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
  "audio/aac",
]);

/** Representation PREFIX tokens used by the viewer selection (`pick-handler.ts`
 * `mime.startsWith("image/")` …). A `.startsWith`/`.match` arg equal to one of
 * these is representation-keying; an exact-equality arm on the bare prefix also
 * counts. */
export const REPRESENTATION_MIME_PREFIXES = new Set(["image/", "video/", "audio/"]);

/** Chat renderable-view viewTypes (M4). The dispatch keys the registry
 * (`packages/chat/src/renderable-views/registry.tsx`) maps to a card component,
 * plus the deferred `mermaid` family. Schema DEFINITIONS of these strings (as
 * values / z.literal discriminants) are not keying and are not swept. */
export const RENDERABLE_VIEW_TYPES = new Set([
  "content_change_proposal",
  "artifact_preview",
  "citation_group",
  "change_history",
  "chart",
  "mermaid",
]);

/** The DISTINCTIVE renderable-view types safe to match as UNQUOTED object-literal
 * identifier keys — the chat renderable-view registry
 * (`packages/chat/src/renderable-views/registry.tsx`) maps these snake_case
 * viewTypes to a card component with identifier keys, not string keys. Excludes
 * the short common words `chart`/`mermaid` (those would collide with incidental
 * config keys — they are matched only as STRING literals in a keying context). */
export const RENDERABLE_VIEW_TYPES_IDENTIFIER = new Set([
  "content_change_proposal",
  "artifact_preview",
  "citation_group",
  "change_history",
]);

/** HITL field-renderer binding ids (M3) that appear as CORE literals (most
 * bindings are extension-owned DATA delivered through the generated
 * agent-bindings map, so this set is usually small or empty — a binding with no
 * core literal simply has no G1 arm). Seeded by the gate; empty by default. */
export const DEFAULT_HITL_BINDING_IDS = new Set([]);

/** Object/artifact type-id shape `@scope/name:local` (M2). Matched only in a
 * presentational (.tsx) module (see `isPresentationalModule`). */
export const OBJECT_TYPE_ID_RE = /^@[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]*:[a-z0-9][a-z0-9.:-]*$/i;

/** Method names whose string argument is an identity LOOKUP (a keying context)
 * when the receiver is a MIME/type/view value. `set`/`push`/`log` are NOT here —
 * writing a value is not dispatching on identity. */
export const KEYING_METHODS = new Set([
  "startsWith",
  "endsWith",
  "includes",
  "has",
  "get",
  "match",
]);

export const IDENTITY_CLASS = Object.freeze({
  REPRESENTATION: "representation",
  VIEW_TYPE: "view-type",
  OBJECT_TYPE: "object-type",
  HITL_BINDING: "hitl-binding",
});

/** A `.tsx` module renders JSX and is therefore a presentation surface; the
 * object-type-id class is confined to these so a `.ts` materializer / store /
 * registration keyed on the same id (which renders nothing) is not swept. */
export function isPresentationalModule(relPath) {
  return /\.tsx$/.test(relPath);
}

/**
 * The artifact RENDERING + PREVIEW-SERVING surface — the narrow, declared set of
 * modules where an ARRAY of representation MIMEs is a presentation ALLOWLIST (the
 * inline-preview allowlist, a viewer selection table), NOT a non-presentation
 * capability list. Representation-MIME array-element sweeping is confined here so
 * a reshape of an existing arm from `mime === "application/pdf"` to
 * `["application/pdf"].includes(mime)` inside the presentation surface is still
 * caught (closes the array-keying ratchet bypass), while representation arrays in
 * packages/llm (attachment support), packages/a2a (protocol content), and the
 * authoring/template paths — same MIME vocabulary, different purpose — are NOT
 * swept. The direct-keying shapes (equality / switch / method-arg / element-
 * access / object-key) stay GLOBAL across all core packages; only the ambiguous
 * ARRAY shape for representations is surface-scoped. Extend this list when a new
 * rendering / preview-serving module is added.
 */
export const REPRESENTATION_ARRAY_SURFACE_PREFIXES = [
  "src/app/artifacts/", // the detail rendering surface
  "src/app/api/artifacts/", // the preview / content serving routes
  "src/lib/artifacts/artifact-read.ts", // the inline-preview MIME allowlist + disposition
  "src/lib/dashboards/portlet-", // the preview portlet loaders
  "src/components/dashboards/portlets/", // the artifact preview/edit portlets (render type-specific content)
  "src/components/artifacts/", // library glyphs + artifact list/detail presentation
];

export function isRepresentationArraySurface(relPath) {
  return REPRESENTATION_ARRAY_SURFACE_PREFIXES.some((p) => relPath.startsWith(p));
}

/** Classify a string value against the vocabulary. Returns an identity class or
 * null. `bindingIds` lets the gate inject the discovered HITL binding set. */
export function classifyIdentity(value, relPath, bindingIds = DEFAULT_HITL_BINDING_IDS) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (REPRESENTATION_MIME_EXACT.has(value) || REPRESENTATION_MIME_PREFIXES.has(value)) {
    // Representation forms are keyed in `.ts` preview-serving routes as well as
    // `.tsx` viewers, so they are NOT confined to presentational modules.
    return IDENTITY_CLASS.REPRESENTATION;
  }
  if (bindingIds.has(value)) return IDENTITY_CLASS.HITL_BINDING;
  // viewTypes and object-type ids are confined to PRESENTATIONAL (.tsx) modules:
  // the SAME strings appear in the `.ts` wire-schema registry / fixtures / stores
  // / materializers, which render nothing and are not type-specific presentation.
  if (!isPresentationalModule(relPath)) return null;
  if (RENDERABLE_VIEW_TYPES.has(value)) return IDENTITY_CLASS.VIEW_TYPE;
  if (OBJECT_TYPE_ID_RE.test(value)) return IDENTITY_CLASS.OBJECT_TYPE;
  return null;
}

/**
 * Determine the KEYING kind for a string-literal-like node from its parent, or
 * null when the literal is a plain VALUE (not a dispatch key). `ts` is the
 * injected TypeScript namespace so this lib stays a pure helper.
 */
export function keyingKindOf(node, ts) {
  const parent = node.parent;
  if (!parent) return null;

  // `x === "id"` / `x !== "id"` / `==` / `!=`
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    const isEq =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken;
    if (isEq && (parent.left === node || parent.right === node)) return "equality";
    return null;
  }

  // `case "id":`
  if (ts.isCaseClause(parent) && parent.expression === node) return "switch-case";

  // `mime.startsWith("image/")` / `set.has("x")` / `map.get("x")` …
  if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
    const callee = parent.expression;
    if (ts.isPropertyAccessExpression(callee) && KEYING_METHODS.has(callee.name.text)) {
      return "method-arg";
    }
    return null;
  }

  // `obj["id"]`
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
    return "element-access-key";
  }

  // `{ "id": Renderer }` — a string-literal object KEY mapping identity to a
  // renderer/handler. A computed key `{ ["id"]: … }` lands on ComputedPropertyName.
  if (ts.isPropertyAssignment(parent) && parent.name === node) return "object-key";
  if (ts.isComputedPropertyName(parent) && parent.expression === node) return "object-key";

  // An ELEMENT of an array literal: a lookup/allowlist TABLE of presentation
  // identities — `new Set(["text/markdown", …])`, `["application/pdf"].includes(m)`,
  // `new Map([["application/pdf", PdfView]])` (the tuple's key is an inner-array
  // element). Catching this closes the "move a known arm from `===` to an array
  // membership table" shrink-only bypass. (A tuple key is still `array-element`,
  // in the inner array.)
  if (ts.isArrayLiteralExpression(parent) && parent.elements.includes(node)) {
    return "array-element";
  }

  return null;
}

/** Stable per-arm fingerprint — independent of line number so an edit above a
 * finding does not churn the baseline. Ties a live finding 1:1 to a baseline
 * entry by (path, class, identity, keying kind, occurrence-in-file). */
export function fingerprintOf({ path, identityClass, canonicalIdentity, keyingKind, occurrence }) {
  return createHash("sha256")
    .update(`${path} ${identityClass} ${canonicalIdentity} ${keyingKind} ${occurrence}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Detect every presentation-identity keying arm in one source file. Pure:
 * caller supplies the injected `ts` namespace, the repo-relative path, and the
 * source text. Returns findings sorted deterministically, each with a stable
 * fingerprint. `bindingIds` injects the discovered HITL binding vocabulary.
 */
export function detectFindingsInSource(relPath, sourceText, ts, bindingIds = DEFAULT_HITL_BINDING_IDS) {
  const scriptKind = /\.tsx$/.test(relPath)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(relPath)
      ? ts.ScriptKind.JSX
      : /\.mts$/.test(relPath)
        ? ts.ScriptKind.TS
        : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind);

  const raw = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) {
      const value = node.text;
      const identityClass = classifyIdentity(value, relPath, bindingIds);
      if (identityClass) {
        const keyingKind = keyingKindOf(node, ts);
        // An array-element (allowlist/lookup TABLE) counts for the presentation-
        // confined classes (viewType / object-type id, both already `.tsx`-only)
        // anywhere, and for REPRESENTATION MIMEs ONLY inside the artifact
        // rendering / preview-serving surface (isRepresentationArraySurface) —
        // there a MIME array IS a presentation allowlist, and sweeping it closes
        // the "reshape `===` to `[...].includes`" ratchet bypass. Outside that
        // surface a representation-MIME array is a capability / protocol / author
        // list (packages/llm, packages/a2a, authoring) with the SAME vocabulary
        // but a different purpose, so it is NOT swept (would baseline non-
        // presentation code).
        const skip =
          keyingKind === "array-element" &&
          identityClass === IDENTITY_CLASS.REPRESENTATION &&
          !isRepresentationArraySurface(relPath);
        if (keyingKind && !skip) {
          raw.push({ value, identityClass, keyingKind, pos: node.getStart(sf) });
        }
      }
    } else if (
      // UNQUOTED object-literal identifier key that is a distinctive chat
      // renderable-view type — the M4 dispatch registry keys viewType → card
      // component with identifier keys (`content_change_proposal: Card`). A
      // string-literal-only walk would miss the whole M4 arm class. Confined to
      // presentational (.tsx) modules like the string path (the `.ts` schema
      // registry / fixtures key the same names for validation, not rendering).
      ts.isIdentifier(node) &&
      isPresentationalModule(relPath) &&
      node.parent &&
      ts.isPropertyAssignment(node.parent) &&
      node.parent.name === node &&
      RENDERABLE_VIEW_TYPES_IDENTIFIER.has(node.text)
    ) {
      raw.push({
        value: node.text,
        identityClass: IDENTITY_CLASS.VIEW_TYPE,
        keyingKind: "object-key",
        pos: node.getStart(sf),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Assign a per-(identity, class, keyingKind) occurrence index in source order
  // so repeated identical arms in one file each get a unique, stable fingerprint.
  raw.sort((a, b) => a.pos - b.pos);
  const counters = new Map();
  const findings = raw.map((r) => {
    const key = `${r.identityClass} ${r.value} ${r.keyingKind}`;
    const occurrence = counters.get(key) ?? 0;
    counters.set(key, occurrence + 1);
    const line = sf.getLineAndCharacterOfPosition(r.pos).line + 1;
    const finding = {
      ruleId: "artifact-ui/presentation-identity-keying",
      path: relPath,
      canonicalIdentity: r.value,
      identityClass: r.identityClass,
      keyingKind: r.keyingKind,
      occurrence,
      line,
    };
    finding.fingerprint = fingerprintOf(finding);
    return finding;
  });
  return findings;
}

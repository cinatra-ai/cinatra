// Known-destructive floor (cinatra#2020 S5 / design §2.3 / D9).
//
// A PURE, dependency-free predicate over a RESOLVED tool name. It is OR'd into
// the destructive-confirmation TRIGGER at invoker step 3 (PR-3) alongside the
// annotation verdict:
//
//     if ((classifyAnnotations(...) === "destructive" || isKnownDestructiveToolName(name)) && ...)
//
// so a cinatra-known destructive operation still parks for confirmation even
// when the SITE advertises weak or absent annotations (an un-annotated
// `delete-post` must not slip through as write-class).
//
// SCOPE — TRIGGER ONLY (security-spine parity with the annotation classifier,
// annotation-classifier.ts L7): this floor can only ADD confirmation friction.
// It NEVER edits `classifyAnnotations`, never relabels a `tools_list` row's
// `derivedClass`, and never LOOSENS handling. S4 reads the advertised
// `derivedClass` for its injection decisions; the floor is a parallel additive
// sibling that leaves that input untouched (design §2.3 / L8 classifier header).
// A false positive costs the user ONE confirmation — the safe direction.
//
// TWO independent signals, OR'd:
//   1. an EXACT-NAME set — the `core/delete-*`-class WordPress ability ids known
//      to be destructive today (curated, extensible). Belt-and-braces: these are
//      also caught by the verb pattern below, but the explicit set documents the
//      floor and guards against a future narrowing of the pattern; new exact
//      names that do NOT match the pattern can be added here.
//   2. a conservative DESTRUCTIVE-VERB pattern matched at path-segment /
//      underscore / hyphen boundaries (and string ends). The verb set is FIXED
//      (design D9). Boundary matching means `delete-post`, `ewpa/delete_user`
//      and `plugin_uninstall` HIT, while `undelete_marker` / `deleted_flag`
//      (the verb is not a whole boundary-delimited token) do NOT. camelCase is
//      deliberately out of scope — WP ability ids are kebab/snake/slash-cased,
//      and an un-caught camelCase name still parks via annotations or the exact
//      set; a miss here only forgoes an EXTRA confirmation, never loosens one.

/** The fixed destructive-verb set (design D9). NOT site-extensible. */
const DESTRUCTIVE_VERBS = [
  "delete",
  "remove",
  "trash",
  "uninstall",
  "deactivate",
  "reset",
  "drop",
  "purge",
  "erase",
  "destroy",
] as const;

/**
 * A destructive verb appearing as a whole token delimited by a path segment
 * (`/`), underscore (`_`), hyphen (`-`), or a string boundary. The `i` flag
 * makes it case-insensitive. Kept as a single test-only RegExp (never used with
 * `.exec`/global state) so it is safe to reuse across calls.
 */
const DESTRUCTIVE_VERB_PATTERN = new RegExp(
  `(^|[/_-])(${DESTRUCTIVE_VERBS.join("|")})([/_-]|$)`,
  "i",
);

/**
 * The curated exact-name set of known-destructive WordPress ability ids
 * (design §2.3). Lowercased; the predicate lowercases its input before lookup.
 * Extensible — add a new exact id here when it is destructive but its name does
 * not carry a boundary-delimited verb the pattern would catch.
 */
export const KNOWN_DESTRUCTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "core/delete-post",
  "core/delete-page",
  "core/delete-user",
  "core/delete-comment",
  "core/delete-term",
  "core/delete-media",
  "core/delete-revision",
]);

/**
 * Is `name` a cinatra-known destructive tool name? Pure over the resolved tool
 * name only (no catalog, no annotations, no I/O). Returns `false` for a missing
 * or empty name (fail-open here is safe: the annotation verdict is the other,
 * independent OR-arm of the step-3 trigger).
 */
export function isKnownDestructiveToolName(name: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (KNOWN_DESTRUCTIVE_TOOL_NAMES.has(normalized)) return true;
  return DESTRUCTIVE_VERB_PATTERN.test(normalized);
}

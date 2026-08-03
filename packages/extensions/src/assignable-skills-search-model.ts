// ---------------------------------------------------------------------------
// PURE search model for the assignable-skills picker (cinatra#2348 S3, epic
// #2345).
//
// Everything in this module is total, synchronous and I/O-free, so the
// narrowing, ordering and paging semantics the `"use server"` action advertises
// are pinned by unit tests that never touch a database, a filesystem or a
// session. (A `"use server"` module may export only async functions, so this
// has to be a separate module anyway.)
//
// The window/`hasMore` contract deliberately mirrors
// `searchExtensionCoOwnerCandidates` (`permissions-actions.ts`), because the S4
// combobox is the SAME widget with the same paging affordance: a page cap, a
// `limit + 1` over-read, and `hasMore` derived from whether that extra row
// materialized. A picker whose two mounted surfaces disagreed about what
// "one page" means would page inconsistently in the same UI.
// ---------------------------------------------------------------------------

/** Default page size — same as the co-owner candidate search. */
export const ASSIGNABLE_SKILL_PAGE_SIZE = 20;
/** Hard page cap. A caller asking for more is clamped, never obeyed. */
export const ASSIGNABLE_SKILL_MAX_PAGE_SIZE = 50;

/** The lifecycle label a listed row carries. */
export type AssignableSkillInstallStatus = "active" | "locked";

/** ONE picker row — everything S4 renders, with no second fetch. */
export type AssignableSkillRow = {
  /** Catalog skill id (the value an assignment is written with). */
  skillId: string;
  /** The skill's own catalog name. */
  skillName: string;
  /** The skill's catalog description; `""` when it has none. */
  skillDescription: string;
  /** The REAL owning package name. */
  packageName: string;
  /** The owning extension's RESOLVED human title (never empty). */
  displayName: string;
  /** The owning extension's resolved vendor byline, or `null`. */
  vendorName: string | null;
  /** The owning install's current lifecycle status. */
  status: AssignableSkillInstallStatus;
};

/** A clamped, non-negative page window. */
export type AssignableSkillPageWindow = { offset: number; limit: number };

/**
 * Clamp a caller-supplied page window. Fractional, negative, absent, absurd
 * and non-finite values all resolve to something sane — the window is never
 * trusted, exactly as the co-owner search treats it. A NON-FINITE bound
 * (`NaN`, `±Infinity`) reads as UNSPECIFIED rather than as a request for
 * everything: an over-read that large is always a bug or an attack, and the
 * safe reading of "no usable number" is the default page.
 */
export function normalizeAssignableSkillPage(page?: {
  offset?: number;
  limit?: number;
}): AssignableSkillPageWindow {
  const rawLimit = page?.limit;
  const limit = Math.min(
    Math.max(1, Math.floor(Number.isFinite(rawLimit) ? (rawLimit as number) : ASSIGNABLE_SKILL_PAGE_SIZE)),
    ASSIGNABLE_SKILL_MAX_PAGE_SIZE,
  );
  const rawOffset = page?.offset;
  const offset = Math.max(0, Math.floor(Number.isFinite(rawOffset) ? (rawOffset as number) : 0));
  return { offset, limit };
}

/**
 * Normalize a query into a match NEEDLE, or `null` for "match everything".
 *
 * THE ESCAPING QUESTION. The co-owner search builds a SQL `ILIKE` pattern and
 * must therefore escape `\`, `%` and `_` before interpolating the user's text,
 * or the needle stops being literal. This population is a filesystem+catalog
 * join held in memory, so the equivalent guarantee is delivered structurally
 * rather than by escaping: the needle is compared with `String.includes`, never
 * compiled into a `RegExp` and never used as a `LIKE` pattern. `%`, `_`, `\`
 * and every regex metacharacter are therefore already literal — searching for
 * `%` finds rows containing a literal percent sign and nothing else, and no
 * input can widen the match or make it pathological.
 */
export function normalizeAssignableSkillQuery(query: string | null | undefined): string | null {
  if (typeof query !== "string") return null;
  const trimmed = query.trim();
  return trimmed.length > 0 ? trimmed.toLocaleLowerCase() : null;
}

/**
 * Does one row match the query? Case-insensitive literal substring over the
 * four fields the admin can see: the extension title, the skill name, the
 * vendor byline and the package name (typing a scoped npm name is a normal way
 * to find an extension). The DESCRIPTION is deliberately not searched — it is
 * long prose, and matching it would make a two-letter needle return everything.
 *
 * The query is normalized HERE rather than by the caller, so there is no shape
 * of this function that compares a raw needle against a lowercased haystack.
 * A blank query matches every row.
 */
export function assignableSkillRowMatches(
  row: AssignableSkillRow,
  query: string | null | undefined,
): boolean {
  const needle = normalizeAssignableSkillQuery(query);
  if (needle === null) return true;
  const haystacks = [row.displayName, row.skillName, row.packageName, row.vendorName ?? ""];
  return haystacks.some((h) => h.toLocaleLowerCase().includes(needle));
}

/**
 * Stable total order: extension title, then skill name, then skill id.
 *
 * Paging over an unstable order silently drops and duplicates rows across
 * pages, so the tiebreak runs all the way down to the id (which is unique).
 * `localeCompare` is deliberately NOT used — a locale-dependent collation would
 * make the page boundaries depend on the server's locale.
 */
export function compareAssignableSkillRows(a: AssignableSkillRow, b: AssignableSkillRow): number {
  const byExtension = a.displayName.toLocaleLowerCase() < b.displayName.toLocaleLowerCase() ? -1
    : a.displayName.toLocaleLowerCase() > b.displayName.toLocaleLowerCase() ? 1
    : 0;
  if (byExtension !== 0) return byExtension;
  const bySkill = a.skillName.toLocaleLowerCase() < b.skillName.toLocaleLowerCase() ? -1
    : a.skillName.toLocaleLowerCase() > b.skillName.toLocaleLowerCase() ? 1
    : 0;
  if (bySkill !== 0) return bySkill;
  return a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0;
}

/**
 * Narrow → order → page, in that order, ENTIRELY on the server.
 *
 * The `limit + 1` over-read is what makes `hasMore` exact without a second
 * COUNT pass: slice one row past the window, and report whether it existed.
 */
export function selectAssignableSkillPage(
  rows: readonly AssignableSkillRow[],
  query: string | null | undefined,
  page?: { offset?: number; limit?: number },
): { results: AssignableSkillRow[]; hasMore: boolean } {
  const needle = normalizeAssignableSkillQuery(query);
  const narrowed = needle === null ? [...rows] : rows.filter((r) => assignableSkillRowMatches(r, needle));
  // (`needle` is already normalized; `assignableSkillRowMatches` re-normalizing
  // it is idempotent — lowercasing a lowercased, trimmed string is a no-op.)
  narrowed.sort(compareAssignableSkillRows);
  const { offset, limit } = normalizeAssignableSkillPage(page);
  const window = narrowed.slice(offset, offset + limit + 1);
  const hasMore = window.length > limit;
  return { results: hasMore ? window.slice(0, limit) : window, hasMore };
}
